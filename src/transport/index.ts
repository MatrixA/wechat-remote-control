/**
 * Transport factory + selection.
 *
 * The bridge daemon (src/index.js) calls resolveTransportName() once at startup
 * to decide which IM to talk to, then createTransport(name) to build it. The
 * concrete adapters are dynamically imported so a WeChat-only run never loads
 * Telegram code and vice-versa.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Transport } from './types.js';

export type TransportName = 'wechat' | 'telegram';

const DATA_DIR = process.env.WCC_DATA_DIR || join(homedir(), '.wechat-remote-control');
const TELEGRAM_ACCOUNT = join(DATA_DIR, 'telegram', 'account.json');
const WECHAT_ACCOUNTS_DIR = join(DATA_DIR, 'accounts');

export async function createTransport(name: TransportName): Promise<Transport> {
  if (name === 'telegram') {
    const mod = await import('../telegram/transport.js');
    return mod.createTelegramTransport();
  }
  const mod = await import('../wechat/transport.js');
  return mod.createWeChatTransport();
}

function hasWeChatAccount(): boolean {
  try {
    return readdirSync(WECHAT_ACCOUNTS_DIR).some((f) => f.endsWith('.json'));
  } catch {
    return false;
  }
}

/**
 * Decide the active transport. Priority:
 *   1. WCC_TRANSPORT env var
 *   2. --telegram / --wechat argv flag
 *   3. credentials present on disk (telegram account, else wechat account)
 *   4. default 'wechat'
 */
export function resolveTransportName(argv: string[] = process.argv.slice(2)): TransportName {
  const env = (process.env.WCC_TRANSPORT || '').toLowerCase();
  if (env === 'telegram' || env === 'wechat') return env;

  if (argv.includes('--telegram')) return 'telegram';
  if (argv.includes('--wechat')) return 'wechat';

  // Heuristic: a Telegram account file implies Telegram; otherwise prefer WeChat
  // if a WeChat account exists; fall back to WeChat by default.
  if (existsSync(TELEGRAM_ACCOUNT) && !hasWeChatAccount()) return 'telegram';
  return 'wechat';
}
