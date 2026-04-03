/**
 * wrc-bridge: WeChat Remote Control bridge for Claude Code.
 *
 * Injects WeChat messages into a tmux-hosted CC session via send-keys,
 * watches the CC transcript for assistant responses, and forwards them
 * back to WeChat.  Hook events arrive over a Unix socket from hook.py.
 *
 * Multi-session support:
 *   #ls           — list all discovered CC sessions
 *   #sw <n|name>  — switch active session (resets injection state, replays context)
 */

import net from 'node:net';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, readlinkSync, unlinkSync, appendFileSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname, basename } from 'node:path';

// Reuse compiled dist/ modules for WeChat API
import { WeChatApi } from '../dist/wechat/api.js';
import { loadLatestAccount } from '../dist/wechat/accounts.js';
import { createSender } from '../dist/wechat/send.js';
import { createMonitor } from '../dist/wechat/monitor.js';
import { extractText as extractItemText } from '../dist/wechat/media.js';
import { MessageType } from '../dist/wechat/types.js';
import { logger } from '../dist/logger.js';

// ── Paths ────────────────────────────────────────────────────────────
const HOOK_SOCKET    = '/tmp/cc_wechat_hook.sock';
const CC_WECHAT      = join(homedir(), '.wechat-remote-control');
const STATE_FILE     = join(CC_WECHAT, 'state.json');       // legacy single-session
const SESSIONS_FILE  = join(CC_WECHAT, 'sessions.json');    // multi-session registry
const HISTORY_FILE   = join(CC_WECHAT, 'history.jsonl');
const SESSION_FILE   = join(CC_WECHAT, 'ilink_session.json');
const CLAUDE_PROJECTS = join(homedir(), '.claude', 'projects');
const MAX_MSG_LEN    = 2048;
const INJECT_DELAY   = 500;    // ms to wait after Stop before injecting
const SCAN_INTERVAL  = 30_000; // ms between tmux auto-discovery scans
const CONTEXT_ROUNDS = 3;      // conversation rounds to replay on session switch

// Shell names that should NOT be used as session display names
const SHELL_NAMES = new Set(['bash', 'zsh', 'sh', 'fish', 'dash', 'tcsh', 'csh', 'ksh']);

// ── Mutable state ────────────────────────────────────────────────────
let lastInjectedText = null;
let lastPushedText   = null;
let pendingText      = null;   // queued WeChat text awaiting injection
let injectTimer      = null;
let ccBusy           = false;
let contextToken     = '';     // latest WeChat context_token for pushes
let targetUserId     = '';     // WeChat user to push to
const welcomedUsers  = new Set(); // users already sent a welcome this process run

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
function readState()    { return readJson(STATE_FILE, {}); }
function loadSession()  { return readJson(SESSION_FILE, {}); }
function saveSession(obj) { writeJson(SESSION_FILE, obj); }
function readSessions() { return readJson(SESSIONS_FILE, { active: null, sessions: {} }); }
function writeSessions(data) { writeJson(SESSIONS_FILE, data); }

/**
 * Return the state for the currently active session.
 * Falls back to legacy state.json if sessions registry is empty.
 */
function getActiveState() {
  const reg = readSessions();
  if (reg.active && reg.sessions[reg.active]) {
    const s = reg.sessions[reg.active];
    const [sessionPart, rest] = s.tmux.split(':');
    const [window, pane] = (rest || '0.0').split('.');
    return {
      injectTarget: { session: sessionPart, window: window || '0', pane: pane || '0' },
      transcriptPath: s.transcriptPath,
      autoApprove: true,
    };
  }
  return readState();
}

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
  const safe = text.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '');
  execFileSync('tmux', ['send-keys', '-l', '-t', target, safe]);
  execFileSync('tmux', ['send-keys', '-t', target, 'Enter']);
}

// ── Transcript helpers ───────────────────────────────────────────────
function parseTranscript(filePath) {
  try {
    const lines = readFileSync(filePath, 'utf8').trim().split('\n');
    return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(b => b.type === 'text' && b.text).map(b => b.text).join('');
  }
  return null;
}

function findResponseToInjected(entries, injectedText) {
  if (!injectedText) return null;
  let userIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === 'user') {
      const text = textFromContent(e.message?.content);
      if (text === injectedText) { userIdx = i; break; }
    }
  }
  if (userIdx === -1) return null;

  for (let i = userIdx + 1; i < entries.length; i++) {
    const e = entries[i];
    if (e.type === 'user' && typeof e.message?.content === 'string') break;
    if (e.type === 'assistant' && e.message?.stop_reason === 'end_turn') {
      return textFromContent(e.message.content);
    }
  }

  let lastText = null;
  for (let i = userIdx + 1; i < entries.length; i++) {
    const e = entries[i];
    if (e.type === 'user' && typeof e.message?.content === 'string') break;
    if (e.type === 'assistant') {
      const t = textFromContent(e.message?.content);
      if (t) lastText = t;
    }
  }
  return lastText;
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

// ── Multi-session: discovery ─────────────────────────────────────────

/** Encode a filesystem path to the format CC uses for project dirs. */
function encodeCwd(cwd) {
  return cwd.replace(/[^a-zA-Z0-9-]/g, '-');
}

/** Find the most recently modified .jsonl transcript for a given cwd (fallback). */
function findLatestTranscript(cwd) {
  const projectDir = join(CLAUDE_PROJECTS, encodeCwd(cwd));
  try {
    const files = readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => { const p = join(projectDir, f); return { p, mtime: statSync(p).mtimeMs }; })
      .sort((a, b) => b.mtime - a.mtime);
    return files[0]?.p ?? null;
  } catch { return null; }
}

/**
 * Collect all descendant PIDs of a given PID via /proc (BFS).
 */
function collectDescendants(rootPid) {
  const visited = new Set();
  const queue = [String(rootPid)];
  while (queue.length) {
    const pid = queue.shift();
    if (visited.has(pid)) continue;
    visited.add(pid);
    try {
      const children = execFileSync('pgrep', ['-P', pid], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .trim().split('\n').filter(Boolean);
      for (const c of children) queue.push(c);
    } catch {}
  }
  return visited;
}

/**
 * Return true if a 'claude' process is running in the process tree rooted at panePid.
 */
function hasCCProcess(panePid) {
  try {
    for (const pid of collectDescendants(panePid)) {
      try {
        const comm = readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
        if (comm === 'claude') return true;
      } catch {}
    }
  } catch {}
  return false;
}

/**
 * Find the transcript file actually held open by the CC process running in a
 * given tmux pane.  Walks the process tree rooted at panePid and checks each
 * descendant's open file descriptors via /proc/<pid>/fd.
 * Returns null if nothing is found (e.g. non-Linux, or no CC in that pane).
 */
function findTranscriptByPid(panePid) {
  try {
    for (const pid of collectDescendants(panePid)) {
      const fdDir = `/proc/${pid}/fd`;
      try {
        for (const fd of readdirSync(fdDir)) {
          try {
            const target = readlinkSync(join(fdDir, fd));
            if (target.endsWith('.jsonl') && target.startsWith(CLAUDE_PROJECTS)) {
              return target;
            }
          } catch {}
        }
      } catch {}
    }
  } catch {}
  return null;
}

/** Read the last custom-title entry from a transcript (CC /rename result). */
function readCustomTitle(transcriptPath) {
  if (!transcriptPath) return null;
  try {
    const lines = readFileSync(transcriptPath, 'utf8').trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        if (obj.type === 'custom-title' && obj.customTitle) return obj.customTitle;
      } catch {}
    }
  } catch {}
  return null;
}

/**
 * Determine the display name for a session.
 * Priority: CC /rename title > tmux window name (if not a shell/tmux-internal) > cwd basename
 */
function getSessionDisplayName(cwd, windowName, transcriptPath) {
  const customTitle = readCustomTitle(transcriptPath);
  if (customTitle) return customTitle;
  // Reject shell names and tmux-internal bracketed names like [tmux], [copy], etc.
  const isBracketed = windowName && /^\[.*\]$/.test(windowName);
  if (windowName && !SHELL_NAMES.has(windowName.toLowerCase()) && !isBracketed) return windowName;
  return basename(cwd) || cwd;
}

/**
 * Scan all tmux panes for active CC sessions and update the registry.
 * A pane is considered a CC session if its cwd has a corresponding
 * ~/.claude/projects/<encoded>/*.jsonl file.
 */
function scanTmuxForCC() {
  try {
    const output = execFileSync('tmux', [
      'list-panes', '-a',
      '-F', '#{session_name}:#{window_index}.#{pane_index}|#{window_name}|#{pane_current_path}|#{pane_pid}',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

    const reg = readSessions();
    const now = Date.now();
    const activeTmuxTargets = new Set();

    for (const line of output.trim().split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split('|');
      if (parts.length < 4) continue;
      const [tmuxStr, windowName, cwd, panePid] = parts;
      if (!cwd) continue;

      // Only register panes where a 'claude' process is actually running.
      // Use open-fd scan first (precise, works when CC is active); fall back to
      // latest-modified transcript only when CC is confirmed present but idle.
      if (!hasCCProcess(panePid)) continue;
      const transcriptPath = findTranscriptByPid(panePid) || findLatestTranscript(cwd);
      if (!transcriptPath) continue;

      activeTmuxTargets.add(tmuxStr);

      // Already registered — refresh transcript path and lastSeen
      const existing = Object.entries(reg.sessions).find(([, s]) => s.tmux === tmuxStr);
      if (existing) {
        reg.sessions[existing[0]].lastSeen = now;
        reg.sessions[existing[0]].transcriptPath = transcriptPath;
        // Refresh name in case user renamed after initial registration
        const newName = getSessionDisplayName(cwd, windowName, transcriptPath);
        if (newName !== existing[0] && !reg.sessions[newName]) {
          reg.sessions[newName] = { ...reg.sessions[existing[0]], lastSeen: now };
          if (reg.active === existing[0]) reg.active = newName;
          delete reg.sessions[existing[0]];
        }
        continue;
      }

      // New session — derive name and add
      const baseName = getSessionDisplayName(cwd, windowName, transcriptPath);
      let name = baseName;
      let suffix = 2;
      while (reg.sessions[name]) name = `${baseName}-${suffix++}`;

      reg.sessions[name] = { tmux: tmuxStr, cwd, transcriptPath, lastSeen: now };
      logger.info(`Auto-discovered CC session: ${name} [${tmuxStr}]`);
    }

    // Prune sessions not seen in 2 scan intervals
    for (const [name, s] of Object.entries(reg.sessions)) {
      if (!activeTmuxTargets.has(s.tmux) && now - (s.lastSeen || 0) > SCAN_INTERVAL * 2) {
        logger.info(`Removing stale session: ${name}`);
        if (reg.active === name) reg.active = null;
        delete reg.sessions[name];
      }
    }

    // Pick a default active session if none set.
    // Prefer the session matching state.json's tmux target (set by /attach).
    if (!reg.active || !reg.sessions[reg.active]) {
      const state = readState();
      const stateTarget = tmuxTarget(state);
      const stateTranscript = state.transcriptPath;
      let preferred = null;
      for (const [name, s] of Object.entries(reg.sessions)) {
        if ((stateTarget && s.tmux === stateTarget) ||
            (stateTranscript && s.transcriptPath === stateTranscript)) {
          preferred = name; break;
        }
      }
      const chosen = preferred || Object.keys(reg.sessions)[0];
      if (chosen) { reg.active = chosen; logger.info(`Active session defaulted to: ${chosen}`); }
    }

    writeSessions(reg);
  } catch (err) {
    logger.debug('tmux scan error', { error: err.message });
  }
}

// ── Multi-session: WeChat bridge commands ────────────────────────────

function formatSessionList(reg) {
  const names = Object.keys(reg.sessions);
  if (names.length === 0) return '暂无发现活跃的 CC session\n（等待自动扫描，约30秒）';
  const home = homedir();
  const lines = ['📋 CC Sessions:'];
  names.forEach((name, i) => {
    const s = reg.sessions[name];
    const marker = name === reg.active ? '▶' : '○';
    const shortPath = s.cwd.replace(home, '~');
    lines.push(`${marker} ${i + 1}. ${name}  [${s.tmux}]\n   ${shortPath}`);
  });
  lines.push(`\n当前: ${reg.active || '无'}`);
  lines.push('切换: #sw <名字> 或 #sw <序号>');
  return lines.join('\n');
}

/** Extract the last N human↔assistant conversation rounds from a transcript. */
function getContextReplay(transcriptPath, rounds = CONTEXT_ROUNDS) {
  const entries = parseTranscript(transcriptPath);
  const pairs = [];
  let i = entries.length - 1;

  while (i >= 0 && pairs.length < rounds) {
    while (i >= 0 && entries[i].type !== 'assistant') i--;
    if (i < 0) break;
    const assistantText = textFromContent(entries[i].message?.content);
    i--;
    while (i >= 0 && entries[i].type !== 'user') i--;
    const userText = i >= 0 ? textFromContent(entries[i].message?.content) : null;
    if (i >= 0) i--;
    if (assistantText) pairs.unshift({ user: userText, assistant: assistantText });
  }

  if (pairs.length === 0) return '（暂无对话记录）';
  const lines = [`📜 最近 ${pairs.length} 轮对话:`];
  for (const { user, assistant } of pairs) {
    if (user) lines.push(`\n👤 ${user.slice(0, 150)}`);
    lines.push(`🤖 ${assistant.slice(0, 400)}`);
  }
  return lines.join('\n');
}

async function handleBridgeCommand(text, sender) {
  const send = (msg) => sender.sendText(targetUserId, contextToken, msg)
    .catch(err => logger.error('Bridge command reply failed', { error: err.message }));

  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();

  // #ls / #sessions — list all sessions
  if (cmd === '#ls' || cmd === '#sessions') {
    const reg = readSessions();
    await send(formatSessionList(reg));
    return;
  }

  // #sw <name|number> — switch active session
  if (cmd === '#sw') {
    const arg = parts.slice(1).join(' ').trim();
    if (!arg) { await send('用法: #sw <session名> 或 #sw <序号>'); return; }

    const reg = readSessions();
    const names = Object.keys(reg.sessions);
    let targetName = null;

    const num = parseInt(arg, 10);
    if (!isNaN(num) && num >= 1 && num <= names.length) {
      targetName = names[num - 1];
    } else {
      targetName = names.find(n => n.toLowerCase() === arg.toLowerCase())
        ?? names.find(n => n.toLowerCase().includes(arg.toLowerCase()));
    }

    if (!targetName) {
      await send(`找不到 session: "${arg}"\n\n${formatSessionList(reg)}`);
      return;
    }
    if (targetName === reg.active) {
      await send(`已经在 ${targetName} 了`);
      return;
    }

    reg.active = targetName;
    writeSessions(reg);

    // Reset injection state for the new session
    lastInjectedText = null;
    lastPushedText = null;
    saveSession({ targetUserId, lastInjectedText: null });

    const s = reg.sessions[targetName];
    const replay = getContextReplay(s.transcriptPath);
    const switchMsg = `✅ 已切换到: ${targetName} [${s.tmux}]\n\n${replay}`;
    for (const chunk of splitMessage(switchMsg)) await send(chunk);

    logger.info(`Switched active session to: ${targetName}`);
    return;
  }

  await send(`未知指令: ${text}\n可用:\n  #ls — 列出 sessions\n  #sw <名字/序号> — 切换`);
}

// ── Injection state machine ──────────────────────────────────────────
function cancelPending() {
  if (injectTimer) { clearTimeout(injectTimer); injectTimer = null; }
}

function scheduleInject() {
  cancelPending();
  if (!pendingText) return;
  injectTimer = setTimeout(() => {
    const state = getActiveState();
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
  const state = getActiveState();
  const tpath = payload.transcript_path || state.transcriptPath;
  if (!tpath) { scheduleInject(); return; }

  if (state.transcriptPath && tpath !== state.transcriptPath) {
    logger.debug('Stop from foreign session, ignoring', { tpath: tpath.slice(-60) });
    return;
  }

  logger.info('Stop hook received', { transcript_path: tpath.slice(-60) });

  const entries = parseTranscript(tpath);
  let responseText = findResponseToInjected(entries, lastInjectedText);

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
      logger.info('Pushed response to WeChat', { chars: responseText.length });
    }
  }

  scheduleInject();
}

function onPreToolUse(payload, sender) {
  ccBusy = true;
  cancelPending();

  const state = getActiveState();
  if (!state.autoApprove) return undefined;

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

  if (msg.includes('waiting for your input') && lastInjectedText) {
    logger.info('Notification: idle + pending lastInjected, re-reading transcript');
    const state = getActiveState();
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
    conn.on('error', () => {});
    const chunks = [];
    conn.on('data', d => chunks.push(d));
    conn.on('end', () => {
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString()); }
      catch { conn.destroy(); return; }

      const hookType = payload._hookType || '';
      let reply;
      try {
        if (hookType === 'stop')              onStop(payload, sender);
        else if (hookType === 'pretooluse')   reply = onPreToolUse(payload, sender);
        else if (hookType === 'notification') onNotification(payload, sender);
        else logger.debug('Unknown hook type', { hookType });
      } catch (err) {
        logger.error('Hook handler error', { hookType, error: err.message });
      }

      try {
        if (reply !== undefined) conn.end(JSON.stringify(reply));
        else conn.destroy();
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

  // Send welcome to first-time users (once per bridge process run)
  if (!welcomedUsers.has(targetUserId)) {
    welcomedUsers.add(targetUserId);
    sender.sendText(targetUserId, contextToken,
      '👋 Claude Code 已连接！\n\n' +
      '可用指令：\n' +
      '  #ls — 列出所有 CC sessions\n' +
      '  #sw <名字/序号> — 切换 session\n\n' +
      '直接发消息即注入当前 CC session，回复将自动转发。'
    ).catch(err => logger.error('Welcome message failed', { error: err.message }));
  }

  // Normalize /ls and /sw to # bridge commands.
  // CC slash commands injected via tmux don't produce transcript entries,
  // so /ls would silently fail on the WeChat side ("Unknown skill" in TUI only).
  let cmdText = text.trim();
  if (/^\/ls\b/i.test(cmdText) || /^\/sessions\b/i.test(cmdText)) {
    cmdText = '#ls';
  } else if (/^\/sw(\s|$)/i.test(cmdText)) {
    cmdText = '#sw' + cmdText.slice(3);
  }

  // Intercept bridge commands (# prefix) — never injected into CC
  if (cmdText.startsWith('#')) {
    handleBridgeCommand(cmdText, sender);
    return;
  }

  // Queue for tmux injection into active CC session
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

  const account = loadLatestAccount();
  if (!account) {
    console.error('No account found. Run login first.');
    process.exit(1);
  }

  const session = loadSession();
  targetUserId     = session.targetUserId || '';
  lastInjectedText = session.lastInjectedText || null;

  const api    = new WeChatApi(account.botToken, account.baseUrl);
  const sender = createSender(api, account.accountId);

  const hookServer = startHookServer(sender);

  // Initial tmux scan then periodic
  scanTmuxForCC();
  setInterval(scanTmuxForCC, SCAN_INTERVAL);

  const state  = getActiveState();
  const target = tmuxTarget(state);
  const reg    = readSessions();
  console.log(`[wrc-bridge] active session: ${reg.active || 'NONE'} → ${target || 'NONE'}`);
  logger.info('Bridge started', { accountId: account.accountId, active: reg.active, target });

  // Send proactive welcome if we know the user from a previous session
  if (targetUserId) {
    welcomedUsers.add(targetUserId); // suppress duplicate on first incoming message
    const reg = readSessions();
    const activeName = reg.active || '(unknown)';
    sender.sendText(targetUserId, contextToken,
      `👋 Claude Code 已重连！\n\n当前 session: ${activeName}\n\n` +
      '可用指令：\n' +
      '  #ls — 列出所有 CC sessions\n' +
      '  #sw <名字/序号> — 切换 session\n\n' +
      '直接发消息即注入当前 CC session，回复将自动转发。'
    ).catch(err => logger.error('Startup welcome failed', { error: err.message }));
    logger.info('Sent startup welcome', { userId: targetUserId });
  }

  const monitor = createMonitor(api, {
    onMessage: async (msg) => { handleWeChatMessage(msg, sender); },
    onSessionExpired: () => {
      logger.warn('WeChat session expired');
      console.error('[wrc-bridge] WeChat session expired — re-login needed');
    },
  });

  console.log('[wrc-bridge] starting WeChat poll loop...');

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
