/**
 * Telegram long-poll monitor.
 *
 * Mirrors src/wechat/monitor.ts: a getUpdates() loop with backoff, a defensive
 * floor between iterations, and offset persistence. Two Telegram-specific
 * concerns: (1) the update offset is advanced and persisted BEFORE processing so
 * a crash never replays a handled update; (2) the single-chat authorization lock
 * is enforced here — the first chat to message an unbound bot is captured and
 * locked, and every other chat is dropped.
 */
import { TelegramApi } from './api.js';
import { saveOffset, loadOffset, saveAllowedChat, isChatAllowed } from './auth.js';
import type { TelegramAccount } from './auth.js';
import { logger } from '../logger.js';
import type { InboundMessage } from '../transport/types.js';
import type { TgUpdate } from './types.js';

const BACKOFF_THRESHOLD = 3;
const BACKOFF_LONG_MS = 30_000;
const BACKOFF_SHORT_MS = 3_000;
const MIN_POLL_INTERVAL_MS = 1_000;
// Short polling (timeout=0) instead of a 30s long poll. On a flaky/throttled route
// to api.telegram.org a long poll that gets reset mid-flight leaves a server-side
// poll alive for the full timeout, so the next request 409s against the orphan and
// the loop spirals. timeout=0 returns immediately, registers no lingering poll, and
// a failed request recovers within the backoff instead of conflicting.
const LONG_POLL_TIMEOUT_S = 0;

function mediaNoteFor(msg: NonNullable<TgUpdate['message']>): string | null {
  if (msg.voice || msg.audio) return '⚠️ 暂不支持语音消息，请发送文字';
  if (msg.photo) return '⚠️ 暂不支持图片消息，请发送文字';
  if (msg.video || msg.document || msg.sticker) return '⚠️ 暂不支持该类型消息，请发送文字';
  return null;
}

/** Normalise a Telegram Update into the shared inbound shape (pure). */
export function normalizeUpdate(update: TgUpdate): InboundMessage | null {
  const cq = update.callback_query;
  if (cq) {
    const chat = cq.message?.chat;
    if (!chat) return null; // can't route a reply without a chat
    return {
      target: String(chat.id),
      replyToken: cq.id,
      text: '',
      kind: 'callback',
      callbackData: cq.data ?? '',
      userKey: String(cq.from.id),
    };
  }

  const msg = update.message;
  if (!msg) return null;
  const target = String(msg.chat.id);
  const userKey = String(msg.from?.id ?? msg.chat.id);

  if (typeof msg.text === 'string' && msg.text.length > 0) {
    return { target, replyToken: '', text: msg.text, kind: 'text', userKey };
  }

  const note = mediaNoteFor(msg);
  if (note) {
    return { target, replyToken: '', text: '', kind: 'unsupported_media', mediaNote: note, userKey };
  }
  return null; // service message / unhandled
}

/** Username best-effort, for capturing the locked chat. */
function usernameOf(update: TgUpdate): string | undefined {
  return update.message?.from?.username
    ?? update.callback_query?.from?.username
    ?? update.message?.chat?.username;
}

export function createTelegramMonitor(
  api: TelegramApi,
  account: TelegramAccount,
  onMessage: (m: InboundMessage) => void,
) {
  const controller = new AbortController();

  async function run(): Promise<void> {
    let offset = loadOffset();
    let consecutiveFailures = 0;

    while (!controller.signal.aborted) {
      const iterStart = Date.now();
      try {
        const updates = await api.getUpdates({
          offset,
          timeout: LONG_POLL_TIMEOUT_S,
          allowed_updates: ['message', 'callback_query'],
        });

        // Advance + persist the cursor BEFORE processing (crash-safe).
        for (const u of updates) {
          if (u.update_id >= offset) offset = u.update_id + 1;
        }
        if (updates.length > 0) saveOffset(offset);

        for (const u of updates) {
          const inbound = normalizeUpdate(u);
          if (!inbound) continue;

          // ── Single-chat authorization lock ──
          if (!isChatAllowed(account, inbound.target)) {
            logger.warn('Dropping message from unauthorized chat', { chatId: inbound.target });
            continue;
          }
          if (!account.allowedChatId) {
            account.allowedChatId = inbound.target;
            account.allowedUsername = usernameOf(u);
            saveAllowedChat(inbound.target, account.allowedUsername);
            logger.info('Telegram locked to chat', { chatId: inbound.target, username: account.allowedUsername });
          }

          try { onMessage(inbound); }
          catch (err) { logger.error('Error processing Telegram update', { error: err instanceof Error ? err.message : String(err) }); }
        }

        consecutiveFailures = 0;
      } catch (err) {
        if (controller.signal.aborted) break;
        consecutiveFailures++;
        const errMsg = err instanceof Error ? err.message : String(err);
        // 409 = another poller / webhook is set. Back off long, keep retrying.
        const isConflict = errMsg.includes('409');
        logger.error('Telegram monitor error', { error: errMsg, consecutiveFailures, conflict: isConflict });
        const backoff = (isConflict || consecutiveFailures >= BACKOFF_THRESHOLD) ? BACKOFF_LONG_MS : BACKOFF_SHORT_MS;
        await sleep(backoff, controller.signal);
        continue;
      }

      const elapsed = Date.now() - iterStart;
      if (elapsed < MIN_POLL_INTERVAL_MS && !controller.signal.aborted) {
        await sleep(MIN_POLL_INTERVAL_MS - elapsed, controller.signal);
      }
    }
    logger.info('Telegram monitor stopped');
  }

  function stop(): void {
    if (!controller.signal.aborted) controller.abort();
  }

  return { run, stop };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    // Drop the abort listener when the timer wins so completed sleeps don't
    // accumulate dead listeners on the long-lived AbortSignal.
    const onAbort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
