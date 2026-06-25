/**
 * wrc-bridge: Remote Control bridge for Claude Code / Codex.
 *
 * Injects messages from an IM (WeChat or Telegram) into a tmux-hosted agent
 * session via send-keys, watches the agent transcript for assistant responses,
 * and forwards them back to the IM. The IM is abstracted behind the Transport
 * interface (src/transport/), so the core deals only in an opaque reply target.
 * Hook events arrive over a Unix socket from hook.py.
 *
 * Multi-session support:
 *   #ls            — list all discovered CC sessions
 *   #sw <n|name>   — switch active session (resets injection state, replays context)
 *   #rename <name> — rename the active session (tmux window + registry, pinned)
 */

import net from 'node:net';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, readlinkSync, unlinkSync, appendFileSync, chmodSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname, basename } from 'node:path';

// Pluggable IM transport (WeChat / Telegram). The core never references a
// specific IM — it talks to the Transport interface and an opaque reply target.
import { createTransport, resolveTransportName } from '../dist/transport/index.js';
import { logger, redact } from '../dist/logger.js';
import {
  splitMessage,
  textFromContent,
  findResponseToInjected,
  findLastCompleteResponse,
  transcriptHasUserText,
} from '../dist/message.js';
import {
  getAgent, sessionKind, resolveModelFor,
  CODEX_SESSIONS, findCodexTranscriptByPid, findLatestCodexRollout,
} from './agents.js';

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
// Codex CLI rollout transcripts live under <CODEX_HOME>/sessions/ (CODEX_SESSIONS
// is resolved env-aware in agents.js and re-used here for transcript discovery).
const INJECT_DELAY   = 500;    // ms to wait after Stop before injecting
const SCAN_INTERVAL  = 30_000; // ms between tmux auto-discovery scans
const CONTEXT_ROUNDS = 3;      // conversation rounds to replay on session switch

// Auto-approve every tool by default (the bridge exists to drive the agent
// hands-free). Set WRC_AUTO_APPROVE=0 (or false) to OPT OUT: PreToolUse then
// emits no decision, so the agent falls back to its own permission flow instead
// of granting remote, unsandboxed tool execution unconditionally.
const AUTO_APPROVE = !(process.env.WRC_AUTO_APPROVE === '0' || process.env.WRC_AUTO_APPROVE === 'false');

// Shell names that should NOT be used as session display names
const SHELL_NAMES = new Set(['bash', 'zsh', 'sh', 'fish', 'dash', 'tcsh', 'csh', 'ksh']);

// Per-agent model lists and resolution live in agents.js (getAgent(kind).models,
// resolveModelFor). The #model menu is intercepted at bridge level for both agents.

// ── Mutable state ────────────────────────────────────────────────────
let lastInjectedText       = null;
let lastInjectedTranscript = null;  // transcript path of the session we injected into
let lastPushedText         = null;
// FIFO queue of messages awaiting injection. Each item carries its opaque reply
// target captured at receive time, so the eventual response is forwarded to the
// right conversation even if newer messages arrive meanwhile. Replaces the old
// single `pendingText` slot, which silently dropped a second message that
// arrived while CC was busy.
const MAX_PENDING_QUEUE    = 50;     // upper bound; a stalled turn can't grow it without limit
let pendingQueue           = [];     // Array<{ text, target }>
// Opaque reply target of the message currently injected and awaiting a response.
let injectedTarget         = '';
let orphanPollText         = null;   // injectedText of the in-flight 5-min orphan poll (dedup, B5)
let pendingSelect          = null;   // { type, expires } — waiting for user to pick from a menu
let pendingQuiz            = null;   // { questions, questionIndex, expires } — AskUserQuestion forwarding
let compactionGraceUntil   = 0;     // ms timestamp — accept any same-project transcript until this time
let injectTimer      = null;
let ccBusy           = false;
let lastTarget       = '';     // most recent inbound reply target (opaque)
let lastUserKey      = '';     // stable user id of the most recent inbound (welcome dedup)
const welcomedUsers  = new Set(); // users already sent a welcome this process run

// ── Transport (WeChat / Telegram), set in main() ─────────────────────
let transport            = null;

// ── Progress heartbeat state ─────────────────────────────────────────
// The typing indicator dies client-side after ~15s, so on multi-minute tool
// loops the user is left staring at silence wondering if the bridge crashed.
// A periodic "still working (N tools)" message keeps them informed (C1/H7).
const HEARTBEAT_MS       = 25_000;
let heartbeatTimer       = null;
let heartbeatTarget      = '';       // target the heartbeat sends/edits to
let heartbeatMsgId       = null;     // message id to edit (edit-capable transports)
let heartbeatSentOnce    = false;    // non-edit transports send a single notice, then go quiet
let turnToolCount        = 0;        // tools called during the current turn
let turnLastTool         = '';       // name of the most recent tool

// The typing indicator is now owned by each transport adapter (WeChat's
// getConfig→ticket dance, Telegram's sendChatAction). The core just calls
// transport.sendTyping(target, on).

// ── Progress heartbeat ───────────────────────────────────────────────
// Started when a WeChat-initiated message is injected; ticks every HEARTBEAT_MS
// while the turn is still in flight, pushing a short progress line. Self-stops
// once the turn resolves (lastInjectedText cleared) so a forgotten call site can
// never leave it running.
function startHeartbeat() {
  stopHeartbeat();
  turnToolCount    = 0;
  turnLastTool     = '';
  heartbeatTarget  = injectedTarget || lastTarget;
  heartbeatMsgId   = null;
  heartbeatSentOnce = false;
  heartbeatTimer = setInterval(() => {
    if (!lastInjectedText) { stopHeartbeat(); return; }
    if (pendingQuiz || pendingSelect) return;      // user is being asked something — don't nag
    if (!transport) return;
    // Non-edit transports (WeChat) can't update a status line in place, so every
    // tick would post a NEW chat message — ~12 per 5-min turn. Send a single
    // progress notice on the first tick, then stay quiet until the turn resolves.
    if (!transport.caps.editMessages && heartbeatSentOnce) return;
    const target = injectedTarget || lastTarget || heartbeatTarget;
    if (!target) return;
    const body = turnToolCount > 0
      ? `🔧 处理中：已调用 ${turnToolCount} 个工具${turnLastTool ? `，最近 ${turnLastTool}` : ''}`
      : '🔧 仍在处理中…';
    heartbeatSentOnce = true;
    // Edit-capable transports (Telegram) update ONE status message in place
    // instead of sending a new line every tick.
    if (transport.caps.editMessages && heartbeatMsgId) {
      transport.editText(target, heartbeatMsgId, body).catch(async () => {
        const s = await transport.sendText(target, body).catch(() => null);
        heartbeatMsgId = s?.messageId ?? null;
      });
    } else {
      transport.sendText(target, body).then(s => {
        if (transport.caps.editMessages) heartbeatMsgId = s?.messageId ?? null;
      }).catch(() => {});
    }
  }, HEARTBEAT_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  heartbeatMsgId = null;
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
// Record / clear a best-effort diagnostic flag when the hook server can't bind.
// Surfaced in logs and state.json so a silent startup failure is at least traceable.
function markBridgeStartFailed(reason) {
  try { const st = readState(); st.bridgeStartError = reason; st.bridgeStartErrorAt = Date.now(); writeJson(STATE_FILE, st); } catch {}
}
function clearBridgeStartError() {
  try { const st = readState(); if (st.bridgeStartError) { delete st.bridgeStartError; delete st.bridgeStartErrorAt; writeJson(STATE_FILE, st); } } catch {}
}
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
      kind: sessionKind(s),
      autoApprove: AUTO_APPROVE,
    };
  }
  // Legacy state.json has no kind — default to claude.
  return { ...readState(), kind: 'claude' };
}

// history.jsonl is append-only and would otherwise grow without bound (logs are
// rotated, this was not). Rotate past 5 MB, keeping a single .1 backup so disk
// is capped at ~2x. Only the last ~60 entries are ever read (format_history.py).
const HISTORY_MAX_BYTES = 5 * 1024 * 1024;
function appendHistory(entry) {
  mkdirSync(CC_WECHAT, { recursive: true, mode: 0o700 });
  try {
    if (statSync(HISTORY_FILE).size >= HISTORY_MAX_BYTES) {
      renameSync(HISTORY_FILE, HISTORY_FILE + '.1'); // overwrites prior backup
    }
  } catch {} // ENOENT (no file yet) → nothing to rotate
  // redact() masks Bearer tokens / *_token / secret / password / api_key values so
  // a secret typed over IM (or printed by the agent) isn't retained in plaintext.
  appendFileSync(HISTORY_FILE, redact(JSON.stringify({ ts: Date.now(), ...entry })) + '\n');
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
  // Strip control chars but KEEP newlines (\x0a) — a multi-line WeChat message
  // must reach the agent as one prompt, not be fragmented per line.
  const safe = text.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '');
  if (safe.includes('\n')) {
    // `send-keys -l` delivers each embedded newline as a literal Return, so the
    // agent submits after the first line and the rest lands as separate prompts.
    // Use a tmux paste buffer with bracketed paste (-p) instead: the CC/Codex TUI
    // inserts the newlines verbatim, then a single Enter submits the whole message.
    // (-p only brackets when the pane's app enabled bracketed-paste mode, which
    // both agents do; -d deletes the temp buffer after pasting.)
    execFileSync('tmux', ['set-buffer', '-b', 'wrc-inject', safe]);
    execFileSync('tmux', ['paste-buffer', '-d', '-p', '-b', 'wrc-inject', '-t', target]);
    execFileSync('tmux', ['send-keys', '-t', target, 'Enter']);
    return;
  }
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
 * Forward an AskUserQuestion question to the IM. On transports with inline
 * keyboards (Telegram) each option is a tap-able button (callback_data
 * `quiz:<qIdx>:<optIdx>`, plus a "完成" button for multi-select); otherwise a
 * numbered text menu (WeChat). In both cases a typed custom answer also works.
 */
function sendQuiz(question, replyTarget, qIdx) {
  if (transport.caps.inlineKeyboards) {
    const rows = question.options.map((opt, i) => [{ label: `${i + 1}. ${opt.label}`, data: `quiz:${qIdx}:${i}` }]);
    let text;
    if (question.multiSelect) {
      rows.push([{ label: '✅ 完成', data: `quiz:${qIdx}:done` }]);
      text = `❓ ${question.question}\n\n（多选：点选切换，选好后按"完成"，或直接输入自定义回答）`;
    } else {
      text = `❓ ${question.question}\n\n（点选项，或直接输入自定义回答）`;
    }
    transport.sendButtons(replyTarget, text, rows)
      .catch(err => logger.error('Quiz push failed', { error: err.message }));
    return;
  }
  const lines = [`❓ ${question.question}`];
  question.options.forEach((opt, i) => {
    const desc = opt.description ? ` — ${opt.description}` : '';
    lines.push(`  ${i + 1}. ${opt.label}${desc}`);
  });
  lines.push(question.multiSelect
    ? `\n回复序号（可多选，如 "1,3"），或直接输入自定义回答`
    : `\n回复序号选择，或直接输入自定义回答`);
  transport.sendText(replyTarget, lines.join('\n'))
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
  // Brief wait for the text input field to appear after "Other" is selected.
  // Atomics.wait blocks for 500ms WITHOUT forking a `bash -c sleep` subprocess
  // (same synchronous timing, no fork/exec cost). This path is sync-only.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  execFileSync('tmux', ['send-keys', '-l', '-t', target, trimmed]);
  sendTmuxKey(target, 'Enter');
  return `Other: "${trimmed}"`;
}

/**
 * Handle a typed reply to a pending quiz (button taps go through handleCallback).
 * `replyTarget` is the opaque IM target; `target` below is the tmux pane.
 */
function handleQuizResponse(text, replyTarget) {
  const q = pendingQuiz.questions[pendingQuiz.questionIndex];
  const send = (msg) => transport.sendText(replyTarget, msg)
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

  advanceQuiz(replyTarget);
}

/** Advance to the next quiz question (or clear state). Shared by text + callback paths. */
function advanceQuiz(replyTarget) {
  pendingQuiz.questionIndex++;
  if (pendingQuiz.questionIndex >= pendingQuiz.questions.length) {
    pendingQuiz = null;
  } else {
    setTimeout(() => {
      if (pendingQuiz) {
        pendingQuiz.selected = new Set();
        sendQuiz(pendingQuiz.questions[pendingQuiz.questionIndex], replyTarget, pendingQuiz.questionIndex);
      }
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

// textFromContent / findResponseToInjected / findLastCompleteResponse /
// splitMessage now live in src/message.ts (pure + unit-tested), imported above.

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
 * Get a CC process's start time in epoch ms.
 * Linux: /proc/<pid>/stat field 22 (starttime, clock ticks since boot; CLK_TCK=100).
 * macOS / no /proc: fall back to `ps -o lstart=` (e.g. "Wed Jun 18 10:23:45 2026").
 * Without the fallback, macOS multi-session-same-cwd disambiguation silently
 * degraded to newest-by-mtime, routing messages to the wrong session (B8/M7).
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
  } catch {}
  try {
    const lstart = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const ms = Date.parse(lstart);
    return Number.isNaN(ms) ? null : ms;
  } catch {}
  return null;
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

  // Find the CC process PID and its start time. Use getComm() (which has a macOS
  // `ps` fallback) rather than reading /proc directly, so this works off Linux.
  let ccStartMs = null;
  for (const pid of collectDescendants(panePid)) {
    if (getComm(pid) === 'claude') {
      ccStartMs = getProcessStartTimeMs(pid);
      break;
    }
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

/** Read a process's command basename (/proc on Linux, ps on macOS). */
function getComm(pid) {
  try { return readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch {}
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return basename(out);
  } catch {}
  return '';
}

/**
 * Determine which supported agent (if any) runs in a tmux pane's process tree.
 * Returns 'claude', 'codex', or null. Claude takes priority if both appear.
 */
function detectPaneAgent(panePid) {
  let found = null;
  for (const pid of collectDescendants(panePid)) {
    const comm = getComm(pid);
    if (comm === 'claude') return 'claude';
    if (comm === 'codex') found = 'codex';
  }
  return found;
}

/** macOS fallback: find an open .jsonl transcript via `lsof -p <pid> -Fn`. */
function lsofTranscript(pid) {
  try {
    const out = execFileSync('lsof', ['-p', String(pid), '-Fn'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const line of out.split('\n')) {
      if (line[0] !== 'n') continue;          // -Fn prefixes file paths with 'n'
      const path = line.slice(1);
      if (path.endsWith('.jsonl') && path.startsWith(CLAUDE_PROJECTS)) return path;
    }
  } catch {}
  return null;
}

/**
 * Find the transcript file actually held open by the CC process running in a
 * given tmux pane.  Walks the process tree rooted at panePid and checks each
 * descendant's open file descriptors: /proc/<pid>/fd on Linux, `lsof` on macOS.
 * Returns null if nothing is found (no CC in that pane, or lsof unavailable).
 */
function findTranscriptByPid(panePid) {
  try {
    for (const pid of collectDescendants(panePid)) {
      let procFdReadable = false;
      try {
        const fds = readdirSync(`/proc/${pid}/fd`);
        procFdReadable = true;
        for (const fd of fds) {
          try {
            const target = readlinkSync(join(`/proc/${pid}/fd`, fd));
            if (target.endsWith('.jsonl') && target.startsWith(CLAUDE_PROJECTS)) {
              return target;
            }
          } catch {}
        }
      } catch {}
      // No /proc (macOS) → try lsof for this pid's open files.
      if (!procFdReadable) {
        const viaLsof = lsofTranscript(pid);
        if (viaLsof) return viaLsof;
      }
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

      // Only register panes where a supported agent (claude or codex) is running.
      const kind = detectPaneAgent(panePid);
      if (!kind) continue;

      // Use open-fd scan first (precise); fall back to per-kind discovery.
      //  - claude: process-start-time matching (avoids the findLatestTranscript
      //    pitfall where all sessions sharing a CWD get the newest .jsonl).
      //  - codex: newest rollout whose session_meta cwd matches (date-based dirs).
      let fdTranscript, fallbackTranscript;
      if (kind === 'codex') {
        fdTranscript = findCodexTranscriptByPid(panePid);
        fallbackTranscript = fdTranscript ? null : findLatestCodexRollout(cwd);
      } else {
        fdTranscript = findTranscriptByPid(panePid);
        fallbackTranscript = fdTranscript ? null : findTranscriptForProcess(panePid, cwd);
      }
      const transcriptPath = fdTranscript || fallbackTranscript;
      if (!transcriptPath) continue;

      activeTmuxTargets.add(tmuxStr);

      // Codex rollouts have no /rename custom-title, so never read one for codex.
      const useCustomTitle = (reliable) => kind === 'claude' && reliable;

      // Already registered — refresh transcript path and lastSeen
      const existing = Object.entries(reg.sessions).find(([, s]) => s.tmux === tmuxStr);
      if (existing) {
        reg.sessions[existing[0]].lastSeen = now;
        reg.sessions[existing[0]].kind = kind;
        if (fdTranscript) {
          reg.sessions[existing[0]].transcriptPath = fdTranscript;
        } else if (kind === 'claude') {
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
        // A pinned name (set via #rename) wins over any auto-derived name, so
        // the rescan never reverts an explicit /rename.
        const pinned = reg.sessions[existing[0]].pinnedName;
        const nameTranscript = fdTranscript || reg.sessions[existing[0]].transcriptPath;
        const newName = pinned || getSessionDisplayName(cwd, windowName, nameTranscript, useCustomTitle(!!fdTranscript));
        if (newName !== existing[0] && !reg.sessions[newName]) {
          logger.info(`Session renamed: ${existing[0]} → ${newName} [${tmuxStr}]`);
          reg.sessions[newName] = { ...reg.sessions[existing[0]], lastSeen: now };
          if (reg.active === existing[0]) reg.active = newName;
          delete reg.sessions[existing[0]];
        }
        continue;
      }

      // New session — derive name and add.
      const baseName = getSessionDisplayName(cwd, windowName, transcriptPath, useCustomTitle(!!fdTranscript));
      let name = baseName;
      let suffix = 2;
      while (reg.sessions[name]) name = `${baseName}-${suffix++}`;

      reg.sessions[name] = { tmux: tmuxStr, cwd, transcriptPath, kind, lastSeen: now };
      logger.info(`Auto-discovered ${kind} session: ${name} [${tmuxStr}]`);
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
  const lines = ['📋 Sessions:'];
  names.forEach((name, i) => {
    const s = reg.sessions[name];
    const marker = name === reg.active ? '▶' : '○';
    const shortPath = s.cwd.replace(home, '~');
    lines.push(`${marker} ${i + 1}. ${name} (${sessionKind(s)})  [${s.tmux}]\n   ${shortPath}`);
  });
  lines.push(`\n当前: ${reg.active || '无'}`);
  lines.push('切换: /sw <名字> 或 /sw <序号>');
  lines.push('改名: /rename <新名字>');
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

/** Kind-aware context replay (Claude transcript vs Codex rollout). */
function contextReplayFor(kind, transcriptPath, rounds = CONTEXT_ROUNDS) {
  if (kind === 'codex') {
    const agent = getAgent('codex');
    return agent.contextReplay(agent.parseRollout(transcriptPath), rounds);
  }
  return getContextReplay(transcriptPath, rounds);
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
    const chunks = splitMessage(output, transport.caps.maxMessageLen);
    for (const chunk of chunks) {
      await send(chunk);
    }
  } else {
    await send(`已执行: ${command}`);
  }

  appendHistory({ type: 'slash_command', command, output: output?.slice(0, 200) });
}

/** Inline-keyboard rows for the session list (one button per session). */
function sessionButtons(reg) {
  return Object.keys(reg.sessions).map((name, i) => {
    const s = reg.sessions[name];
    const marker = name === reg.active ? '▶ ' : '';
    return [{ label: `${marker}${i + 1}. ${name} (${sessionKind(s)})`, data: `sw:${i}` }];
  });
}

/** Inline-keyboard rows for the model list (one button per model). */
function modelButtons(models, current) {
  return models.map((m, i) => [{ label: `${m.id === current ? '✅ ' : ''}${i + 1}. ${m.display}`, data: `model:${i}` }]);
}

/**
 * Perform a session switch (shared by the #sw command and the sw:<idx> button
 * callback). Resets injection state so any in-flight Stop / orphan poll from the
 * OLD session is dropped rather than mis-routed to the new one (B2/H4), then
 * replays recent context.
 */
async function performSwitch(targetName, send) {
  const reg = readSessions();
  if (!targetName || !reg.sessions[targetName]) {
    await send(`找不到 session: "${targetName}"\n\n${formatSessionList(reg)}`);
    return;
  }
  if (targetName === reg.active) { await send(`已经在 ${targetName} 了`); return; }

  reg.active = targetName;
  writeSessions(reg);

  // Stop the old turn's typing indicator + heartbeat before clearing state (B7).
  if (injectedTarget || lastTarget) transport.sendTyping(injectedTarget || lastTarget, false).catch(() => {});
  stopHeartbeat();
  // ccBusy must reset: an idle just-switched session fires no Stop, so leaving the
  // OLD session's ccBusy=true would strand the next message forever.
  ccBusy                 = false;
  lastInjectedText       = null;
  lastInjectedTranscript = null;
  lastPushedText         = null;
  injectedTarget         = '';
  orphanPollText         = null;
  pendingQueue           = [];
  cancelPending();
  saveSession({ target: lastTarget, userKey: lastUserKey, lastInjectedText: null });

  // Update cc_pid to the agent process in the new session's pane so status.sh
  // reflects the correct active session in each terminal.
  const s = reg.sessions[targetName];
  try {
    const paneLines = execFileSync('tmux', [
      'list-panes', '-a', '-F', '#{session_name}:#{window_index}.#{pane_index}\t#{pane_pid}',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n');
    const newPanePid = paneLines
      .map(l => l.split('\t'))
      .find(([t]) => t === s.tmux)?.[1];
    if (newPanePid) {
      const wantComm = getAgent(sessionKind(s)).comm;
      for (const pid of collectDescendants(newPanePid)) {
        try {
          if (getComm(pid) === wantComm) {
            writeFileSync(join(CC_WECHAT, 'cc_pid'), String(pid));
            const bridgeData = readJson(join(CC_WECHAT, 'bridge.json'), {});
            bridgeData.ccPid = parseInt(pid);
            writeJson(join(CC_WECHAT, 'bridge.json'), bridgeData);
            logger.info('Updated cc_pid after switch', { pid, session: targetName });
            break;
          }
        } catch {}
      }
    }
  } catch (err) {
    logger.debug('Failed to update cc_pid after switch', { error: err.message });
  }

  const replay = contextReplayFor(sessionKind(s), s.transcriptPath);
  const switchMsg = `✅ 已切换到: ${targetName} (${sessionKind(s)}) [${s.tmux}]\n\n${replay}`;
  for (const chunk of splitMessage(switchMsg, transport.caps.maxMessageLen)) await send(chunk);
  logger.info(`Switched active session to: ${targetName}`);
}

async function handleBridgeCommand(text, replyTarget) {
  const send = (msg) => transport.sendText(replyTarget, msg)
    .catch(err => logger.error('Bridge command reply failed', { error: err.message }));

  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();

  // #ls / #sessions — list all sessions (with tap-to-switch buttons where supported)
  if (cmd === '#ls' || cmd === '#sessions') {
    const reg = readSessions();
    const list = formatSessionList(reg);
    if (transport.caps.inlineKeyboards && Object.keys(reg.sessions).length > 0) {
      await transport.sendButtons(replyTarget, list, sessionButtons(reg))
        .catch(err => logger.error('Session list push failed', { error: err.message }));
    } else {
      await send(list);
    }
    return;
  }

  // #sw <name|number> — switch active session
  if (cmd === '#sw') {
    const arg = parts.slice(1).join(' ').trim();
    if (!arg) {
      const reg = readSessions();
      if (transport.caps.inlineKeyboards && Object.keys(reg.sessions).length > 0) {
        await transport.sendButtons(replyTarget, formatSessionList(reg), sessionButtons(reg))
          .catch(err => logger.error('Session list push failed', { error: err.message }));
      } else {
        await send(`${formatSessionList(reg)}\n\n用法: /sw <名字/序号>`);
      }
      return;
    }

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
    await performSwitch(targetName, send);
    return;
  }

  // #rename <newname> — rename the active session (tmux window + registry).
  // The name is pinned so periodic rescans (scanTmuxForCC) won't revert it.
  if (cmd === '#rename' || cmd === '#mv') {
    const newName = parts.slice(1).join(' ').trim();
    if (!newName) { await send('用法: /rename <新名字>'); return; }
    // tmux window targets use ':' and '.' as separators; reject them in names.
    if (/[:.\n\t]/.test(newName)) { await send('名字不能包含 : . 制表符或换行'); return; }

    const reg = readSessions();
    const oldName = reg.active;
    if (!oldName || !reg.sessions[oldName]) { await send('当前没有活动 session'); return; }
    if (newName === oldName) { await send(`已经叫 ${newName} 了`); return; }
    if (reg.sessions[newName]) { await send(`已存在同名 session: ${newName}`); return; }

    const s = reg.sessions[oldName];
    // Rename the actual tmux window (target-window is session:window, drop .pane).
    // rename-window also disables automatic-rename for that window, so it sticks.
    const windowTarget = s.tmux.split('.')[0];
    try {
      execFileSync('tmux', ['rename-window', '-t', windowTarget, newName], { stdio: 'ignore' });
    } catch (err) {
      logger.error('tmux rename-window failed', { error: err.message, target: windowTarget });
      // Non-fatal — the registry rename below still makes #ls/#sw use the new name.
    }

    reg.sessions[newName] = { ...s, pinnedName: newName, lastSeen: Date.now() };
    delete reg.sessions[oldName];
    reg.active = newName;
    writeSessions(reg);

    logger.info(`Session renamed via #rename: ${oldName} → ${newName} [${s.tmux}]`);
    await send(`✅ 已重命名: ${oldName} → ${newName} [${s.tmux}]`);
    return;
  }

  // #model [selection] — text-based model switcher (bypasses TUI)
  if (cmd === '#model') {
    const arg = parts.slice(1).join(' ').trim();
    const kind = getActiveState().kind || 'claude';
    const models = getAgent(kind).models;

    if (!arg) {
      // Claude exposes the current model via settings.json; Codex stores it in
      // config.toml (no marker shown).
      let current = null;
      if (kind === 'claude') {
        const settings = readJson(join(CLAUDE_CONFIG_DIR, 'settings.json'), {});
        current = settings.model || 'claude-sonnet-4-6';
      }
      pendingSelect = { type: 'model', expires: Date.now() + 5 * 60 * 1000 };
      // Tap-able buttons (Telegram) or a numbered text menu (WeChat).
      if (transport.caps.inlineKeyboards) {
        await transport.sendButtons(replyTarget, '🤖 选择模型（5 分钟内有效）:', modelButtons(models, current))
          .catch(err => logger.error('Model menu push failed', { error: err.message }));
        return;
      }
      const lines = ['🤖 选择模型:'];
      models.forEach((m, i) => {
        const marker = m.id === current ? '✅' : '  ';
        lines.push(`${marker}${i + 1}. ${m.display}`);
        lines.push(`     ${m.id}`);
      });
      lines.push('\n回复序号或名称切换');
      lines.push('5分钟内有效，超时取消');
      await send(lines.join('\n'));
      return;
    }

    // Direct selection: #model <name/number> — resolve then inject+capture
    const resolved = resolveModelFor(kind, arg);
    if (!resolved) {
      const opts = models.map((m, i) => `${i + 1}. ${m.display}`).join('  ');
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
    // Both Claude and Codex accept `/model <id>` as a direct argument.
    await injectSlashAndCapture(target, `/model ${resolved.id}`, send);
    return;
  }

  await send(`未知指令: ${text}\n可用:\n  /ls — 列出 sessions\n  /sw <名字/序号> — 切换\n  /rename <新名字> — 重命名\n  /model — 切换模型`);
}

/**
 * Handle an inline-keyboard button tap (Telegram). Decodes the index-encoded
 * callback data (`model:<i>` / `sw:<i>` / `quiz:<qIdx>:<optIdx|done>`) and routes
 * into the SAME handlers the text path uses. Stale taps (expired menu / removed
 * session / wrong question) are acknowledged gracefully without mis-injecting.
 */
async function handleCallback(inbound) {
  const data = inbound.callbackData || '';
  const replyTarget = inbound.target;
  const ack = (msg) => transport.answerCallback(inbound.replyToken, msg).catch(() => {});
  const send = (m) => transport.sendText(replyTarget, m).catch(() => {});

  // ── model:<idx> ──
  if (data.startsWith('model:')) {
    if (!pendingSelect || pendingSelect.type !== 'model' || Date.now() > pendingSelect.expires) {
      pendingSelect = null; ack('菜单已过期'); return;
    }
    const idx = parseInt(data.slice(6), 10);
    const kind = getActiveState().kind || 'claude';
    const models = getAgent(kind).models;
    if (isNaN(idx) || idx < 0 || idx >= models.length) { ack('无效选项'); return; }
    const resolved = models[idx];
    pendingSelect = null;
    ack(`切换到 ${resolved.display}`);
    const tmux = tmuxTarget(getActiveState());
    if (tmux && paneExists(tmux)) await injectSlashAndCapture(tmux, `/model ${resolved.id}`, send);
    else send('❌ tmux 不可用');
    return;
  }

  // ── sw:<idx> ──
  if (data.startsWith('sw:')) {
    const idx = parseInt(data.slice(3), 10);
    const names = Object.keys(readSessions().sessions);
    if (isNaN(idx) || idx < 0 || idx >= names.length) { ack('该 session 已不存在'); return; }
    ack(`切换到 ${names[idx]}`);
    await performSwitch(names[idx], send);
    return;
  }

  // ── quiz:<qIdx>:<optIdx|done> ──
  if (data.startsWith('quiz:')) {
    if (!pendingQuiz || Date.now() > pendingQuiz.expires) { pendingQuiz = null; ack('问卷已过期'); return; }
    const segs = data.split(':');
    const qIdx = parseInt(segs[1], 10);
    const rest = segs[2];
    if (qIdx !== pendingQuiz.questionIndex) { ack('该问题已过期'); return; }
    const q = pendingQuiz.questions[pendingQuiz.questionIndex];
    const tmux = tmuxTarget(getActiveState());

    if (q.multiSelect) {
      if (rest === 'done') {
        const sel = [...(pendingQuiz.selected || new Set())].sort((a, b) => a - b);
        if (sel.length === 0) { ack('请至少选择一项'); return; }
        if (!tmux || !paneExists(tmux)) { ack('tmux 不可用'); send('❌ tmux 不可用'); pendingQuiz = null; return; }
        try {
          const selected = injectQuizAnswer(tmux, q, sel.map(n => n + 1).join(','));
          ack('已提交'); send(`✅ ${selected}`);
          appendHistory({ type: 'quiz_answer', question: q.question, answer: selected });
        } catch (err) { ack('注入失败'); send(`❌ 注入失败: ${err.message}`); }
        advanceQuiz(replyTarget);
        return;
      }
      const optIdx = parseInt(rest, 10);
      if (isNaN(optIdx) || optIdx < 0 || optIdx >= q.options.length) { ack('无效选项'); return; }
      if (!pendingQuiz.selected) pendingQuiz.selected = new Set();
      if (pendingQuiz.selected.has(optIdx)) pendingQuiz.selected.delete(optIdx);
      else pendingQuiz.selected.add(optIdx);
      const chosen = [...pendingQuiz.selected].sort((a, b) => a - b).map(i => q.options[i].label).join(', ');
      ack(chosen ? `已选: ${chosen}` : '已清空');
      return;
    }

    // single-select
    const optIdx = parseInt(rest, 10);
    if (isNaN(optIdx) || optIdx < 0 || optIdx >= q.options.length) { ack('无效选项'); return; }
    if (!tmux || !paneExists(tmux)) { ack('tmux 不可用'); send('❌ tmux 不可用'); pendingQuiz = null; return; }
    try {
      const selected = injectQuizAnswer(tmux, q, String(optIdx + 1));
      ack(selected); send(`✅ ${selected}`);
      appendHistory({ type: 'quiz_answer', question: q.question, answer: selected });
    } catch (err) { ack('注入失败'); send(`❌ 注入失败: ${err.message}`); }
    advanceQuiz(replyTarget);
    return;
  }

  ack(); // unknown callback — just clear the client spinner
}

// ── Injection state machine ──────────────────────────────────────────
function cancelPending() {
  if (injectTimer) { clearTimeout(injectTimer); injectTimer = null; }
}

function scheduleInject() {
  cancelPending();
  // One turn at a time: never inject while a previous message is still awaiting
  // its response (lastInjectedText set). The Stop handler clears it and re-calls
  // scheduleInject() to drain the next queued message in order.
  if (lastInjectedText) return;
  if (pendingQueue.length === 0) return;
  injectTimer = setTimeout(() => {
    if (lastInjectedText || pendingQueue.length === 0) return;
    const state = getActiveState();
    const target = tmuxTarget(state);
    if (!target || !paneExists(target)) {
      logger.warn('Cannot inject: tmux target unavailable', { target });
      return;
    }
    const item = pendingQueue.shift();
    try {
      sendKeys(target, item.text);
      lastInjectedText       = item.text;
      lastInjectedTranscript = state.transcriptPath || null;
      injectedTarget         = item.target;
      saveSession({ target: lastTarget, userKey: lastUserKey, lastInjectedText, lastInjectedTranscript });
      appendHistory({ type: 'user_wechat', text: item.text });
      startHeartbeat();  // progress pings until this turn resolves (C1/H7)
      logger.info('Injected message', { chars: item.text.length, queued: pendingQueue.length, transcript: lastInjectedTranscript?.slice(-40) });
    } catch (err) {
      // Re-queue at the head so the message is not lost on a transient tmux error.
      pendingQueue.unshift(item);
      logger.error('tmux inject failed', { error: err.message });
    }
  }, INJECT_DELAY);
}

// ── Send with retry ──────────────────────────────────────────────────
// Sends are otherwise fire-and-forget; without retry a transient network blip /
// session hiccup silently drops an assistant reply. Bounded exponential backoff,
// then a best-effort "delivery failed" notice so the user isn't left believing
// the turn produced nothing.
async function sendChunkWithRetry(target, text, attempts = 3) {
  let delay = 500;
  for (let i = 1; i <= attempts; i++) {
    try {
      await transport.sendText(target, text);
      return true;
    } catch (err) {
      logger.warn('sendText failed', { attempt: i, error: err.message });
      if (i < attempts) { await new Promise(r => setTimeout(r, delay)); delay *= 2; }
    }
  }
  logger.error('sendText permanently failed after retries', { chars: text.length });
  return false;
}

/**
 * Forward a full assistant response to a captured reply target: split into
 * chunks (prefixed [i/n] when more than one), each sent with retry. On any
 * permanent chunk failure, send one best-effort notice.
 */
async function forwardResponse(target, fullText) {
  const chunks = splitMessage(fullText, transport.caps.maxMessageLen);
  let anyFailed = false;
  for (let i = 0; i < chunks.length; i++) {
    // Put the multi-part marker on its OWN line. Inline (`[i/n] ` + chunk) would
    // push a continued ``` fence off column 0, so the HTML formatter (Telegram)
    // no longer recognises it and renders the whole code chunk as escaped text.
    const prefix = chunks.length > 1 ? `[${i + 1}/${chunks.length}]\n` : '';
    const ok = await sendChunkWithRetry(target, prefix + chunks[i]);
    if (!ok) anyFailed = true;
  }
  if (anyFailed) {
    transport.sendText(target, '⚠️ 部分回复发送失败，请回终端查看完整结果').catch(() => {});
  }
}

// ── Hook event handlers ──────────────────────────────────────────────

/**
 * Forward a complete assistant response to the IM and clear injection state.
 * Uses the reply target captured at injection time (injectedTarget) — NOT the
 * live "latest" target — so a newer incoming message can't redirect this reply
 * to the wrong conversation. Shared by every Claude/Codex forward path.
 */
function pushResponse(responseText) {
  const target = injectedTarget || lastTarget;
  stopHeartbeat();
  if (transport && target) transport.sendTyping(target, false).catch(() => {});
  lastPushedText         = responseText;
  lastInjectedText       = null;
  lastInjectedTranscript = null;
  injectedTarget         = '';
  saveSession({ target: lastTarget, userKey: lastUserKey, lastInjectedText: null, lastInjectedTranscript: null });
  appendHistory({ type: 'assistant', text: responseText.slice(0, 500) });
  // target is always set in the normal flow (every queued message carries one),
  // but guard defensively so we never call forwardResponse with an empty target.
  if (target) forwardResponse(target, responseText);
  else logger.error('pushResponse: no reply target, dropping forward', { chars: responseText.length });
}

/**
 * Codex Stop handler. Codex rollouts use a different JSONL schema and the Stop
 * payload carries `last_assistant_message`. We forward only WeChat-initiated
 * turns: gate on the rollout's latest user_message matching what we injected,
 * since Codex also fires Stop for turns the user types at the terminal.
 */
function onStopCodex(payload, readPath) {
  if (!lastInjectedText) {
    logger.info('Codex Stop with no injected message, ignoring');
    scheduleInject();
    return;
  }
  const agent = getAgent('codex');
  const entries = agent.parseRollout(readPath);
  const latestUser = agent.latestUserMessage(entries);

  // Gate against terminal-initiated turns. If the rollout's most recent user
  // message exists and isn't ours, this Stop belongs to a terminal turn — leave
  // lastInjectedText set; our own turn's Stop will arrive later.
  if (latestUser !== null && latestUser !== lastInjectedText) {
    logger.debug('Codex Stop for terminal-initiated turn, ignoring', { latestUser: latestUser.slice(0, 60) });
    return;
  }

  const pickText = (eList) => {
    const r = agent.responseToInjected(eList, lastInjectedText);
    if (r?.text) return r.text;
    if (typeof payload.last_assistant_message === 'string' && payload.last_assistant_message.trim()) {
      return payload.last_assistant_message.trim();
    }
    return null;
  };

  const text = pickText(entries);
  if (text) {
    pushResponse(text);
    logger.info('Pushed codex response', { chars: text.length });
    scheduleInject();
    return;
  }

  // No response text yet — rollout may not be flushed. Defer with a bounded poll
  // (Codex has no Notification event to act as a later safety net).
  const savedInjected = lastInjectedText;
  const ORPHAN_GRACE_MS = 60_000;
  const POLL_MS = 5_000;
  const deadline = Date.now() + ORPHAN_GRACE_MS;
  const poll = () => {
    if (lastInjectedText !== savedInjected) return; // resolved elsewhere
    const t2 = pickText(agent.parseRollout(readPath));
    if (t2) {
      orphanPollText = null;
      pushResponse(t2);
      logger.info('Pushed codex response via deferred poll', { chars: t2.length });
      scheduleInject();
      return;
    }
    if (Date.now() >= deadline) {
      logger.warn('Codex: no response within grace window, cleaning up');
      orphanPollText = null;
      if (lastInjectedText === savedInjected) {
        if (transport && (injectedTarget || lastTarget)) transport.sendTyping(injectedTarget || lastTarget, false).catch(() => {});
        lastInjectedText       = null;
        lastInjectedTranscript = null;
        injectedTarget         = '';
        saveSession({ target: lastTarget, userKey: lastUserKey, lastInjectedText: null, lastInjectedTranscript: null });
        scheduleInject();
      }
      return;
    }
    setTimeout(poll, POLL_MS);
  };
  // B5: dedup — one poll chain per injected message.
  if (orphanPollText !== savedInjected) {
    orphanPollText = savedInjected;
    setTimeout(poll, POLL_MS);
  }
  scheduleInject();
}

/**
 * Does `tpath` actually contain our injected user message? Used to gate the
 * "same project dir, different file" acceptance: without this, a late Stop from
 * a DIFFERENT session sharing the cwd (e.g. right after #sw) is wrongly accepted
 * and the response search runs against the wrong transcript (H4).
 */
function transcriptHasInjectedUser(tpath, injectedText) {
  if (!tpath || !injectedText) return false;
  return transcriptHasUserText(parseTranscript(tpath), injectedText);
}

async function onStop(payload) {
  ccBusy = false;
  const state = getActiveState();
  const kind = state.kind || 'claude';
  const tpath = payload.transcript_path || state.transcriptPath;
  if (!tpath) { scheduleInject(); return; }

  // Accept Stop from: (1) the session we injected into, OR (2) the current active session.
  // Check both because the session scanner may temporarily reassign transcriptPath between
  // injection and Stop (flip-flop bug), causing lastInjectedTranscript to be stale.
  const matchesInjected = lastInjectedTranscript && tpath === lastInjectedTranscript;
  const matchesActive   = state.transcriptPath && tpath === state.transcriptPath;
  const hasExpected     = !!(lastInjectedTranscript || state.transcriptPath);
  if (hasExpected && !matchesInjected && !matchesActive) {
    // The compaction-grace and same-project acceptance branches are Claude-only:
    // Codex rollouts live in date-based dirs, so "same dir" is NOT project identity
    // and would wrongly accept an unrelated session's Stop.
    if (kind === 'claude' && lastInjectedText && Date.now() < compactionGraceUntil) {
      logger.info('Accepting post-compaction transcript', { tpath: tpath.slice(-40) });
      lastInjectedTranscript = tpath;  // update to new transcript
    } else if (kind === 'claude' && lastInjectedText
               && isSameProjectDir(tpath, lastInjectedTranscript || state.transcriptPath)
               && transcriptHasInjectedUser(tpath, lastInjectedText)) {
      // Same project dir, different file, AND this transcript actually contains our
      // injected message → the scanner picked the wrong .jsonl at injection time and
      // the hook's tpath is authoritative. Accept it. (If it does NOT contain our
      // message it belongs to a different session sharing the cwd — fall through to
      // ignore, preventing the H4 mis-route after #sw.)
      logger.info('Stop from same project, accepting transcript switch', { tpath: tpath.slice(-40), was: (lastInjectedTranscript || state.transcriptPath)?.slice(-40) });
      lastInjectedTranscript = tpath;
    } else {
      logger.debug('Stop from foreign session, ignoring', { tpath: tpath.slice(-60), injected: lastInjectedTranscript?.slice(-40), active: state.transcriptPath?.slice(-40) });
      // ccBusy was cleared unconditionally at the top of onStop, so a message
      // queued for the ACTIVE session while busy must get a chance to drain now —
      // scheduleInject() is self-guarded (no-op if lastInjectedText set or queue empty).
      scheduleInject();
      return;
    }
  }
  // If tpath matched the active session but not the injected one, update injected
  // so that subsequent handlers (readPath) use the correct transcript.
  if (!matchesInjected && matchesActive && lastInjectedTranscript) {
    logger.info('Updating lastInjectedTranscript to match active session', { from: lastInjectedTranscript.slice(-40), to: tpath.slice(-40) });
    lastInjectedTranscript = tpath;
  }

  logger.info('Stop hook received', { kind, transcript_path: tpath.slice(-60) });

  const readPath = lastInjectedTranscript || tpath;

  // Codex has a distinct rollout schema and supplies last_assistant_message on
  // the Stop payload — handle it separately and return.
  if (kind === 'codex') { onStopCodex(payload, readPath); return; }

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
    pushResponse(responseText);
    logger.info('Pushed response', { chars: responseText.length });
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
        pushResponse(retryResult.text);
        logger.info('Pushed response via deferred retry', { chars: retryResult.text.length });
        scheduleInject();
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
        pushResponse(result.text);
        logger.info('Pushed response via retry', { chars: result.text.length });
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
            orphanPollText = null;
            pushResponse(retryResult.text);
            logger.info('Pushed response via deferred orphan poll', {
              chars: retryResult.text.length,
            });
            scheduleInject();
            return;
          }
          if (Date.now() >= deadline) {
            logger.warn('No response found within grace window, cleaning up', {
              lastInjected: savedInjectedText.slice(0, 60), graceMs: ORPHAN_GRACE_MS,
            });
            orphanPollText = null;
            if (lastInjectedText === savedInjectedText) {
              if (transport && (injectedTarget || lastTarget)) transport.sendTyping(injectedTarget || lastTarget, false).catch(() => {});
              lastInjectedText       = null;
              lastInjectedTranscript = null;
              injectedTarget         = '';
              saveSession({ target: lastTarget, userKey: lastUserKey, lastInjectedText: null, lastInjectedTranscript: null });
              scheduleInject();
            }
            return;
          }
          setTimeout(poll, POLL_INTERVAL_MS);
        };
        // B5: dedup — only one orphan poll chain per injected message, so repeated
        // Stops for the same unresolved turn don't accumulate timer closures.
        if (orphanPollText !== savedInjectedText) {
          orphanPollText = savedInjectedText;
          setTimeout(poll, POLL_INTERVAL_MS);
        }
      }
    }
  }

  scheduleInject();
}

function onPreToolUse(payload) {
  // Only mark CC busy if this is from our tracked session (or no session filter).
  // Foreign CC sessions fire PreToolUse too; if we set ccBusy=true for them but
  // their Stop is filtered out, ccBusy gets stuck forever.
  const tpath = payload.transcript_path;
  const state = getActiveState();
  const kind = state.kind || 'claude';
  const matchesInjected = lastInjectedTranscript && tpath === lastInjectedTranscript;
  const matchesActive   = state.transcriptPath && tpath === state.transcriptPath;
  const hasExpected     = !!(lastInjectedTranscript || state.transcriptPath);
  if (tpath && hasExpected && !matchesInjected && !matchesActive) {
    // Same-project acceptance is Claude-only (Codex date-dirs aren't projects).
    if (kind === 'claude' && isSameProjectDir(tpath, lastInjectedTranscript || state.transcriptPath)) {
      // Same project, different transcript — accept (scanner misassignment)
    } else {
      // Truly foreign session — don't touch ccBusy
      return undefined;
    }
  }

  ccBusy = true;
  cancelPending();

  if (!state.autoApprove) return undefined;

  const toolName  = payload.tool_name || '?';
  const toolInput = payload.tool_input || {};
  let desc = `${toolName}`;
  if (toolName === 'Bash' && toolInput.command) desc = `bash: \`${toolInput.command.slice(0, 120)}\``;
  else if (toolInput.file_path) desc = `${toolName}(${toolInput.file_path})`;

  // Track tool activity for the progress heartbeat (only our in-flight turn).
  if (lastInjectedText) { turnToolCount++; turnLastTool = toolName; }

  // ── Quiz support: forward AskUserQuestion to the IM ──
  // Only intercept quizzes triggered by an IM-injected message (lastInjectedText is set).
  // Terminal-initiated quizzes are left to the terminal user.
  // AskUserQuestion is a Claude Code TUI; Codex uses a different approval UX, so
  // quiz interception is Claude-only.
  if (kind === 'claude' && toolName === 'AskUserQuestion' && lastInjectedText) {
    const questions = toolInput.questions || [];
    if (questions.length > 0) {
      const quizTarget = injectedTarget || lastTarget;
      pendingQuiz = {
        questions,
        questionIndex: 0,
        expires: Date.now() + 5 * 60 * 1000, // 5 min timeout
        target: quizTarget,
        selected: new Set(),
      };
      sendQuiz(questions[0], quizTarget, 0);
      logger.info('Quiz forwarded', { numQuestions: questions.length, q: questions[0].question.slice(0, 80) });
    }
  }

  appendHistory({ type: 'auto_approve', tool: toolName, desc });

  // Emit both the modern (hookSpecificOutput.permissionDecision) and the
  // legacy (decision: 'approve') shapes. Some Claude Code releases honor only
  // one of them — sending both works on every version we've tested without
  // changing semantics. This dual emit is also load-bearing for Codex: Codex
  // honors permissionDecision:'allow' and merely parses-but-ignores
  // decision:'approve', so the same payload auto-approves on both agents.
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

/**
 * UserPromptSubmit handler — primarily Codex's turn-start signal. Codex has no
 * Notification event, and a pure-text turn never reaches PreToolUse, so without
 * this a WeChat message could be injected mid-turn. Mark busy when the prompt
 * belongs to our tracked session.
 */
function onUserPromptSubmit(payload) {
  const tpath = payload.transcript_path;
  const state = getActiveState();
  const matchesInjected = lastInjectedTranscript && tpath === lastInjectedTranscript;
  const matchesActive   = state.transcriptPath && tpath === state.transcriptPath;
  const hasExpected     = !!(lastInjectedTranscript || state.transcriptPath);
  if (tpath && hasExpected && !matchesInjected && !matchesActive) return; // foreign session
  ccBusy = true;
  cancelPending();
}

async function onNotification(payload) {
  const msg = payload.message || '';

  if (msg.includes('waiting for your input')) {
    // CC is idle. Two cases:
    // 1. Quiz pending → already forwarded to the IM, just wait for user reply
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
        // If not found, try the single newest OTHER transcript in the same project
        // dir, in case the scanner assigned the wrong .jsonl at injection time.
        // B6: only the newest alt (not 3) — this runs synchronously on the hook
        // event loop, so reading several large transcripts here stalls the daemon.
        if (!result) {
          try {
            const projDir = dirname(readPath);
            const altPath = readdirSync(projDir)
              .filter(f => f.endsWith('.jsonl') && join(projDir, f) !== readPath)
              .map(f => ({ path: join(projDir, f), mtime: statSync(join(projDir, f)).mtimeMs }))
              .sort((a, b) => b.mtime - a.mtime)[0]?.path;
            if (altPath) {
              result = findResponseToInjected(parseTranscript(altPath), lastInjectedText);
              if (result?.text) {
                logger.info('Found response in alt transcript during idle cleanup', { altPath: altPath.slice(-40) });
                lastInjectedTranscript = altPath;
              }
            }
          } catch {}
        }
      }
      if (result?.text) {
          pushResponse(result.text);
          logger.info('Pushed response via idle cleanup', { chars: result.text.length, complete: result.complete });
          scheduleInject();
          return;
      }
      logger.warn('CC idle but lastInjectedText still set, cleaning up', {
        lastInjected: lastInjectedText.slice(0, 60),
      });
      orphanPollText = null;
      if (transport && (injectedTarget || lastTarget)) transport.sendTyping(injectedTarget || lastTarget, false).catch(() => {});
      lastInjectedText       = null;
      lastInjectedTranscript = null;
      injectedTarget         = '';
      saveSession({ target: lastTarget, userKey: lastUserKey, lastInjectedText: null, lastInjectedTranscript: null });
      scheduleInject();
    } else {
      logger.info('Notification (logged, not pushed): ' + msg);
    }
    return;
  }
  appendHistory({ type: 'notification', text: msg });
  logger.info('Notification: ' + msg);
}

// ── Hook server (Unix socket) ────────────────────────────────────────
function startHookServer() {
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
        if (hookType === 'stop')                   onStop(payload);
        else if (hookType === 'pretooluse')        reply = onPreToolUse(payload);
        else if (hookType === 'notification')      onNotification(payload);
        else if (hookType === 'userpromptsubmit')  onUserPromptSubmit(payload);
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

  // Singleton gate: the hook socket IS the singleton token. Only one process can
  // bind an AF_UNIX path, so a second daemon — launched from ANY install dir
  // (~/.claude/skills or ~/.agents/skills) — detects the live one and exits.
  return new Promise((resolve) => {
    let retries = 0;
    const MAX_RETRIES = 3;

    function onListen() {
      if (process.platform !== 'win32') try { chmodSync(HOOK_SOCKET, 0o600); } catch {}
      // Claim singleton ownership: write our own PID authoritatively.
      try { writeFileSync(join(CC_WECHAT, 'bridge.pid'), String(process.pid)); } catch {}
      clearBridgeStartError();
      logger.info('Hook server ready at ' + HOOK_SOCKET);
      console.log('[wrc-bridge] hook server ready at ' + HOOK_SOCKET);
      resolve(server);
    }

    server.on('error', (err) => {
      if (err.code !== 'EADDRINUSE') {
        // e.g. EACCES / EIO — not recoverable by retry. Record + exit loudly so
        // the failure is traceable rather than a silent dead bridge.
        logger.error('Hook server error (fatal)', { code: err.code, error: err.message });
        console.error('[wrc-bridge] hook server error: ' + err.message);
        markBridgeStartFailed(`bind failed: ${err.code || err.message}`);
        process.exit(1);
      }
      // Path is taken. Probe whether a live daemon owns it.
      const probe = net.connect(HOOK_SOCKET);
      const decideAlive = () => {
        try { probe.destroy(); } catch {}
        logger.info('Another bridge daemon already running, exiting');
        console.log('[wrc-bridge] another bridge daemon already running, exiting');
        process.exit(0);
      };
      probe.setTimeout(500);
      probe.once('connect', decideAlive);
      probe.once('timeout', decideAlive);
      probe.once('error', () => {
        try { probe.destroy(); } catch {}
        // Stale socket file (no live listener). Remove and retry with bounded
        // backoff — covers the race where another daemon rebinds between our
        // unlink and listen, instead of giving up after a single attempt.
        if (retries >= MAX_RETRIES) {
          logger.error('Hook socket busy after stale cleanup, giving up', { retries });
          console.error('[wrc-bridge] hook socket busy after stale cleanup, giving up');
          markBridgeStartFailed('hook socket busy after stale cleanup');
          process.exit(1);
        }
        retries++;
        try { unlinkSync(HOOK_SOCKET); } catch {}
        setTimeout(() => server.listen(HOOK_SOCKET, onListen), 200 * retries);
      });
    });

    server.listen(HOOK_SOCKET, onListen);
  });
}

// ── Welcome / reconnect text (agent-aware) ───────────────────────────
// The bridge drives both Claude Code and Codex, so greetings reflect the
// ACTIVE session's agent rather than hard-coding "Claude Code".
function agentLabel(kind) {
  return kind === 'codex' ? 'Codex' : 'Claude Code';
}

function buildWelcome({ reconnect = false, activeName = '', kind = '' } = {}) {
  const label = kind ? agentLabel(kind) : '微信远程';
  const header = reconnect
    ? `👋 ${label} 已重连！\n\n当前 session: ${activeName || '(unknown)'}\n\n`
    : `👋 ${label} 已连接！\n\n`;
  return header +
    '可用指令：\n' +
    '  /ls — 列出所有 session（Claude Code / Codex）\n' +
    '  /sw <名字/序号> — 切换 session\n' +
    '  /rename <新名字> — 重命名当前 session\n' +
    '  /model — 切换模型（文字菜单，无需终端交互）\n\n' +
    '直接发消息即注入当前 session，回复将自动转发。';
}

// ── Inbound message handler (transport-agnostic) ─────────────────────
// Operates on the normalised InboundMessage from any transport. The reply
// destination is the opaque `inbound.target`; the core never inspects it.
function onInboundMessage(inbound) {
  lastTarget  = inbound.target;
  lastUserKey = inbound.userKey;
  const replyTarget = inbound.target;

  // Button taps (Telegram) → callback dispatcher.
  if (inbound.kind === 'callback') {
    handleCallback(inbound).catch(err => logger.error('Callback handler error', { error: err.message }));
    return;
  }

  // Unsupported media → notice only.
  if (inbound.kind === 'unsupported_media') {
    if (inbound.mediaNote) transport.sendText(replyTarget, inbound.mediaNote).catch(() => {});
    return;
  }

  const text = inbound.text;
  if (!text) return;

  // A side-channel notice may accompany injectable text (e.g. WeChat voice-no-ASR).
  if (inbound.mediaNote) transport.sendText(replyTarget, inbound.mediaNote).catch(() => {});

  logger.info('Inbound message', { from: inbound.userKey, text: text.slice(0, 80) });

  // Welcome first-time users (once per bridge process run).
  if (!welcomedUsers.has(inbound.userKey)) {
    welcomedUsers.add(inbound.userKey);
    transport.sendText(replyTarget, buildWelcome({ reconnect: false, kind: getActiveState().kind }))
      .catch(err => logger.error('Welcome message failed', { error: err.message }));
  }

  // Consume a pending /model text selection (button taps go through handleCallback).
  if (pendingSelect) {
    if (Date.now() > pendingSelect.expires) {
      logger.info('pendingSelect expired, clearing');
      pendingSelect = null;
      transport.sendText(replyTarget, '⏰ 模型菜单已超时取消，本条按普通消息处理').catch(() => {});
    } else if (pendingSelect.type === 'model') {
      const resolved = resolveModelFor(getActiveState().kind || 'claude', text.trim());
      if (resolved) {
        pendingSelect = null;
        const reply = (m) => transport.sendText(replyTarget, m)
          .catch(err => logger.error('Model select reply failed', { error: err.message }));
        const tmux = tmuxTarget(getActiveState());
        if (tmux && paneExists(tmux)) injectSlashAndCapture(tmux, `/model ${resolved.id}`, reply);
        else reply('❌ tmux 不可用');
        return;
      }
      // Unrecognised input — cancel selection, fall through to normal injection.
      pendingSelect = null;
      logger.info('pendingSelect: unrecognised input, cancelled');
    }
  }

  // Consume a pending quiz (typed answer).
  if (pendingQuiz) {
    if (Date.now() > pendingQuiz.expires) {
      logger.info('pendingQuiz expired, clearing');
      pendingQuiz = null;
      transport.sendText(replyTarget, '⏰ 问卷已超时取消，本条按普通消息处理').catch(() => {});
    } else {
      handleQuizResponse(text, replyTarget);
      return;
    }
  }

  // ── Route slash commands ─────────────────────────────────────────
  // Agent built-in commands never produce JSONL transcript entries; we intercept
  // them: bridge meta-commands (#-prefixed), TUI-only → warn, text-output →
  // inject + capture pane. Non-built-in /xxx (skills) pass through to injection.
  let cmdText = text.trim();
  if (/^\/ls\b/i.test(cmdText) || /^\/sessions\b/i.test(cmdText)) cmdText = '#ls';
  else if (/^\/sw(\s|$)/i.test(cmdText)) cmdText = '#sw' + cmdText.slice(3);
  else if (/^\/rename(\s|$)/i.test(cmdText)) cmdText = '#rename' + cmdText.slice(7);
  else if (/^\/mv(\s|$)/i.test(cmdText)) cmdText = '#rename' + cmdText.slice(3);
  else if (/^\/model(\s|$)/i.test(cmdText)) cmdText = '#model' + cmdText.slice(6);

  if (cmdText.startsWith('#')) {
    handleBridgeCommand(cmdText, replyTarget);
    return;
  }

  const slashMatch = cmdText.match(/^\/([a-z][\w-]*)/i);
  if (slashMatch) {
    const slashName = slashMatch[1].toLowerCase();
    const activeKind = getActiveState().kind || 'claude';
    const builtin = activeKind === 'codex' ? getAgent('codex').builtinSlash : CC_BUILTIN_SLASH;
    const tuiOnly = activeKind === 'codex' ? getAgent('codex').tuiOnly : CC_TUI_ONLY;

    if (builtin.has(slashName)) {
      const sendReply = (m) => transport.sendText(replyTarget, m)
        .catch(err => logger.error('Slash reply failed', { error: err.message }));
      const tmux = tmuxTarget(getActiveState());
      if (!tmux || !paneExists(tmux)) { sendReply('❌ tmux 不可用'); return; }

      if (tuiOnly.has(slashName)) {
        const remotable = activeKind === 'codex'
          ? '/status /diff /mcp /ps /compact /clear /new /model /review'
          : '/cost /usage /compact /clear /fast /effort /help /doctor /status /model';
        sendReply(`⚠️ /${slashName} 需要终端交互（方向键选择），无法远程操作。\n\n可远程使用的命令:\n  ${remotable}`);
        return;
      }
      injectSlashAndCapture(tmux, cmdText, sendReply);
      return;
    }
    // Not a known built-in → probably a skill → inject normally (produces transcript)
  }

  // Regular message or skill — enqueue for injection. Capture the reply target NOW
  // so a later message can't steal this turn's response (H2/H3).
  // Bound the queue: a stalled turn could otherwise let it grow without limit.
  if (pendingQueue.length >= MAX_PENDING_QUEUE) {
    pendingQueue.shift(); // drop oldest
    logger.warn('pendingQueue full, dropping oldest queued message', { max: MAX_PENDING_QUEUE });
    transport.sendText(replyTarget, '⚠️ 排队消息过多，已丢弃最早的一条').catch(() => {});
  }
  pendingQueue.push({ text, target: replyTarget });

  // Show a typing indicator immediately (fire-and-forget).
  if (transport.caps.typingIndicator) transport.sendTyping(replyTarget, true).catch(() => {});

  if (!ccBusy) scheduleInject();
  else logger.info('CC busy, message queued for injection after Stop', { queued: pendingQueue.length });
}

// ── Main ─────────────────────────────────────────────────────────────
// Native command menu (Telegram setMyCommands). Each entry, when tapped, sends
// the "/<command>" text which the slash-alias router maps to a bridge command.
const MENU_COMMANDS = [
  { command: 'ls',    description: '列出所有 session' },
  { command: 'sw',    description: '切换 session' },
  { command: 'model', description: '切换模型' },
];

async function main() {
  mkdirSync(CC_WECHAT, { recursive: true });

  const transportName = resolveTransportName();
  transport = await createTransport(transportName);

  const session = loadSession();
  lastTarget             = session.target || '';
  lastUserKey            = session.userKey || '';
  lastInjectedText       = session.lastInjectedText || null;
  lastInjectedTranscript = session.lastInjectedTranscript || null;

  const hookServer = await startHookServer();

  // Initial tmux scan then periodic
  scanTmuxForCC();
  setInterval(scanTmuxForCC, SCAN_INTERVAL);

  const target = tmuxTarget(getActiveState());
  const reg    = readSessions();
  console.log(`[wrc-bridge] transport=${transportName} active session: ${reg.active || 'NONE'} → ${target || 'NONE'}`);
  logger.info('Bridge started', { transport: transportName, active: reg.active, target });

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

  function onEvent(ev) {
    if (ev.type === 'ready') {
      logger.info('Transport ready', { transport: transportName, self: ev.selfName });
      console.log(`[wrc-bridge] transport ready (${transportName}${ev.selfName ? ' @' + ev.selfName : ''})`);

      // Register the native command menu where supported (Telegram).
      if (transport.caps.commandMenu && transport.setCommandMenu) {
        transport.setCommandMenu(MENU_COMMANDS).catch(() => {});
      }

      // Proactive reconnect welcome if we know the user from a previous session.
      if (lastTarget) {
        if (lastUserKey) welcomedUsers.add(lastUserKey); // suppress duplicate on first inbound
        const activeName = readSessions().active || '(unknown)';
        transport.sendText(lastTarget, buildWelcome({ reconnect: true, activeName, kind: getActiveState().kind }))
          .catch(err => logger.error('Startup welcome failed', { error: err.message }));
        logger.info('Sent startup welcome', { target: lastTarget });
      }
      return;
    }
    if (ev.type === 'session_expired') {
      logger.warn('Transport session expired');
      console.error('[wrc-bridge] session expired — re-login needed');
      try {
        const st = readState();
        if (!st.sessionExpired) {
          st.sessionExpired = true;
          st.sessionExpiredAt = Date.now();
          writeJson(STATE_FILE, st);
        }
      } catch (e) {
        logger.warn('Failed to mark session expired in state', { error: e.message });
      }
      try {
        const t = tmuxTarget(getActiveState());
        if (t) {
          execFileSync('tmux', [
            'display-message', '-t', t, '-d', '8000',
            '⚠️  IM session expired — run /wechat-remote-control to re-login',
          ], { stdio: 'ignore' });
        }
      } catch {}
    }
  }

  function shutdown() {
    logger.info('Shutting down');
    if (transport && lastTarget) transport.sendTyping(lastTarget, false).catch(() => {});
    if (transport) transport.stop();
    hookServer.close();
    cancelPending();
    try { unlinkSync(HOOK_SOCKET); } catch {}
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log('[wrc-bridge] starting poll loop...');
  await transport.start(onInboundMessage, onEvent);
}

main().catch(err => {
  console.error('[wrc-bridge] Fatal:', err);
  logger.error('Fatal', { error: err.message });
  process.exit(1);
});
