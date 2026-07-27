/**
 * Interactive terminal login for either transport.
 *
 * Driven by `bin/wrc login`. SKILL.md's login flow does the same thing the long way
 * round: because the agent cannot block on stdin, it launches a detached QR process
 * and polls two files in /tmp to relay progress through the chat. A terminal can just
 * await, so this is a straight loop over the same underlying functions — no temp
 * files, no background process.
 *
 * Usage:  node bin/login.mjs [--telegram | --wechat]
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { startQrLogin, waitForQrScan } from '../dist/wechat/login.js';
import { renderTerminalQr } from '../dist/wechat/qrcode.js';
import { loadLatestAccount } from '../dist/wechat/accounts.js';
import { verifyToken, captureAuthorizedChat } from '../dist/telegram/login.js';
import { loadTelegramAccount } from '../dist/telegram/auth.js';

const MAX_QR_ATTEMPTS = 5;
const CAPTURE_TIMEOUT_MS = 180_000;

const rl = createInterface({ input: stdin, output: stdout });
const ask = (q) => rl.question(q);

async function confirm(question, dflt = true) {
  const answer = (await ask(`${question} ${dflt ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase();
  if (!answer) return dflt;
  return answer === 'y' || answer === 'yes';
}

async function loginWeChat() {
  const existing = loadLatestAccount();
  if (existing && !(await confirm(`已登录微信账号 ${existing.accountId}，重新登录？`, false))) {
    console.log('保持现有登录，未做改动。');
    return;
  }

  // The QR lives ~60s. Rather than make the user restart, request a fresh one each
  // time the old one expires — same retry budget as the skill's background loop.
  for (let attempt = 1; attempt <= MAX_QR_ATTEMPTS; attempt++) {
    const { qrcodeUrl, qrcodeId } = await startQrLogin();
    try {
      console.log(renderTerminalQr(qrcodeUrl));
    } catch {
      // A terminal that cannot render the matrix still gets a scannable URL.
      console.log(`（二维码渲染失败，用微信打开这个链接）\n${qrcodeUrl}`);
    }
    console.log(`用微信扫码并确认（第 ${attempt}/${MAX_QR_ATTEMPTS} 张，约 60 秒后自动换新）…`);

    try {
      const account = await waitForQrScan(qrcodeId);
      console.log(`\n登录成功  accountId=${account.accountId}`);
      return;
    } catch (err) {
      if (!String(err.message).includes('expired')) throw err;
      console.log('二维码已过期，换一张…\n');
    }
  }
  throw new Error(`二维码连换 ${MAX_QR_ATTEMPTS} 次都没扫上，稍后再试`);
}

async function loginTelegram() {
  const existing = loadTelegramAccount();
  if (existing?.botToken && !(await confirm(`已登录 Telegram bot @${existing.botUsername ?? '?'}，重新登录？`, false))) {
    console.log('保持现有登录，未做改动。');
    return;
  }

  console.log('在 Telegram 里找 @BotFather → /newbot，把它给你的 token 贴进来。');
  const token = (await ask('Bot token: ')).trim();
  if (!token) throw new Error('没有输入 token');

  const { username } = await verifyToken(token);
  console.log(`token 有效  bot=@${username}`);
  console.log(`\n现在打开 https://t.me/${username} 给它发一条 /start —— 第一个说话的会话会被锁定为唯一授权会话。`);
  console.log(`等待中（最多 ${CAPTURE_TIMEOUT_MS / 1000} 秒）…`);

  const { chatId, username: who } = await captureAuthorizedChat(token, { timeoutMs: CAPTURE_TIMEOUT_MS });
  console.log(`\n登录成功  chatId=${chatId}${who ? ` (@${who})` : ''}`);
  console.log('想要「一个会话一个话题」的多会话体验：建一个开启「话题」的超级群，把 bot 拉进去并给管理员权限，在群里发 /bind。');
}

async function main() {
  const argv = process.argv.slice(2);
  let transport = argv.includes('--telegram') ? 'telegram' : argv.includes('--wechat') ? 'wechat' : null;

  if (!transport) {
    // No flag: go where the credentials already are; ask only when it is genuinely ambiguous.
    const hasWeChat = !!loadLatestAccount();
    const hasTelegram = !!loadTelegramAccount()?.botToken;
    if (hasWeChat && !hasTelegram) transport = 'wechat';
    else if (hasTelegram && !hasWeChat) transport = 'telegram';
    else {
      const answer = (await ask('登录哪个？ [t]elegram / [w]echat: ')).trim().toLowerCase();
      transport = answer.startsWith('t') ? 'telegram' : answer.startsWith('w') ? 'wechat' : null;
      if (!transport) throw new Error('没选，退出');
    }
  }

  if (transport === 'telegram') await loginTelegram();
  else await loginWeChat();
}

try {
  await main();
} catch (err) {
  console.error(`\n登录失败: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  rl.close();
}
