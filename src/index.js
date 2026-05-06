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
import { MessageType, MessageItemType } from '../dist/wechat/types.js';
import { logger } from '../dist/logger.js';

// ── Paths ────────────────────────────────────────────────────────────
const HOOK_SOCKET    = '/tmp/cc_wechat_hook.sock';
const CC_WECHAT      = join(homedir(), '.wechat-remote-control');
const STATE_FILE     = join(CC_WECHAT, 'state.json');       // legacy single-session
const SESSIONS_FILE  = join(CC_WECHAT, 'sessions.json');    // multi-session registry
const HISTORY_FILE   = join(CC_WECHAT, 'history.jsonl');
const SESSION_FILE   = join(CC_WECHAT, 'ilink_session.json');
// Honour CLAUDE_CONFIG_DIR (undocumented but supported by Claude Code) so users
// who relocate ~/.claude/ via that env var still have their transcripts found.
const CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const CLAUDE_PROJECTS = join(CLAUDE_CONFIG_DIR, 'projects');
const MAX_MSG_LEN    = 2048;
const INJECT_DELAY   = 500;    // ms to wait after Stop before injecting
const SCAN_INTERVAL  = 30_000; // ms between tmux auto-discovery scans
const CONTEXT_ROUNDS = 3;      // conversation rounds to replay on session switch

// Shell names that should NOT be used as session display names
const SHELL_NAMES = new Set(['bash', 'zsh', 'sh', 'fish', 'dash', 'tcsh', 'csh', 'ksh']);

// ── Known interactive commands that produce terminal TUI (not transcript) ───
// These are intercepted at bridge level and handled as text menus in WeChat.
const MODELS = [
  { id: 'claude-opus-4-6',          display: 'Opus 4.6',   short: 'opus'   },
  { id: 'claude-sonnet-4-6',        display: 'Sonnet 4.6', short: 'sonnet' },
  { id: 'claude-haiku-4-5-20251001', display: 'Haiku 4.5', short: 'haiku'  },
];

function resolveModel(input) {
  const s = input.trim().toLowerCase();
  const num = parseInt(s, 10);
  if (!isNaN(num) && num >= 1 && num <= MODELS.length) return MODELS[num - 1];
  return MODELS.find(m =>
    m.short === s || m.id === s || m.id.includes(s) ||
    m.display.toLowerCase().includes(s)
  ) ?? null;
}

// ── Mutable state ────────────────────────────────────────────────────
let lastInjectedText       = null;
let lastInjectedTranscript = null;  // transcript path of the session we injected into
let lastPushedText         = null;
let pendingText            = null;   // queued WeChat text awaiting injection
let pendingSelect          = null;   // { type, expires } — waiting for user to pick from a menu
let pendingQuiz            = null;   // { questions, questionIndex, expires } — AskUserQuestion forwarding
let compactionGraceUntil   = 0;     // ms timestamp — accept any same-project transcript until this time
let injectTimer      = null;
let ccBusy           = false;
let contextToken     = '';     // latest WeChat context_token for pushes
let targetUserId     = '';     // WeChat user to push to
const welcomedUsers  = new Set(); // users already sent a welcome this process run

// ── Typing indicator state ───────────────────────────────────────────
const TYPING_REFRESH_MS  = 10_000;   // WeChat server-side typing timeout ~15s
const TYPING_TICKET_TTL  = 12 * 3600_000; // cache ticket for 12 hours
let typingTicketCache    = null;     // { ticket, userId, fetchedAt }
let typingRefreshTimer   = null;     // setInterval handle
let wechatApi            = null;     // WeChatApi instance, set in main()

// ── Typing indicator helpers ─────────────────────────────────────────
// Learned from wong2/weixin-agent-sdk: getConfig → typing_ticket, then
// sendTyping(status=1) on interval, sendTyping(status=2) to cancel.

async function ensureTypingTicket(api, userId, ctxToken) {
  if (typingTicketCache &&
      typingTicketCache.userId === userId &&
      Date.now() - typingTicketCache.fetchedAt < TYPING_TICKET_TTL) {
    return typingTicketCache.ticket;
  }
  try {
    const resp = await api.getConfig(userId, ctxToken);
    const ticket = resp?.typing_ticket;
    if (ticket) {
      typingTicketCache = { ticket, userId, fetchedAt: Date.now() };
      logger.info('Typing ticket obtained');
      return ticket;
    }
  } catch (err) {
    logger.debug('Failed to get typing ticket', { error: err.message });
  }
  return null;
}

function startTypingIndicator(api, userId) {
  stopTypingIndicator(api, userId);  // clear any existing
  const ticket = typingTicketCache?.ticket;
  if (!ticket) return;
  const send = () => api.sendTyping(userId, ticket, 1).catch(() => {});
  send();  // immediate first call
  typingRefreshTimer = setInterval(send, TYPING_REFRESH_MS);
  logger.info('Typing indicator started');
}

function stopTypingIndicator(api, userId) {
  if (typingRefreshTimer) {
    clearInterval(typingRefreshTimer);
    typingRefreshTimer = null;
  }
  const ticket = typingTicketCache?.ticket;
  if (ticket && userId) {
    api.sendTyping(userId, ticket, 2).catch(() => {});
    logger.info('Typing indicator cancelled');
  }
}

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

function capturePaneContent(target, scrollback = 40) {
  try {
    return execFileSync('tmux', [
      'capture-pane', '-t', target, '-p', '-S', String(-scrollback),
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return ''; }
}

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

/**
 * Extract CC's visible response from tmux pane after an injected message.
 * Fallback for when the transcript has no entry (CLI errors, unknown skills, etc.).
 */
function sendKeys(target, text) {
  const safe = text.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '');
  execFileSync('tmux', ['send-keys', '-l', '-t', target, safe]);
  execFileSync('tmux', ['send-keys', '-t', target, 'Enter']);
}

// ── Quiz (AskUserQuestion) helpers ───────────────────────────────────
/**
 * Send a single tmux key (not literal text).
 * Use key names: 'Down', 'Up', 'Enter', 'Space', etc.
 */
function sendTmuxKey(target, key) {
  execFileSync('tmux', ['send-keys', '-t', target, key]);
}

/**
 * Detect if the CC terminal is showing a compaction/continuation confirmation
 * prompt and auto-confirm it by sending Enter.
 * Returns true if auto-confirmed, false otherwise.
 */
function tryAutoConfirmCompaction(target) {
  const raw = capturePaneContent(target, 30);
  if (!raw) return false;
  const content = stripAnsi(raw);

  // Look for compaction-related keywords in the visible pane content.
  // CC shows messages like "conversation compacted", "context limit",
  // "auto-compact", "summarized", or continuation prompts after compaction.
  // IMPORTANT: Do NOT match "X% until auto-compact" — that's the CC status bar
  // showing how far away compaction is, not an actual compaction event.
  const compactionPattern = /compacted|context.*(limit|window|full|getting long)|auto.?summar|conversation.*summar|approaching.*(limit|context)/i;
  const falsePositivePattern = /until auto.?compact/i;
  if (!compactionPattern.test(content)) return false;
  if (falsePositivePattern.test(content) && !compactionPattern.test(content.replace(/.*until auto.?compact.*/gi, ''))) {
    logger.debug('Ignoring status bar auto-compact text (not actual compaction)');
    return false;
  }

  logger.info('Detected compaction prompt, auto-confirming', { contentSnippet: content.slice(-200) });
  sendTmuxKey(target, 'Enter');
  // Set grace period so the Stop handler accepts the new post-compaction transcript
  compactionGraceUntil = Date.now() + 120_000; // 2 minutes
  lastInjectedTranscript = null;  // will be re-set from the Stop payload
  return true;
}

/**
 * Format an AskUserQuestion question and send it to WeChat as a numbered menu.
 */
function sendQuizToWeChat(question, sender) {
  const lines = [`❓ ${question.question}`];
  question.options.forEach((opt, i) => {
    const desc = opt.description ? ` — ${opt.description}` : '';
    lines.push(`  ${i + 1}. ${opt.label}${desc}`);
  });
  if (question.multiSelect) {
    lines.push(`\n回复序号（可多选，如 "1,3"），或直接输入自定义回答`);
  } else {
    lines.push(`\n回复序号选择，或直接输入自定义回答`);
  }
  sender.sendText(targetUserId, contextToken, lines.join('\n'))
    .catch(err => logger.error('Quiz push failed', { error: err.message }));
}

/**
 * Inject key presses into tmux to answer an AskUserQuestion TUI.
 *
 * CC renders: ❯ Option1 / Option2 / ... / Other
 * First option is pre-selected.  Down to navigate, Enter to select.
 * For "Other": navigate past all options, Enter, type text, Enter.
 * For multiSelect: Space to toggle, Enter to confirm.
 *
 * Returns a human-readable string of what was selected.
 */
function injectQuizAnswer(target, question, input) {
  const options = question.options;
  const trimmed = input.trim();

  // ── Multi-select: parse comma/space-separated numbers ──
  if (question.multiSelect) {
    const nums = trimmed.split(/[,\s]+/)
      .map(s => parseInt(s, 10))
      .filter(n => !isNaN(n) && n >= 1 && n <= options.length);
    if (nums.length > 0) {
      let pos = 0;
      for (const num of [...new Set(nums)].sort((a, b) => a - b)) {
        const idx = num - 1;
        while (pos < idx) { sendTmuxKey(target, 'Down'); pos++; }
        sendTmuxKey(target, 'Space');   // Space to toggle
      }
      sendTmuxKey(target, 'Enter'); // Confirm selection
      return nums.map(n => options[n - 1].label).join(', ');
    }
    // Fall through to single-select logic if no valid numbers
  }

  // ── Single-select: try number ──
  const num = parseInt(trimmed, 10);
  if (!isNaN(num) && num >= 1 && num <= options.length) {
    for (let i = 0; i < num - 1; i++) sendTmuxKey(target, 'Down');
    sendTmuxKey(target, 'Enter');
    return options[num - 1].label;
  }

  // ── Try matching by option label text ──
  const exactIdx = options.findIndex(o => o.label.toLowerCase() === trimmed.toLowerCase());
  if (exactIdx >= 0) {
    for (let i = 0; i < exactIdx; i++) sendTmuxKey(target, 'Down');
    sendTmuxKey(target, 'Enter');
    return options[exactIdx].label;
  }

  // ── No match → select "Other" and type custom text ──
  for (let i = 0; i < options.length; i++) sendTmuxKey(target, 'Down');
  sendTmuxKey(target, 'Enter');
  // Brief wait for the text input field to appear after "Other" is selected
  execFileSync('bash', ['-c', 'sleep 0.5']);
  execFileSync('tmux', ['send-keys', '-l', '-t', target, trimmed]);
  sendTmuxKey(target, 'Enter');
  return `Other: "${trimmed}"`;
}

/**
 * Handle a WeChat reply to a pending quiz.
 */
function handleQuizResponse(text, sender) {
  const q = pendingQuiz.questions[pendingQuiz.questionIndex];
  const send = (msg) => sender.sendText(targetUserId, contextToken, msg)
    .catch(err => logger.error('Quiz reply failed', { error: err.message }));

  const state = getActiveState();
  const target = tmuxTarget(state);
  if (!target || !paneExists(target)) {
    send('❌ tmux 不可用');
    pendingQuiz = null;
    return;
  }

  try {
    const selected = injectQuizAnswer(target, q, text);
    send(`✅ ${selected}`);
    appendHistory({ type: 'quiz_answer', question: q.question, answer: selected });
    logger.info('Quiz answer injected', { question: q.question.slice(0, 60), answer: selected });
  } catch (err) {
    send(`❌ 注入失败: ${err.message}`);
    logger.error('Quiz inject failed', { error: err.message });
  }

  // Advance to next question or clear quiz state
  pendingQuiz.questionIndex++;
  if (pendingQuiz.questionIndex >= pendingQuiz.questions.length) {
    pendingQuiz = null;
  } else {
    // Send next question to WeChat (CC TUI shows next question immediately)
    setTimeout(() => {
      if (pendingQuiz) sendQuizToWeChat(pendingQuiz.questions[pendingQuiz.questionIndex], sender);
    }, 800);
  }
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

/**
 * Find the assistant response to an injected user message in the transcript.
 * Returns { text, complete } where complete=true means the last assistant turn
 * had stop_reason==='end_turn' (natural completion), or null if no response found.
 * When complete=false, CC was likely interrupted mid-agentic-loop (e.g. context
 * overflow / compaction) and the text is only a partial intermediate response.
 */
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

  // Collect all assistant text after the injected message, tracking the last end_turn.
  // In a multi-turn agentic loop, the LAST end_turn entry contains the final response.
  let lastEndTurnText = null;
  let lastText = null;
  for (let i = userIdx + 1; i < entries.length; i++) {
    const e = entries[i];
    if (e.type === 'user' && typeof e.message?.content === 'string') break;
    if (e.type === 'assistant') {
      const t = textFromContent(e.message?.content);
      if (t) lastText = t;
      if (e.message?.stop_reason === 'end_turn' && t) lastEndTurnText = t;
    }
  }

  if (lastEndTurnText) return { text: lastEndTurnText, complete: true };
  if (lastText) return { text: lastText, complete: false };
  return null;
}

/**
 * Post-compaction fallback: find the last complete (end_turn) assistant response
 * in the transcript. Used when the injected text was summarized away by compaction.
 */
function findLastCompleteResponse(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === 'assistant' && e.message?.stop_reason === 'end_turn') {
      const t = textFromContent(e.message.content);
      if (t) return { text: t, complete: true };
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

// ── Multi-session: discovery ─────────────────────────────────────────

/** Encode a filesystem path to the format CC uses for project dirs. */
function encodeCwd(cwd) {
  return cwd.replace(/[^a-zA-Z0-9-]/g, '-');
}

/** Check if two transcript paths are in the same project directory. */
function isSameProjectDir(pathA, pathB) {
  if (!pathA || !pathB) return false;
  return dirname(pathA) === dirname(pathB);
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
 * Get a CC process's start time in epoch ms via /proc/<pid>/stat.
 * Field 22 (starttime) is clock ticks since boot; CLK_TCK=100 on x86_64 Linux.
 */
function getProcessStartTimeMs(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const afterComm = stat.substring(stat.lastIndexOf(')') + 2);
    const fields = afterComm.trim().split(/\s+/);
    const startTicks = parseInt(fields[19], 10);  // field 22 → index 19 after pid+comm removed
    const uptime = parseFloat(readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
    const bootMs = Date.now() - uptime * 1000;
    return bootMs + (startTicks / 100) * 1000;
  } catch { return null; }
}

/**
 * Find the transcript that belongs to a specific CC process by matching
 * the CC process start time to transcript file birthtimes.
 * Avoids the findLatestTranscript pitfall where all sessions sharing a CWD
 * get the most-recently-modified transcript (which belongs to the active session).
 */
function findTranscriptForProcess(panePid, cwd) {
  const projectDir = join(CLAUDE_PROJECTS, encodeCwd(cwd));
  let transcripts;
  try {
    transcripts = readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        const p = join(projectDir, f);
        const s = statSync(p);
        return { path: p, birthtime: s.birthtimeMs, mtime: s.mtimeMs };
      });
  } catch { return findLatestTranscript(cwd); }

  if (transcripts.length <= 1) return transcripts[0]?.path ?? null;

  // Find the CC process PID and its start time
  let ccStartMs = null;
  for (const pid of collectDescendants(panePid)) {
    try {
      if (readFileSync(`/proc/${pid}/comm`, 'utf8').trim() === 'claude') {
        ccStartMs = getProcessStartTimeMs(pid);
        break;
      }
    } catch {}
  }

  if (!ccStartMs) return findLatestTranscript(cwd);

  // Match transcript whose birthtime is closest to the CC process start time
  transcripts.sort((a, b) =>
    Math.abs(a.birthtime - ccStartMs) - Math.abs(b.birthtime - ccStartMs)
  );

  const best = transcripts[0];
  const drift = Math.abs(best.birthtime - ccStartMs);
  // Sanity: only trust if within 15 minutes (CC can take minutes to init
  // and create the transcript file after the process itself starts)
  if (drift < 15 * 60 * 1000) return best.path;

  // Drift too large — fall back
  return findLatestTranscript(cwd);
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
 *
 * @param {boolean} useCustomTitle — Only true when the transcript is known to
 *   belong to THIS session (fd-based scan or previously stored via fd).  When
 *   the transcript was obtained via findLatestTranscript fallback, it may
 *   belong to a different CC session sharing the same CWD, so its custom-title
 *   must NOT be used for naming (it would "steal" the name from the real owner).
 */
function getSessionDisplayName(cwd, windowName, transcriptPath, useCustomTitle = true) {
  if (useCustomTitle && transcriptPath) {
    const customTitle = readCustomTitle(transcriptPath);
    if (customTitle) return customTitle;
  }
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
      if (!hasCCProcess(panePid)) continue;

      // Use open-fd scan first (precise); fall back to process-start-time matching
      // which avoids the findLatestTranscript pitfall where all sessions sharing
      // a CWD get assigned the most-recently-modified .jsonl.
      const fdTranscript = findTranscriptByPid(panePid);
      const fallbackTranscript = fdTranscript ? null : findTranscriptForProcess(panePid, cwd);
      const transcriptPath = fdTranscript || fallbackTranscript;
      if (!transcriptPath) continue;

      activeTmuxTargets.add(tmuxStr);

      // Already registered — refresh transcript path and lastSeen
      const existing = Object.entries(reg.sessions).find(([, s]) => s.tmux === tmuxStr);
      if (existing) {
        reg.sessions[existing[0]].lastSeen = now;
        if (fdTranscript) {
          reg.sessions[existing[0]].transcriptPath = fdTranscript;
        } else {
          // Re-evaluate transcript via process-start-time matching to fix
          // initial misassignment (findLatestTranscript always picks the active
          // session's transcript when multiple sessions share the same CWD).
          const better = findTranscriptForProcess(panePid, cwd);
          if (better && better !== reg.sessions[existing[0]].transcriptPath) {
            logger.info(`Transcript corrected for ${existing[0]}: ...${reg.sessions[existing[0]].transcriptPath?.slice(-40)} → ...${better.slice(-40)}`);
            reg.sessions[existing[0]].transcriptPath = better;
          }
        }
        // Refresh name in case user renamed after initial registration.
        // Use stored transcript for custom-title (it was set via fd previously
        // and is authoritative).  Only read custom-title at all if this session
        // has an fd-based transcript (current or stored).
        const nameTranscript = fdTranscript || reg.sessions[existing[0]].transcriptPath;
        const hasReliableTranscript = !!fdTranscript;
        const newName = getSessionDisplayName(cwd, windowName, nameTranscript, hasReliableTranscript);
        if (newName !== existing[0] && !reg.sessions[newName]) {
          logger.info(`Session renamed: ${existing[0]} → ${newName} [${tmuxStr}]`);
          reg.sessions[newName] = { ...reg.sessions[existing[0]], lastSeen: now };
          if (reg.active === existing[0]) reg.active = newName;
          delete reg.sessions[existing[0]];
        }
        continue;
      }

      // New session — derive name and add.
      // Only use custom-title if transcript was found via fd (belongs to this session).
      // Fallback transcripts may belong to another CC session sharing the same CWD.
      const baseName = getSessionDisplayName(cwd, windowName, transcriptPath, !!fdTranscript);
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
    // IMPORTANT: tmux target match is authoritative (set explicitly by user attach).
    // Transcript match is a weak fallback — unreliable when sessions share a CWD,
    // because findLatestTranscript may assign the same .jsonl to multiple sessions.
    if (!reg.active || !reg.sessions[reg.active]) {
      const state = readState();
      const stateTarget = tmuxTarget(state);
      const stateTranscript = state.transcriptPath;
      let preferred = null;

      // Pass 1: exact tmux target match (authoritative)
      if (stateTarget) {
        for (const [name, s] of Object.entries(reg.sessions)) {
          if (s.tmux === stateTarget) { preferred = name; break; }
        }
      }

      // Pass 2: transcript match (weak fallback, only if no tmux match)
      if (!preferred && stateTranscript) {
        for (const [name, s] of Object.entries(reg.sessions)) {
          if (s.transcriptPath === stateTranscript) { preferred = name; break; }
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

// ── CC built-in slash commands ────────────────────────────────────────
// These are handled by the CC CLI process itself and NEVER produce JSONL transcript
// entries.  If injected via tmux from WeChat, the response only appears in the
// terminal — the Stop hook has nothing to forward.
// We intercept these and either handle natively (/model) or inject + capture pane.
const CC_BUILTIN_SLASH = new Set([
  // Session
  'clear', 'reset', 'new', 'resume', 'continue', 'branch', 'fork', 'rename',
  'exit', 'quit', 'rewind', 'checkpoint',
  // Config
  'config', 'settings', 'model', 'effort', 'theme', 'keybindings', 'color',
  'vim', 'terminal-setup',
  // Project
  'memory', 'init', 'add-dir',
  // Tools
  'mcp', 'plugin', 'hooks', 'agents', 'ide', 'chrome', 'reload-plugins',
  // Permissions
  'permissions', 'allowed-tools', 'security-review',
  // Context
  'context', 'compact', 'copy', 'diff', 'export',
  // Workflow
  'cost', 'usage', 'extra-usage', 'tasks', 'bashes', 'fast', 'plan', 'btw',
  'pr-comments', 'schedule',
  // Account
  'login', 'logout', 'status', 'upgrade', 'passes', 'privacy-settings',
  // Info
  'help', 'skills', 'doctor', 'release-notes', 'feedback', 'bug', 'insights',
  'stats', 'powerup',
  // Integrations
  'install-github-app', 'install-slack-app', 'desktop', 'app', 'mobile', 'ios',
  'android', 'remote-control', 'rc', 'remote-env', 'ultraplan', 'statusline',
  'voice', 'stickers',
]);

// TUI commands that require interactive terminal — warn instead of inject
const CC_TUI_ONLY = new Set([
  'resume', 'continue', 'rewind', 'checkpoint', 'config', 'settings',
  'theme', 'terminal-setup', 'memory', 'mcp', 'plugin', 'hooks', 'agents',
  'permissions', 'allowed-tools', 'context', 'diff', 'export', 'extra-usage',
  'tasks', 'bashes', 'pr-comments', 'schedule', 'privacy-settings',
  'insights', 'stats', 'powerup', 'install-github-app', 'remote-env',
  'ultraplan', 'statusline', 'chrome',
]);

/**
 * Inject a CC built-in slash command, wait, capture tmux pane output, and forward.
 * Used for text-output commands like /cost, /compact, /fast, /help, etc.
 * Does NOT set lastInjectedText — Stop hook ignores these.
 */
async function injectSlashAndCapture(target, command, send) {
  const beforeContent = capturePaneContent(target);
  const beforeLineCount = beforeContent.trimEnd().split('\n').length;

  try {
    sendKeys(target, command);
  } catch (err) {
    await send(`❌ 注入失败: ${err.message}`);
    return;
  }

  logger.info('injectSlashAndCapture: injected', { command, target });

  // Wait for command to execute and produce output
  await new Promise(r => setTimeout(r, 2500));

  const afterContent = capturePaneContent(target, 60);
  const afterLines = afterContent.trimEnd().split('\n');

  // Extract new lines that appeared after the command injection
  // Strategy: find the injected command in afterLines, take everything after it
  const cmdClean = command.trim();
  let cmdIdx = -1;
  for (let i = afterLines.length - 1; i >= 0; i--) {
    const line = stripAnsi(afterLines[i]).trim();
    if (line.includes(cmdClean) || line.endsWith(cmdClean)) {
      cmdIdx = i;
      break;
    }
  }

  let outputLines = [];
  if (cmdIdx >= 0) {
    // Take lines after the command, stop at empty prompt or end
    for (let i = cmdIdx + 1; i < afterLines.length; i++) {
      const clean = stripAnsi(afterLines[i]);
      // Stop at CC prompt-like patterns (bare prompt with cursor)
      if (/^\s*[❯>]\s*$/.test(clean)) break;
      // Stop at the input bar patterns (CC uses box-drawing chars)
      if (/^[╭╰│├]/.test(clean)) break;
      outputLines.push(clean);
    }
  }

  // Clean up and forward
  const output = outputLines
    .map(l => l.trimEnd())
    .join('\n')
    .trim();

  if (output && output.length > 2) {
    const chunks = splitMessage(output);
    for (const chunk of chunks) {
      await send(chunk);
    }
  } else {
    await send(`已执行: ${command}`);
  }

  appendHistory({ type: 'slash_command', command, output: output?.slice(0, 200) });
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
    lastInjectedText       = null;
    lastInjectedTranscript = null;
    lastPushedText = null;
    saveSession({ targetUserId, lastInjectedText: null });

    // Update cc_pid to the CC process in the new session's pane
    // so status.sh reflects the correct active session in each terminal.
    const s = reg.sessions[targetName];
    try {
      const paneLines = execFileSync('tmux', [
        'list-panes', '-a', '-F', '#{session_name}:#{window_index}.#{pane_index}\t#{pane_pid}',
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n');
      const newPanePid = paneLines
        .map(l => l.split('\t'))
        .find(([t]) => t === s.tmux)?.[1];
      if (newPanePid) {
        for (const pid of collectDescendants(newPanePid)) {
          try {
            if (readFileSync(`/proc/${pid}/comm`, 'utf8').trim() === 'claude') {
              writeFileSync(join(CC_WECHAT, 'cc_pid'), String(pid));
              const bridgeData = readJson(join(CC_WECHAT, 'bridge.json'), {});
              bridgeData.ccPid = parseInt(pid);
              writeJson(join(CC_WECHAT, 'bridge.json'), bridgeData);
              logger.info('Updated cc_pid after #sw', { pid, session: targetName });
              break;
            }
          } catch {}
        }
      }
    } catch (err) {
      logger.debug('Failed to update cc_pid after #sw', { error: err.message });
    }

    const replay = getContextReplay(s.transcriptPath);
    const switchMsg = `✅ 已切换到: ${targetName} [${s.tmux}]\n\n${replay}`;
    for (const chunk of splitMessage(switchMsg)) await send(chunk);

    logger.info(`Switched active session to: ${targetName}`);
    return;
  }

  // #model [selection] — text-based model switcher (bypasses TUI)
  if (cmd === '#model') {
    const arg = parts.slice(1).join(' ').trim();

    if (!arg) {
      // Show numbered model list
      const settingsPath = join(CLAUDE_CONFIG_DIR, 'settings.json');
      const settings = readJson(settingsPath, {});
      const current = settings.model || 'claude-sonnet-4-6';
      const lines = ['🤖 选择模型:'];
      MODELS.forEach((m, i) => {
        const marker = m.id === current ? '✅' : '  ';
        lines.push(`${marker}${i + 1}. ${m.display}`);
        lines.push(`     ${m.id}`);
      });
      lines.push('\n回复序号或名称（如 1 或 opus）切换');
      lines.push('5分钟内有效，超时取消');
      pendingSelect = { type: 'model', expires: Date.now() + 5 * 60 * 1000 };
      await send(lines.join('\n'));
      return;
    }

    // Direct selection: #model <name/number> — resolve then inject+capture
    const resolved = resolveModel(arg);
    if (!resolved) {
      const opts = MODELS.map((m, i) => `${i + 1}. ${m.display}`).join('  ');
      await send(`未知模型: "${arg}"\n可选: ${opts}`);
      return;
    }

    pendingSelect = null;
    const state = getActiveState();
    const target = tmuxTarget(state);
    if (!target || !paneExists(target)) {
      await send('❌ tmux 不可用');
      return;
    }
    await injectSlashAndCapture(target, `/model ${resolved.id}`, send);
    return;
  }

  await send(`未知指令: ${text}\n可用:\n  #ls — 列出 sessions\n  #sw <名字/序号> — 切换\n  #model — 切换模型`);
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
      lastInjectedText       = text;
      lastInjectedTranscript = state.transcriptPath || null;
      saveSession({ targetUserId, lastInjectedText, lastInjectedTranscript });
      appendHistory({ type: 'user_wechat', text });
      logger.info('Injected WeChat message', { chars: text.length, transcript: lastInjectedTranscript?.slice(-40) });
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

  // Accept Stop from: (1) the session we injected into, OR (2) the current active session.
  // Check both because the session scanner may temporarily reassign transcriptPath between
  // injection and Stop (flip-flop bug), causing lastInjectedTranscript to be stale.
  const matchesInjected = lastInjectedTranscript && tpath === lastInjectedTranscript;
  const matchesActive   = state.transcriptPath && tpath === state.transcriptPath;
  const hasExpected     = !!(lastInjectedTranscript || state.transcriptPath);
  if (hasExpected && !matchesInjected && !matchesActive) {
    // During compaction grace period, accept any transcript from the same project
    // (CC creates a new .jsonl after compaction, so the path changes).
    if (lastInjectedText && Date.now() < compactionGraceUntil) {
      logger.info('Accepting post-compaction transcript', { tpath: tpath.slice(-40) });
      lastInjectedTranscript = tpath;  // update to new transcript
    } else if (lastInjectedText && isSameProjectDir(tpath, lastInjectedTranscript || state.transcriptPath)) {
      // Same project directory but different transcript file.  The session scanner
      // may have assigned the wrong .jsonl at injection time (multiple transcripts
      // in the same project dir).  The hook's tpath is authoritative (from the CC
      // process itself), so accept it and update.
      logger.info('Stop from same project, accepting transcript switch', { tpath: tpath.slice(-40), was: (lastInjectedTranscript || state.transcriptPath)?.slice(-40) });
      lastInjectedTranscript = tpath;
    } else {
      logger.debug('Stop from foreign session, ignoring', { tpath: tpath.slice(-60), injected: lastInjectedTranscript?.slice(-40), active: state.transcriptPath?.slice(-40) });
      return;
    }
  }
  // If tpath matched the active session but not the injected one, update injected
  // so that subsequent handlers (readPath) use the correct transcript.
  if (!matchesInjected && matchesActive && lastInjectedTranscript) {
    logger.info('Updating lastInjectedTranscript to match active session', { from: lastInjectedTranscript.slice(-40), to: tpath.slice(-40) });
    lastInjectedTranscript = tpath;
  }

  logger.info('Stop hook received', { transcript_path: tpath.slice(-60) });

  const readPath = lastInjectedTranscript || tpath;
  const entries = parseTranscript(readPath);
  let result = findResponseToInjected(entries, lastInjectedText);

  // Post-compaction fallback: injected text was summarized away in the new
  // transcript, so text-based matching fails. Use the last end_turn entry.
  // Guard: skip if it matches the last pushed response (avoids sending stale/duplicate).
  if (!result && lastInjectedText && Date.now() < compactionGraceUntil) {
    result = findLastCompleteResponse(entries);
    if (result) {
      if (lastPushedText && result.text === lastPushedText) {
        logger.info('Post-compaction fallback returned same as lastPushedText, skipping');
        result = null;
      } else {
        logger.info('Found response via post-compaction fallback');
      }
    }
  }

  const responseText = result?.text ?? null;
  const responseComplete = result?.complete ?? false;

  logger.info('Stop', {
    responseLen: responseText?.length ?? 0,
    complete: responseComplete,
    lastInjected: lastInjectedText?.slice(0, 60),
  });

  // ── Path A: Complete response → forward to WeChat
  if (responseText && responseComplete && lastInjectedText) {
    if (wechatApi) stopTypingIndicator(wechatApi, targetUserId);
    lastPushedText         = responseText;
    lastInjectedText       = null;
    lastInjectedTranscript = null;
    saveSession({ targetUserId, lastInjectedText: null, lastInjectedTranscript: null });
    appendHistory({ type: 'assistant', text: responseText.slice(0, 500) });
    for (const chunk of splitMessage(responseText)) {
      sender.sendText(targetUserId, contextToken, chunk).catch(err => {
        logger.error('Push to WeChat failed', { error: err.message });
      });
    }
    logger.info('Pushed response to WeChat', { chars: responseText.length });
    scheduleInject();
    return;
  }

  // ── Path B: Incomplete response (no end_turn) → CC interrupted mid-loop
  //    (e.g. context overflow before compaction). Defer — keep lastInjectedText.
  //    Also schedule a delayed retry: the transcript JSONL may not have been fully
  //    flushed with end_turn yet, or the end_turn Stop may never arrive if the
  //    terminal user interacts before CC becomes idle.
  if (responseText && !responseComplete && lastInjectedText) {
    logger.info('Incomplete response (no end_turn), deferring', {
      partialLen: responseText.length, snippet: responseText.slice(0, 80),
    });
    const target = tmuxTarget(getActiveState());
    if (target) tryAutoConfirmCompaction(target);

    // Delayed retry: re-read transcript after 3s to check for late end_turn flush
    const savedInjectedText = lastInjectedText;
    const savedReadPath = readPath;
    setTimeout(() => {
      if (lastInjectedText !== savedInjectedText) return; // already resolved
      const retryEntries = parseTranscript(savedReadPath);
      const retryResult = findResponseToInjected(retryEntries, savedInjectedText);
      if (retryResult?.text && retryResult.complete) {
        logger.info('Found complete response via deferred retry', { chars: retryResult.text.length });
        if (wechatApi) stopTypingIndicator(wechatApi, targetUserId);
        lastPushedText         = retryResult.text;
        lastInjectedText       = null;
        lastInjectedTranscript = null;
        saveSession({ targetUserId, lastInjectedText: null, lastInjectedTranscript: null });
        appendHistory({ type: 'assistant', text: retryResult.text.slice(0, 500) });
        for (const chunk of splitMessage(retryResult.text)) {
          sender.sendText(targetUserId, contextToken, chunk).catch(err => {
            logger.error('Push to WeChat failed', { error: err.message });
          });
        }
        logger.info('Pushed response to WeChat via deferred retry', { chars: retryResult.text.length });
      }
    }, 3000);

    scheduleInject();
    return;
  }

  // ── Path C: No response found
  if (!responseText && lastInjectedText) {
    // Race condition: the Stop hook may arrive before the transcript is fully
    // flushed.  Retry after a short delay to catch late writes.
    if (!result && lastInjectedText) {
      await new Promise(r => setTimeout(r, 500));
      const retryEntries = parseTranscript(readPath);
      result = findResponseToInjected(retryEntries, lastInjectedText);
      if (result?.text && result.complete) {
        logger.info('Found response after 500ms retry', { chars: result.text.length });
        if (wechatApi) stopTypingIndicator(wechatApi, targetUserId);
        lastPushedText         = result.text;
        lastInjectedText       = null;
        lastInjectedTranscript = null;
        saveSession({ targetUserId, lastInjectedText: null, lastInjectedTranscript: null });
        appendHistory({ type: 'assistant', text: result.text.slice(0, 500) });
        for (const chunk of splitMessage(result.text)) {
          sender.sendText(targetUserId, contextToken, chunk).catch(err => {
            logger.error('Push to WeChat failed', { error: err.message });
          });
        }
        logger.info('Pushed response to WeChat via retry', { chars: result.text.length });
        scheduleInject();
        return;
      }
    }

    // Check if CC is still mid-loop (tool_use) — the last assistant entry has
    // stop_reason === 'tool_use', meaning more responses will follow.  In that
    // case, keep lastInjectedText so the eventual end_turn Stop can forward it.
    const lastAssistantStop = (() => {
      const checkEntries = result ? entries : parseTranscript(readPath);
      for (let i = checkEntries.length - 1; i >= 0; i--) {
        if (checkEntries[i].type === 'assistant' && checkEntries[i].message?.stop_reason) {
          return checkEntries[i].message.stop_reason;
        }
      }
      return null;
    })();

    if (lastAssistantStop === 'tool_use') {
      logger.info('No text yet but CC still in tool_use loop, keeping lastInjectedText');
    } else {
      const target = tmuxTarget(getActiveState());
      if (target && tryAutoConfirmCompaction(target)) {
        logger.info('Auto-confirmed compaction, keeping lastInjectedText');
      } else {
        // Don't clean up immediately. Stop can fire prematurely (e.g. CC is
        // still generating, an interrupt fired, or transcript flush lagged).
        // Give the real response a long window to arrive — only abandon the
        // injected message if nothing matches after the deadline.
        const savedInjectedText = lastInjectedText;
        const savedReadPath = readPath;
        const ORPHAN_GRACE_MS = 5 * 60 * 1000;  // 5 min — well beyond any normal CC turn
        const POLL_INTERVAL_MS = 5_000;
        const deadline = Date.now() + ORPHAN_GRACE_MS;
        logger.info('Stop arrived with no response yet, deferring cleanup', {
          graceMs: ORPHAN_GRACE_MS, lastInjected: savedInjectedText.slice(0, 60),
        });

        const poll = () => {
          // Already resolved by another path → bail out
          if (lastInjectedText !== savedInjectedText) return;
          const retryEntries = parseTranscript(savedReadPath);
          const retryResult = findResponseToInjected(retryEntries, savedInjectedText);
          if (retryResult?.text && retryResult.complete) {
            logger.info('Found complete response via deferred orphan poll', {
              chars: retryResult.text.length,
            });
            if (wechatApi) stopTypingIndicator(wechatApi, targetUserId);
            lastPushedText         = retryResult.text;
            lastInjectedText       = null;
            lastInjectedTranscript = null;
            saveSession({ targetUserId, lastInjectedText: null, lastInjectedTranscript: null });
            appendHistory({ type: 'assistant', text: retryResult.text.slice(0, 500) });
            for (const chunk of splitMessage(retryResult.text)) {
              sender.sendText(targetUserId, contextToken, chunk).catch(err => {
                logger.error('Push to WeChat failed', { error: err.message });
              });
            }
            logger.info('Pushed response to WeChat via deferred orphan poll', {
              chars: retryResult.text.length,
            });
            return;
          }
          if (Date.now() >= deadline) {
            logger.warn('No response found within grace window, cleaning up', {
              lastInjected: savedInjectedText.slice(0, 60), graceMs: ORPHAN_GRACE_MS,
            });
            if (lastInjectedText === savedInjectedText) {
              if (wechatApi) stopTypingIndicator(wechatApi, targetUserId);
              lastInjectedText       = null;
              lastInjectedTranscript = null;
              saveSession({ targetUserId, lastInjectedText: null, lastInjectedTranscript: null });
            }
            return;
          }
          setTimeout(poll, POLL_INTERVAL_MS);
        };
        setTimeout(poll, POLL_INTERVAL_MS);
      }
    }
  }

  scheduleInject();
}

function onPreToolUse(payload, sender) {
  // Only mark CC busy if this is from our tracked session (or no session filter).
  // Foreign CC sessions fire PreToolUse too; if we set ccBusy=true for them but
  // their Stop is filtered out, ccBusy gets stuck forever.
  const tpath = payload.transcript_path;
  const state = getActiveState();
  const matchesInjected = lastInjectedTranscript && tpath === lastInjectedTranscript;
  const matchesActive   = state.transcriptPath && tpath === state.transcriptPath;
  const hasExpected     = !!(lastInjectedTranscript || state.transcriptPath);
  if (tpath && hasExpected && !matchesInjected && !matchesActive) {
    // Check if same project dir — scanner may have assigned wrong transcript
    if (!isSameProjectDir(tpath, lastInjectedTranscript || state.transcriptPath)) {
      // Truly foreign session — don't touch ccBusy
      return undefined;
    }
    // Same project, different transcript — accept (scanner misassignment)
  }

  ccBusy = true;
  cancelPending();

  if (!state.autoApprove) return undefined;

  const toolName  = payload.tool_name || '?';
  const toolInput = payload.tool_input || {};
  let desc = `${toolName}`;
  if (toolName === 'Bash' && toolInput.command) desc = `bash: \`${toolInput.command.slice(0, 120)}\``;
  else if (toolInput.file_path) desc = `${toolName}(${toolInput.file_path})`;

  // ── Quiz support: forward AskUserQuestion to WeChat ──
  // Only intercept quizzes triggered by a WeChat-injected message (lastInjectedText is set).
  // Terminal-initiated quizzes are left to the terminal user.
  if (toolName === 'AskUserQuestion' && lastInjectedText) {
    const questions = toolInput.questions || [];
    if (questions.length > 0) {
      pendingQuiz = {
        questions,
        questionIndex: 0,
        expires: Date.now() + 5 * 60 * 1000, // 5 min timeout
      };
      sendQuizToWeChat(questions[0], sender);
      logger.info('Quiz forwarded to WeChat', { numQuestions: questions.length, q: questions[0].question.slice(0, 80) });
    }
  }

  appendHistory({ type: 'auto_approve', tool: toolName, desc });

  // Emit both the modern (hookSpecificOutput.permissionDecision) and the
  // legacy (decision: 'approve') shapes. Some Claude Code releases honor only
  // one of them — sending both works on every version we've tested without
  // changing semantics.
  return {
    decision: 'approve',
    reason: 'wrc auto-approve',
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'wrc auto-approve',
    },
  };
}

async function onNotification(payload, sender) {
  const msg = payload.message || '';

  if (msg.includes('waiting for your input')) {
    // CC is idle. Two cases:
    // 1. Quiz pending → already forwarded to WeChat, just wait for user reply
    // 2. Compaction prompt → auto-confirm so CC can continue
    // 3. lastInjectedText still set → CC stopped without triggering Stop
    //    (shouldn't happen, but clean up to avoid stuck state)
    if (pendingQuiz) {
      logger.info('Notification: CC waiting for quiz input');
      return;
    }
    const state = getActiveState();
    const target = tmuxTarget(state);
    if (target && tryAutoConfirmCompaction(target)) {
      logger.info('Auto-confirmed compaction via Notification');
      return;
    }
    if (lastInjectedText) {
      // Last-chance: the end_turn Stop hook may have been missed (e.g. CC
      // fired Stop for tool_use, then the end_turn Stop wasn't delivered).
      // Try reading the transcript one more time to find the response.
      // Also try other transcripts in the same project dir in case the scanner
      // assigned the wrong one at injection time.
      const readPath = lastInjectedTranscript || state.transcriptPath;
      let result = null;
      if (readPath) {
        const entries = parseTranscript(readPath);
        result = findResponseToInjected(entries, lastInjectedText);
        // If not found, try other transcripts in the same project dir
        if (!result) {
          try {
            const projDir = dirname(readPath);
            const otherFiles = readdirSync(projDir)
              .filter(f => f.endsWith('.jsonl') && join(projDir, f) !== readPath)
              .map(f => ({ path: join(projDir, f), mtime: statSync(join(projDir, f)).mtimeMs }))
              .sort((a, b) => b.mtime - a.mtime);
            for (const { path: altPath } of otherFiles.slice(0, 3)) {
              const altEntries = parseTranscript(altPath);
              result = findResponseToInjected(altEntries, lastInjectedText);
              if (result?.text) {
                logger.info('Found response in alt transcript during idle cleanup', { altPath: altPath.slice(-40) });
                lastInjectedTranscript = altPath;
                break;
              }
            }
          } catch {}
        }
      }
      if (result?.text) {
          logger.info('Found response in idle cleanup', { chars: result.text.length, complete: result.complete });
          if (wechatApi) stopTypingIndicator(wechatApi, targetUserId);
          lastPushedText         = result.text;
          lastInjectedText       = null;
          lastInjectedTranscript = null;
          saveSession({ targetUserId, lastInjectedText: null, lastInjectedTranscript: null });
          appendHistory({ type: 'assistant', text: result.text.slice(0, 500) });
          for (const chunk of splitMessage(result.text)) {
            sender.sendText(targetUserId, contextToken, chunk).catch(err => {
              logger.error('Push to WeChat failed', { error: err.message });
            });
          }
          logger.info('Pushed response to WeChat via idle cleanup', { chars: result.text.length });
          scheduleInject();
          return;
      }
      logger.warn('CC idle but lastInjectedText still set, cleaning up', {
        lastInjected: lastInjectedText.slice(0, 60),
      });
      if (wechatApi) stopTypingIndicator(wechatApi, targetUserId);
      lastInjectedText       = null;
      lastInjectedTranscript = null;
      saveSession({ targetUserId, lastInjectedText: null, lastInjectedTranscript: null });
    } else {
      logger.info('Notification (logged, not pushed): ' + msg);
    }
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

  // Extract text from all items (includes voice ASR text)
  const textParts = [];
  for (const item of msg.item_list) {
    const t = extractItemText(item);
    if (t) textParts.push(t);
    // Extract voice ASR text if available
    if (item.type === MessageItemType.VOICE) {
      const voiceText = item.voice_item?.text ?? item.voice_item?.voice_text;
      if (voiceText) textParts.push(voiceText);
    }
  }

  // Notify about non-text media (image/file/video without text)
  const hasImage = msg.item_list.some(i => i.type === MessageItemType.IMAGE);
  const hasFile = msg.item_list.some(i => i.type === MessageItemType.FILE);
  const hasVideo = msg.item_list.some(i => i.type === MessageItemType.VIDEO);
  const hasVoiceNoText = msg.item_list.some(i =>
    i.type === MessageItemType.VOICE && !i.voice_item?.text && !i.voice_item?.voice_text
  );

  if (hasImage && textParts.length === 0) {
    sender.sendText(targetUserId, contextToken, '⚠️ 图片消息暂不支持在 bridge 模式下处理，请使用 daemon 模式或发送文字')
      .catch(err => logger.error('Image notice failed', { error: err.message }));
    return;
  }
  if (hasVoiceNoText) {
    sender.sendText(targetUserId, contextToken, '⚠️ 语音无法识别文字，请使用文字消息')
      .catch(err => logger.error('Voice notice failed', { error: err.message }));
    if (textParts.length === 0) return;
  }
  if (hasFile) {
    const fileName = msg.item_list.find(i => i.type === MessageItemType.FILE)?.file_item?.file_name;
    textParts.push(`[收到文件: ${fileName ?? '未知文件'}]`);
  }
  if (hasVideo) {
    textParts.push('[收到视频]');
  }

  const text = textParts.join('\n');
  if (!text) return;

  logger.info('WeChat message', { from: targetUserId, text: text.slice(0, 80) });

  // Send welcome to first-time users (once per bridge process run)
  if (!welcomedUsers.has(targetUserId)) {
    welcomedUsers.add(targetUserId);
    sender.sendText(targetUserId, contextToken,
      '👋 Claude Code 已连接！\n\n' +
      '可用指令：\n' +
      '  #ls — 列出所有 CC sessions\n' +
      '  #sw <名字/序号> — 切换 session\n' +
      '  /model — 切换模型（文字菜单，无需终端交互）\n\n' +
      '直接发消息即注入当前 CC session，回复将自动转发。'
    ).catch(err => logger.error('Welcome message failed', { error: err.message }));
  }

  // Consume a pending interactive selection (e.g. /model menu).
  // If expired or unresolvable, clear state and fall through to normal injection.
  if (pendingSelect) {
    if (Date.now() > pendingSelect.expires) {
      logger.info('pendingSelect expired, clearing');
      pendingSelect = null;
    } else if (pendingSelect.type === 'model') {
      const resolved = resolveModel(text.trim());
      if (resolved) {
        pendingSelect = null;
        const reply = (msg) => sender.sendText(targetUserId, contextToken, msg)
          .catch(err => logger.error('Model select reply failed', { error: err.message }));
        const state = getActiveState();
        const target = tmuxTarget(state);
        if (target && paneExists(target)) {
          injectSlashAndCapture(target, `/model ${resolved.id}`, reply);
        } else {
          reply('❌ tmux 不可用');
        }
        return;
      }
      // Unrecognised input — cancel selection, fall through to normal injection
      pendingSelect = null;
      logger.info('pendingSelect: unrecognised input, cancelled');
    }
  }

  // ── Consume a pending quiz (AskUserQuestion) response ──
  if (pendingQuiz) {
    if (Date.now() > pendingQuiz.expires) {
      logger.info('pendingQuiz expired, clearing');
      pendingQuiz = null;
    } else {
      handleQuizResponse(text, sender);
      return;
    }
  }

  // ── Route slash commands ─────────────────────────────────────────
  // CC built-in commands never produce JSONL transcript entries.
  // We intercept them at bridge level: /model → native handler,
  // TUI-only commands → warn, text-output commands → inject + capture pane.
  // Non-built-in /xxx (skills) pass through to normal tmux injection.
  let cmdText = text.trim();

  // Bridge meta-commands (aliases)
  if (/^\/ls\b/i.test(cmdText) || /^\/sessions\b/i.test(cmdText)) {
    cmdText = '#ls';
  } else if (/^\/sw(\s|$)/i.test(cmdText)) {
    cmdText = '#sw' + cmdText.slice(3);
  } else if (/^\/model(\s|$)/i.test(cmdText)) {
    cmdText = '#model' + cmdText.slice(6);
  }

  // Bridge commands (# prefix) — handled entirely by bridge
  if (cmdText.startsWith('#')) {
    handleBridgeCommand(cmdText, sender);
    return;
  }

  // Detect CC built-in slash commands
  const slashMatch = cmdText.match(/^\/([a-z][\w-]*)/i);
  if (slashMatch) {
    const slashName = slashMatch[1].toLowerCase();

    if (CC_BUILTIN_SLASH.has(slashName)) {
      const sendReply = (msg) => sender.sendText(targetUserId, contextToken, msg)
        .catch(err => logger.error('Slash reply failed', { error: err.message }));
      const state = getActiveState();
      const target = tmuxTarget(state);

      if (!target || !paneExists(target)) {
        sendReply('❌ tmux 不可用');
        return;
      }

      // TUI-only commands: warn user these require terminal interaction
      if (CC_TUI_ONLY.has(slashName)) {
        sendReply(`⚠️ /${slashName} 需要终端交互（方向键选择），无法从微信操作。\n\n可远程使用的命令:\n  /cost /usage /compact /clear /fast /effort /help /doctor /status /model`);
        return;
      }

      // Text-output built-in: inject + capture pane output
      injectSlashAndCapture(target, cmdText, sendReply);
      return;
    }
    // Not a known built-in → probably a skill → inject normally (produces transcript)
  }

  // Regular message or skill — queue for tmux injection
  pendingText = text;

  // Start typing indicator immediately (fire-and-forget, non-blocking)
  if (wechatApi && targetUserId) {
    ensureTypingTicket(wechatApi, targetUserId, contextToken)
      .then(() => startTypingIndicator(wechatApi, targetUserId))
      .catch(() => {});
  }

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
  targetUserId           = session.targetUserId || '';
  lastInjectedText       = session.lastInjectedText || null;
  lastInjectedTranscript = session.lastInjectedTranscript || null;

  const api    = new WeChatApi(account.botToken, account.baseUrl);
  wechatApi    = api;  // expose for typing indicator helpers
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

  // Bridge restart implies fresh credentials — clear any stale session-expired flag.
  try {
    const raw = readState();
    if (raw.sessionExpired) {
      delete raw.sessionExpired;
      delete raw.sessionExpiredAt;
      writeJson(STATE_FILE, raw);
      logger.info('Cleared stale sessionExpired flag from state');
    }
  } catch {}

  // Send proactive welcome if we know the user from a previous session
  if (targetUserId) {
    welcomedUsers.add(targetUserId); // suppress duplicate on first incoming message
    const reg = readSessions();
    const activeName = reg.active || '(unknown)';
    sender.sendText(targetUserId, contextToken,
      `👋 Claude Code 已重连！\n\n当前 session: ${activeName}\n\n` +
      '可用指令：\n' +
      '  #ls — 列出所有 CC sessions\n' +
      '  #sw <名字/序号> — 切换 session\n' +
      '  /model — 切换模型（文字菜单，无需终端交互）\n\n' +
      '直接发消息即注入当前 CC session，回复将自动转发。'
    ).catch(err => logger.error('Startup welcome failed', { error: err.message }));
    logger.info('Sent startup welcome', { userId: targetUserId });
  }

  const monitor = createMonitor(api, {
    onMessage: async (msg) => { handleWeChatMessage(msg, sender); },
    onSessionExpired: () => {
      logger.warn('WeChat session expired');
      console.error('[wrc-bridge] WeChat session expired — re-login needed');
      // Mark state so the status line and any operator can see it.
      try {
        const state = readState();
        if (!state.sessionExpired) {
          state.sessionExpired = true;
          state.sessionExpiredAt = Date.now();
          writeJson(STATE_FILE, state);
        }
      } catch (e) {
        logger.warn('Failed to mark session expired in state', { error: e.message });
      }
      // One-shot tmux notice in the attached pane's status bar.
      try {
        const target = tmuxTarget(getActiveState());
        if (target) {
          execFileSync('tmux', [
            'display-message', '-t', target, '-d', '8000',
            '⚠️  WeChat session expired — run /wechat-remote-control to re-login',
          ], { stdio: 'ignore' });
        }
      } catch {}
    },
  });

  console.log('[wrc-bridge] starting WeChat poll loop...');

  function shutdown() {
    logger.info('Shutting down');
    if (wechatApi && targetUserId) stopTypingIndicator(wechatApi, targetUserId);
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
