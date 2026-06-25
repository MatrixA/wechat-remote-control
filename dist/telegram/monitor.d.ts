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
import type { TelegramAccount } from './auth.js';
import type { InboundMessage } from '../transport/types.js';
import type { TgUpdate } from './types.js';
/** Normalise a Telegram Update into the shared inbound shape (pure). */
export declare function normalizeUpdate(update: TgUpdate): InboundMessage | null;
export declare function createTelegramMonitor(api: TelegramApi, account: TelegramAccount, onMessage: (m: InboundMessage) => void): {
    run: () => Promise<void>;
    stop: () => void;
};
