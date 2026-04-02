import { loadSyncBuf, saveSyncBuf } from './sync-buf.js';
import { logger } from '../logger.js';
const SESSION_EXPIRED_ERRCODE = -14;
const SESSION_EXPIRED_PAUSE_MS = 60 * 60 * 1000; // 1 hour
const BACKOFF_THRESHOLD = 3;
const BACKOFF_LONG_MS = 30_000;
const BACKOFF_SHORT_MS = 3_000;
export function createMonitor(api, callbacks) {
    const controller = new AbortController();
    let stopped = false;
    const recentMsgIds = new Set();
    const MAX_MSG_IDS = 1000;
    async function run() {
        let consecutiveFailures = 0;
        while (!controller.signal.aborted) {
            try {
                const buf = loadSyncBuf();
                logger.debug('Polling for messages', { hasBuf: buf.length > 0 });
                const resp = await api.getUpdates(buf || undefined);
                // API may return error as `ret` or `errcode`
                const errCode = resp.ret ?? resp.errcode;
                if (errCode === SESSION_EXPIRED_ERRCODE) {
                    logger.warn('Session expired, pausing for 1 hour');
                    callbacks.onSessionExpired();
                    await sleep(SESSION_EXPIRED_PAUSE_MS, controller.signal);
                    consecutiveFailures = 0;
                    continue;
                }
                if (errCode !== undefined && errCode !== 0) {
                    logger.warn('getUpdates returned error', { errCode, retmsg: resp.retmsg ?? resp.errmsg });
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
                                const toDelete = [];
                                for (let i = 0; i < MAX_MSG_IDS / 2; i++) {
                                    const { value } = iter.next();
                                    if (value !== undefined)
                                        toDelete.push(value);
                                }
                                for (const id of toDelete)
                                    recentMsgIds.delete(id);
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
            }
            catch (err) {
                if (controller.signal.aborted) {
                    break;
                }
                consecutiveFailures++;
                const errorMsg = err instanceof Error ? err.message : String(err);
                logger.error('Monitor error', { error: errorMsg, consecutiveFailures });
                const backoff = consecutiveFailures >= BACKOFF_THRESHOLD ? BACKOFF_LONG_MS : BACKOFF_SHORT_MS;
                logger.info(`Backing off ${backoff}ms`, { consecutiveFailures });
                await sleep(backoff, controller.signal);
            }
        }
        stopped = true;
        logger.info('Monitor stopped');
    }
    function stop() {
        if (!controller.signal.aborted) {
            logger.info('Stopping monitor...');
            controller.abort();
        }
    }
    return { run, stop };
}
function sleep(ms, signal) {
    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve();
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
        }, { once: true });
    });
}
