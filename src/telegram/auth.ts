/**
 * Telegram credentials + authorization (single-chat lock + bound topics group).
 *
 * Storage lives under <DATA_DIR>/telegram/, parallel to the WeChat accounts dir.
 * A bot token grants control of the user's terminal, so the bridge locks itself
 * to ONE chat: the first chat that messages the bot after login captures the
 * chat id; every other chat is dropped thereafter.
 *
 * Topics mode adds a second allowed chat: a supergroup with Topics enabled that
 * the owner binds with /bind. The owner (the locked private chat's user id) is
 * additionally allowed to speak from any chat — that is what lets the /bind
 * message through before the group is bound.
 */
import { join } from 'node:path';
import { DATA_DIR } from '../constants.js';
import { loadJson, saveJson } from '../store.js';
import { logger } from '../logger.js';

export const TELEGRAM_DIR = join(DATA_DIR, 'telegram');
export const TELEGRAM_ACCOUNT_PATH = join(TELEGRAM_DIR, 'account.json');
const OFFSET_PATH = join(TELEGRAM_DIR, 'offset.json');

export interface TelegramAccount {
  botToken: string;
  botUsername?: string;
  allowedChatId?: string;
  allowedUsername?: string;
  /** Bound topics supergroup (set by /bind in a forum-enabled group). */
  groupChatId?: string;
  groupTitle?: string;
  createdAt: string;
}

export function loadTelegramAccount(): TelegramAccount | null {
  return loadJson<TelegramAccount | null>(TELEGRAM_ACCOUNT_PATH, null);
}

export function saveTelegramAccount(account: TelegramAccount): void {
  saveJson(TELEGRAM_ACCOUNT_PATH, account);
  logger.info('Telegram account saved', {
    username: account.botUsername,
    locked: !!account.allowedChatId,
    group: !!account.groupChatId,
  });
}

/** Persist (or update) the authorized chat once it is known. */
export function saveAllowedChat(chatId: string, username?: string): TelegramAccount | null {
  const account = loadTelegramAccount();
  if (!account) return null;
  account.allowedChatId = chatId;
  account.allowedUsername = username;
  saveTelegramAccount(account);
  return account;
}

/** Persist the bound topics group. */
export function saveBoundGroup(chatId: string, title?: string): TelegramAccount | null {
  const account = loadTelegramAccount();
  if (!account) return null;
  account.groupChatId = chatId;
  account.groupTitle = title;
  saveTelegramAccount(account);
  return account;
}

/**
 * Authorization decision (pure). If no chat is bound yet, any chat is allowed
 * (the monitor will capture+lock it). Once bound: the locked private chat, the
 * bound topics group, and — from any chat — the owner themself (their user id
 * equals the locked private chat id) are allowed. The owner exception is what
 * lets a /bind reach the bridge from a not-yet-bound group.
 */
export function isChatAllowed(account: TelegramAccount, chatId: string, fromUserId?: string): boolean {
  if (!account.allowedChatId) return true;
  if (account.allowedChatId === chatId) return true;
  if (account.groupChatId && account.groupChatId === chatId) return true;
  if (fromUserId && fromUserId === account.allowedChatId) return true;
  return false;
}

// ── Long-poll offset cursor ──
export function loadOffset(): number {
  return loadJson<{ offset: number }>(OFFSET_PATH, { offset: 0 }).offset || 0;
}
export function saveOffset(offset: number): void {
  saveJson(OFFSET_PATH, { offset });
}
