/**
 * wrc-bridge: WeChat Remote Control bridge for Claude Code.
 *
 * Injects WeChat messages into a tmux-hosted CC session via send-keys,
 * watches the CC transcript for assistant responses, and forwards them
 * back to WeChat.  Hook events arrive over a Unix socket from hook.py.
 */

import net from 'node:net';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, appendFileSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

// Reuse compiled dist/ modules for WeChat API
import { WeChatApi } from '../dist/wechat/api.js';
import { loadLatestAccount } from '../dist/wechat/accounts.js';
import { createSender } from '../dist/wechat/send.js';
import { createMonitor } from '../dist/wechat/monitor.js';
import { extractText as extractItemText } from '../dist/wechat/media.js';
import { MessageType } from '../dist/wechat/types.js';
import { logger } from '../dist/logger.js';

// ── Paths ────────────────────────────────────────────────────────────
const HOOK_SOCKET  = '/tmp/cc_wechat_hook.sock';
const CC_WECHAT    = join(homedir(), '.cc_wechat');
const STATE_FILE   = join(CC_WECHAT, 'state.json');
const HISTORY_FILE = join(CC_WECHAT, 'history.jsonl');
const SESSION_FILE = join(CC_WECHAT, 'ilink_session.json');
const MAX_MSG_LEN  = 2048;
const INJECT_DELAY = 500;   // ms to wait after Stop before injecting

// ── Mutable state ────────────────────────────────────────────────────
let lastInjectedText = null;
let lastPushedText   = null;
let pendingText      = null;   // queued WeChat text awaiting injection
let injectTimer      = null;
let ccBusy           = false;
let contextToken     = '';     // latest WeChat context_token for pushes
let targetUserId     = '';     // WeChat user to push to

// ── JSON helpers ─────────────────────────────────────────────────────
function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}
function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
  if (process.platform !== 'win32') chmodSync(path, 0o600);
}

// ── State helpers ────────────────────────────────────────────────────
function readState()   { return readJson(STATE_FILE, {}); }
function loadSession() { return readJson(SESSION_FILE, {}); }
function saveSession(obj) { writeJson(SESSION_FILE, obj); }

function appendHistory(entry) {
  mkdirSync(CC_WECHAT, { recursive: true, mode: 0o700 });
  appendFileSync(HISTORY_FILE, JSON.stringify({ ts: Date.now(), ...entry }) + '\n');
  if (process.platform !== 'win32') try { chmodSync(HISTORY_FILE, 0o600); } catch {}
}

// ── Tmux helpers ─────────────────────────────────────────────────────
function tmuxTarget(state) {
  const t = state.injectTarget;
  return t ? `${t.session}:${t.window}.${t.pane}` : null;
}

function paneExists(target) {
  try { execFileSync('tmux', ['has-session', '-t', target.split('.')[0]], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

function sendKeys(target, text) {
  // Strip control characters (except newline) to prevent injection
  const safe = text.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '');
  execFileSync('tmux', ['send-keys', '-l', '-t', target, safe]);
  execFileSync('tmux', ['send-keys', '-t', target, 'Enter']);
}

// ── Transcript parsing ───────────────────────────────────────────────
function parseTranscript(filePath) {
  try {
    const lines = readFileSync(filePath, 'utf8').trim().split('\n');
    return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/** Extract text from message content (handles both string and array formats) */
function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(b => b.type === 'text' && b.text).map(b => b.text).join('');
  }
  return null;
}

/**
 * Find the assistant response to a specific injected user message.
 * Searches backward for the injected text, then returns the assistant
 * response that follows it. This avoids race conditions with transcript writes.
 */
function findResponseToInjected(entries, injectedText) {
  if (!injectedText) return null;
  // Find the last occurrence of the injected text as a user message
  let userIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === 'user') {
      const text = textFromContent(e.message?.content);
      if (text === injectedText) { userIdx = i; break; }
    }
  }
  if (userIdx === -1) return null;
  // Find the first completed assistant response AFTER that user entry
  for (let i = userIdx + 1; i < entries.length; i++) {
    const e = entries[i];
    if (e.type === 'assistant' && e.message?.stop_reason) {
      return textFromContent(e.message.content);
    }
  }
  return null;
}

// ── Message splitting ────────────────────────────────────────────────
function splitMessage(text, maxLen = MAX_MSG_LEN) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let rem = text;
  while (rem.length > 0) {
    if (rem.length <= maxLen) { chunks.push(rem); break; }
    let idx = rem.lastIndexOf('\n', maxLen);
    if (idx < maxLen * 0.3) idx = maxLen;
    chunks.push(rem.slice(0, idx));
    rem = rem.slice(idx).replace(/^\n+/, '');
  }
  return chunks;
}

// ── Injection state machine ──────────────────────────────────────────
function cancelPending() {
  if (injectTimer) { clearTimeout(injectTimer); injectTimer = null; }
}

function scheduleInject() {
  cancelPending();
  if (!pendingText) return;
  injectTimer = setTimeout(() => {
    const state = readState();
    const target = tmuxTarget(state);
    if (!target || !paneExists(target)) {
      logger.warn('Cannot inject: tmux target unavailable', { target });
      return;
    }
    const text = pendingText;
    pendingText = null;
    try {
      sendKeys(target, text);
      lastInjectedText = text;
      saveSession({ targetUserId, lastInjectedText });
      appendHistory({ type: 'user_wechat', text });
      logger.info('Injected WeChat message', { chars: text.length });
    } catch (err) {
      logger.error('tmux inject failed', { error: err.message });
    }
  }, INJECT_DELAY);
}

// ── Hook event handlers ──────────────────────────────────────────────
async function onStop(payload, sender) {
  ccBusy = false;
  const state = readState();
  const tpath = payload.transcript_path || state.transcriptPath;
  if (!tpath) { scheduleInject(); return; }

  // Only process Stop from the target CC session (ignore other sessions' Stop hooks)
  if (state.transcriptPath && tpath !== state.transcriptPath) {
    logger.debug('Stop from foreign session, ignoring', { tpath: tpath.slice(-60) });
    return;  // Don't scheduleInject — this Stop isn't from our target
  }

  logger.info('Stop hook received', { transcript_path: tpath.slice(-60) });

  const entries = parseTranscript(tpath);

  let responseText = findResponseToInjected(entries, lastInjectedText);

  // Retry once after 500ms if response not found yet (transcript write race)
  if (!responseText && lastInjectedText) {
    await new Promise(r => setTimeout(r, 500));
    const entries2 = parseTranscript(tpath);
    responseText = findResponseToInjected(entries2, lastInjectedText);
    if (responseText) logger.info('Found response on retry');
  }

  logger.info('Stop', {
    responseLen: responseText?.length ?? 0,
    lastInjected: lastInjectedText?.slice(0, 60),
  });

  if (responseText && responseText !== lastPushedText) {
    if (lastInjectedText) {
      // Found response to our injected WeChat message — push it
      lastPushedText = responseText;
      lastInjectedText = null;
      saveSession({ targetUserId, lastInjectedText: null });
      const assistantText = responseText;

      appendHistory({ type: 'assistant', text: assistantText.slice(0, 500) });

      const chunks = splitMessage(assistantText);
      for (const chunk of chunks) {
        sender.sendText(targetUserId, contextToken, chunk).catch(err => {
          logger.error('Push to WeChat failed', { error: err.message });
        });
      }
      logger.info('Pushed response to WeChat', { chars: assistantText.length });
    }
  }

  scheduleInject();
}

function onPreToolUse(payload, sender) {
  ccBusy = true;
  cancelPending();

  const state = readState();
  if (!state.autoApprove) return undefined;  // let CC show normal permission dialog

  const toolName  = payload.tool_name || '?';
  const toolInput = payload.tool_input || {};
  let desc = `${toolName}`;
  if (toolName === 'Bash' && toolInput.command) desc = `bash: \`${toolInput.command.slice(0, 120)}\``;
  else if (toolInput.file_path) desc = `${toolName}(${toolInput.file_path})`;

  appendHistory({ type: 'auto_approve', tool: toolName, desc });

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'wrc auto-approve',
    },
  };
}

async function onNotification(payload, sender) {
  const msg = payload.message || '';

  // "waiting for input" = CC is idle. If we still have a pending injected text,
  // the Stop hook may have fired too early (before the final response was written).
  // Re-read the transcript now to catch the response.
  if (msg.includes('waiting for your input') && lastInjectedText) {
    logger.info('Notification: idle + pending lastInjected, re-reading transcript');
    const state = readState();
    const tpath = state.transcriptPath;
    if (tpath) {
      const entries = parseTranscript(tpath);
      const responseText = findResponseToInjected(entries, lastInjectedText);
      if (responseText && responseText !== lastPushedText) {
        lastPushedText = responseText;
        lastInjectedText = null;
        saveSession({ targetUserId, lastInjectedText: null });
        appendHistory({ type: 'assistant', text: responseText.slice(0, 500) });
        const chunks = splitMessage(responseText);
        for (const chunk of chunks) {
          sender.sendText(targetUserId, contextToken, chunk).catch(err => {
            logger.error('Push to WeChat failed', { error: err.message });
          });
        }
        logger.info('Pushed response to WeChat (via notification fallback)', { chars: responseText.length });
      }
    }
    return;
  }

  if (msg.includes('waiting for your input')) {
    logger.info('Notification (logged, not pushed): ' + msg);
    return;
  }
  appendHistory({ type: 'notification', text: msg });
  logger.info('Notification: ' + msg);
}

// ── Hook server (Unix socket) ────────────────────────────────────────
function startHookServer(sender) {
  try { unlinkSync(HOOK_SOCKET); } catch {}

  const server = net.createServer(conn => {
    conn.on('error', () => {});  // swallow EPIPE / ECONNRESET
    const chunks = [];
    conn.on('data', d => chunks.push(d));
    conn.on('end', () => {
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString()); }
      catch { conn.destroy(); return; }

      const hookType = payload._hookType || '';
      let reply;
      try {
        if (hookType === 'stop')           onStop(payload, sender);
        else if (hookType === 'pretooluse') reply = onPreToolUse(payload, sender);
        else if (hookType === 'notification') onNotification(payload, sender);
        else logger.debug('Unknown hook type', { hookType });
      } catch (err) {
        logger.error('Hook handler error', { hookType, error: err.message });
      }

      try {
        if (reply !== undefined) {
          conn.end(JSON.stringify(reply));
        } else {
          conn.destroy();
        }
      } catch { conn.destroy(); }
    });
  });

  server.listen(HOOK_SOCKET, () => {
    if (process.platform !== 'win32') try { chmodSync(HOOK_SOCKET, 0o600); } catch {}
    logger.info('Hook server ready at ' + HOOK_SOCKET);
    console.log('[wrc-bridge] hook server ready at ' + HOOK_SOCKET);
  });
  return server;
}

// ── WeChat message handler ───────────────────────────────────────────
function handleWeChatMessage(msg, sender) {
  if (msg.message_type !== MessageType.USER) return;
  if (!msg.from_user_id || !msg.item_list) return;

  targetUserId = msg.from_user_id;
  contextToken = msg.context_token ?? '';

  const text = msg.item_list.map(extractItemText).filter(Boolean).join('\n');
  if (!text) return;

  logger.info('WeChat message', { from: targetUserId, text: text.slice(0, 80) });

  // Queue for tmux injection
  pendingText = text;
  if (!ccBusy) {
    scheduleInject();
  } else {
    logger.info('CC busy, queued for injection after Stop');
  }
}

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  mkdirSync(CC_WECHAT, { recursive: true });

  // Load account
  const account = loadLatestAccount();
  if (!account) {
    console.error('No account found. Run login first.');
    process.exit(1);
  }

  // Restore persisted session
  const session = loadSession();
  targetUserId     = session.targetUserId || '';
  lastInjectedText = session.lastInjectedText || null;

  // Create API + sender
  const api    = new WeChatApi(account.botToken, account.baseUrl);
  const sender = createSender(api, account.accountId);

  // Start hook server
  const hookServer = startHookServer(sender);

  // Log state
  const state  = readState();
  const target = tmuxTarget(state);
  console.log(`[wrc-bridge] inject target: ${target || 'NONE'}, autoApprove=${state.autoApprove ?? false}`);
  logger.info('Bridge started', { accountId: account.accountId, target, autoApprove: state.autoApprove });

  // Start WeChat poll loop
  const monitor = createMonitor(api, {
    onMessage: async (msg) => { handleWeChatMessage(msg, sender); },
    onSessionExpired: () => {
      logger.warn('WeChat session expired');
      console.error('[wrc-bridge] WeChat session expired — re-login needed');
    },
  });

  console.log('[wrc-bridge] starting WeChat poll loop...');

  // Graceful shutdown
  function shutdown() {
    logger.info('Shutting down');
    monitor.stop();
    hookServer.close();
    cancelPending();
    try { unlinkSync(HOOK_SOCKET); } catch {}
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await monitor.run();
}

main().catch(err => {
  console.error('[wrc-bridge] Fatal:', err);
  logger.error('Fatal', { error: err.message });
  process.exit(1);
});
