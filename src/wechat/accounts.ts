import { join } from 'node:path';
import { homedir } from 'node:os';
import { readdirSync, statSync } from 'node:fs';
import { loadJson, saveJson } from '../store.js';
import { logger } from '../logger.js';

export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';

export interface AccountData {
  botToken: string;
  accountId: string;
  baseUrl: string;
  userId: string;
  createdAt: string;
  /**
   * Single-user lock. A WeChat bot token grants control of the owner's terminal
   * (every injected message is auto-approved), so — exactly like the Telegram
   * transport's chat lock — the bridge binds to ONE sender: the first
   * from_user_id seen after login is captured here and every other sender is
   * dropped thereafter. Undefined until the first message is captured.
   */
  allowedUserId?: string;
}

const ACCOUNTS_DIR = join(homedir(), '.wechat-remote-control', 'accounts');

/** Reject accountIds containing path traversal or unexpected characters. */
function validateAccountId(accountId: string): void {
  if (!/^[a-zA-Z0-9_.@=-]+$/.test(accountId)) {
    throw new Error(`Invalid accountId: "${accountId}"`);
  }
}

function accountPath(accountId: string): string {
  validateAccountId(accountId);
  return join(ACCOUNTS_DIR, `${accountId}.json`);
}

/** Persist account credentials to disk. */
export function saveAccount(data: AccountData): void {
  const filePath = accountPath(data.accountId);
  saveJson(filePath, data);
  logger.info('Account saved', { accountId: data.accountId });
}

/** Load account credentials by ID. Returns null if not found. */
export function loadAccount(accountId: string): AccountData | null {
  const filePath = accountPath(accountId);
  const data = loadJson<AccountData | null>(filePath, null);
  if (data) {
    logger.info('Account loaded', { accountId });
  }
  return data;
}

/**
 * Authorization decision (pure), mirroring telegram/auth.ts `isChatAllowed`.
 * If no user is bound yet, any sender is allowed (the transport captures+locks
 * the first one). Once bound, only that user is allowed.
 */
export function isWeChatUserAllowed(account: AccountData, userId: string): boolean {
  if (!account.allowedUserId) return true;
  return account.allowedUserId === userId;
}

/** Load the most recently modified account. Returns null if none exist. */
export function loadLatestAccount(): AccountData | null {
  try {
    const files = readdirSync(ACCOUNTS_DIR).filter((f) => f.endsWith('.json'));
    if (files.length === 0) return null;

    let latestFile = files[0];
    let latestMtime = 0;

    for (const file of files) {
      const stat = statSync(join(ACCOUNTS_DIR, file));
      if (stat.mtimeMs > latestMtime) {
        latestMtime = stat.mtimeMs;
        latestFile = file;
      }
    }

    const accountId = latestFile.replace(/\.json$/, '');
    return loadAccount(accountId);
  } catch {
    // Directory does not exist or is unreadable
    return null;
  }
}
