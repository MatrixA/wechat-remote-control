/**
 * Telegram long-poll monitor.
 *
 * Mirrors src/wechat/monitor.ts: a getUpdates() loop with backoff, a defensive
 * floor between iterations, and offset persistence. Two Telegram-specific
 * concerns: (1) the update offset is advanced and persisted BEFORE processing so
 * a crash never replays a handled update; (2) the chat authorization lock is
 * enforced here — the first chat to message an unbound bot is captured and
 * locked; thereafter only that chat, the bound topics group, and the owner
 * themself pass (see auth.isChatAllowed).
 *
 * Forum topics: a message inside a topic carries message_thread_id +
 * is_topic_message; its reply target is encoded as "<chatId>:<threadId>" so the
 * bridge can route by topic without ever parsing the target itself.
 */
import { TelegramApi } from './api.js';
import type { TelegramAccount } from './auth.js';
import type { InboundMessage } from '../transport/types.js';
import type { TgUpdate } from './types.js';
/** Normalise a Telegram Update into the shared inbound shape (pure). */
export declare function normalizeUpdate(update: TgUpdate): InboundMessage | null;
export declare function createTelegramMonitor(api: TelegramApi, account: TelegramAccount, onMessage: (m: InboundMessage) => void): {
    run: () => Promise<void>;
    stop: () => void;
};
