/**
 * Telegram credentials + authorization (single-chat lock).
 *
 * Storage lives under <DATA_DIR>/telegram/, parallel to the WeChat accounts dir.
 * A bot token grants control of the user's terminal, so the bridge locks itself
 * to ONE chat: the first chat that messages the bot after login captures the
 * chat id; every other chat is dropped thereafter.
 */
import { join } from 'node:path';
import { DATA_DIR } from '../constants.js';
import { loadJson, saveJson } from '../store.js';
import { logger } from '../logger.js';
export const TELEGRAM_DIR = join(DATA_DIR, 'telegram');
export const TELEGRAM_ACCOUNT_PATH = join(TELEGRAM_DIR, 'account.json');
const OFFSET_PATH = join(TELEGRAM_DIR, 'offset.json');
export function loadTelegramAccount() {
    return loadJson(TELEGRAM_ACCOUNT_PATH, null);
}
export function saveTelegramAccount(account) {
    saveJson(TELEGRAM_ACCOUNT_PATH, account);
    logger.info('Telegram account saved', { username: account.botUsername, locked: !!account.allowedChatId });
}
/** Persist (or update) the authorized chat once it is known. */
export function saveAllowedChat(chatId, username) {
    const account = loadTelegramAccount();
    if (!account)
        return null;
    account.allowedChatId = chatId;
    account.allowedUsername = username;
    saveTelegramAccount(account);
    return account;
}
/**
 * Authorization decision (pure). If no chat is bound yet, any chat is allowed
 * (the monitor will capture+lock it). Once bound, only that chat is allowed.
 */
export function isChatAllowed(account, chatId) {
    if (!account.allowedChatId)
        return true;
    return account.allowedChatId === chatId;
}
// ── Long-poll offset cursor ──
export function loadOffset() {
    return loadJson(OFFSET_PATH, { offset: 0 }).offset || 0;
}
export function saveOffset(offset) {
    saveJson(OFFSET_PATH, { offset });
}
