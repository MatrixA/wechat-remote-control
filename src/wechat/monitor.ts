import { WeChatApi } from './api.js';
import { loadSyncBuf, saveSyncBuf } from './sync-buf.js';
import { logger } from '../logger.js';
import type { WeixinMessage } from './types.js';

const SESSION_EXPIRED_ERRCODE = -14;
const SESSION_EXPIRED_PAUSE_MS = 60 * 60 * 1000; // 1 hour
const BACKOFF_THRESHOLD = 3;
const BACKOFF_LONG_MS = 30_000;
const BACKOFF_SHORT_MS = 3_000;
// Defensive minimum gap between poll iterations. The server's long-poll normally
// holds the connection for ~35s, so this only kicks in when the server returns
// instantly (e.g. transient errors, short-circuits). Prevents runaway tight loops.
const MIN_POLL_INTERVAL_MS = 1_000;

export interface MonitorCallbacks {
  onMessage: (msg: WeixinMessage) => Promise<void>;
  onSessionExpired: () => void;
}

export function createMonitor(api: WeChatApi, callbacks: MonitorCallbacks) {
  const controller = new AbortController();
  let stopped = false;
  const recentMsgIds = new Set<number>();
  const MAX_MSG_IDS = 1000;

  async function run(): Promise<void> {
    let consecutiveFailures = 0;

    while (!controller.signal.aborted) {
      const iterStart = Date.now();
      try {
        const buf = loadSyncBuf();
        logger.debug('Polling for messages', { hasBuf: buf.length > 0 });

        const resp = await api.getUpdates(buf || undefined);

        // The server uses two field-name conventions: `ret`/`retmsg` for the
        // legacy long-poll path and `errcode`/`errmsg` for the gateway path.
        // Treat them interchangeably so session-expired (-14) is always caught.
        const errCode = resp.ret ?? resp.errcode;
        const errMsg = resp.retmsg ?? resp.errmsg;

        if (errCode === SESSION_EXPIRED_ERRCODE) {
          logger.warn('Session expired, pausing for 1 hour');
          callbacks.onSessionExpired();
          await sleep(SESSION_EXPIRED_PAUSE_MS, controller.signal);
          consecutiveFailures = 0;
          continue;
        }

        if (errCode !== undefined && errCode !== 0) {
          logger.warn('getUpdates returned error', { errCode, errMsg });
        }

        // Save the new sync buffer regardless of ret
        if (resp.get_updates_buf) {
          saveSyncBuf(resp.get_updates_buf);
        }

        // Process messages (with deduplication)
        const messages = resp.msgs ?? [];
        if (messages.length > 0) {
          logger.info('Received messages', { count: messages.length });
          for (const msg of messages) {
            // Skip already-processed messages
            if (msg.message_id && recentMsgIds.has(msg.message_id)) {
              continue;
            }
            if (msg.message_id) {
              recentMsgIds.add(msg.message_id);
              if (recentMsgIds.size > MAX_MSG_IDS) {
                // Evict oldest half (Set iterates in insertion order)
                const iter = recentMsgIds.values();
                const toDelete: number[] = [];
                for (let i = 0; i < MAX_MSG_IDS / 2; i++) {
                  const { value } = iter.next();
                  if (value !== undefined) toDelete.push(value);
                }
                for (const id of toDelete) recentMsgIds.delete(id);
              }
            }
            // Fire-and-forget: don't block the polling loop on message processing
            // This allows permission responses (y/n) to be received while a query is running
            callbacks.onMessage(msg).catch((err) => {
              const msg2 = err instanceof Error ? err.message : String(err);
              logger.error('Error processing message', { error: msg2, messageId: msg.message_id });
            });
          }
        }

        consecutiveFailures = 0;
      } catch (err) {
        if (controller.signal.aborted) {
          break;
        }

        consecutiveFailures++;
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error('Monitor error', { error: errorMsg, consecutiveFailures });

        const backoff = consecutiveFailures >= BACKOFF_THRESHOLD ? BACKOFF_LONG_MS : BACKOFF_SHORT_MS;
        logger.info(`Backing off ${backoff}ms`, { consecutiveFailures });
        await sleep(backoff, controller.signal);
        continue;
      }

      // Defensive floor: if the iteration returned in well under the long-poll
      // budget (e.g. a soft error returned 200/instant), still wait a moment
      // before the next poll so we never hammer the API in a tight loop.
      const elapsed = Date.now() - iterStart;
      if (elapsed < MIN_POLL_INTERVAL_MS && !controller.signal.aborted) {
        await sleep(MIN_POLL_INTERVAL_MS - elapsed, controller.signal);
      }
    }

    stopped = true;
    logger.info('Monitor stopped');
  }

  function stop(): void {
    if (!controller.signal.aborted) {
      logger.info('Stopping monitor...');
      controller.abort();
    }
  }

  return { run, stop };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }

    // Remove the abort listener when the timer wins, otherwise each completed
    // sleep leaves a dead listener on the long-lived AbortSignal forever.
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
