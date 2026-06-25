/**
 * Telegram login: verify a BotFather token and capture the authorized chat.
 *
 * Unlike WeChat's QR scan, a Telegram bot authenticates with a token created via
 * @BotFather. After the token is verified, the user opens the bot in Telegram and
 * sends /start; the first chat to message the bot is captured and locked as the
 * sole authorized chat (see auth.ts).
 *
 * These functions are invoked from SKILL.md's login flow (node --input-type=module).
 */
import { TelegramApi } from './api.js';
import {
  loadTelegramAccount, saveTelegramAccount, saveAllowedChat, saveOffset, loadOffset,
} from './auth.js';
import { logger } from '../logger.js';

export interface VerifyResult {
  username?: string;
}

/** Confirm the token with getMe and persist it (preserving any prior chat lock). */
export async function verifyToken(token: string): Promise<VerifyResult> {
  const api = new TelegramApi(token);
  const me = await api.getMe(); // throws on 401 / invalid token
  const existing = loadTelegramAccount();
  saveTelegramAccount({
    botToken: token,
    botUsername: me.username,
    allowedChatId: existing?.allowedChatId,
    allowedUsername: existing?.allowedUsername,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  });
  logger.info('Telegram token verified', { username: me.username });
  return { username: me.username };
}

export interface CaptureResult {
  chatId: string;
  username?: string;
}

/**
 * Poll getUpdates until the user messages the bot, then lock that chat.
 * Throws after timeoutMs if no message arrives.
 */
export async function captureAuthorizedChat(
  token: string,
  opts: { timeoutMs?: number } = {},
): Promise<CaptureResult> {
  const api = new TelegramApi(token);
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const deadline = Date.now() + timeoutMs;
  let offset = loadOffset();

  // Drain any backlog first so we lock onto a FRESH message (the user's /start),
  // not a stale queued one (e.g. a message sent while creating the bot). A
  // timeout:0 poll returns immediately with whatever is pending; advance past it.
  try {
    const backlog = await api.getUpdates({ offset, timeout: 0 });
    for (const u of backlog) { if (u.update_id >= offset) offset = u.update_id + 1; }
    if (backlog.length > 0) saveOffset(offset);
  } catch { /* ignore — fall through to the wait loop */ }

  while (Date.now() < deadline) {
    const remaining = Math.max(1, Math.min(25, Math.ceil((deadline - Date.now()) / 1000)));
    let updates;
    try {
      updates = await api.getUpdates({ offset, timeout: remaining, allowed_updates: ['message'] });
    } catch (err) {
      logger.warn('captureAuthorizedChat getUpdates failed', { error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    for (const u of updates) {
      if (u.update_id >= offset) offset = u.update_id + 1;
      const chat = u.message?.chat;
      if (chat) {
        saveOffset(offset);
        const chatId = String(chat.id);
        const username = u.message?.from?.username ?? chat.username;
        saveAllowedChat(chatId, username);
        logger.info('Telegram authorized chat captured', { chatId, username });
        return { chatId, username };
      }
    }
    if (updates.length > 0) saveOffset(offset);
  }
  throw new Error('timeout: no message received from the user');
}
