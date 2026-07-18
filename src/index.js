/**
 * wrc-bridge: Remote Control bridge for Claude Code / Codex.
 *
 * Injects messages from an IM (WeChat or Telegram) into a tmux-hosted agent
 * session via send-keys, watches the agent transcript for assistant responses,
 * and forwards them back to the IM. The IM is abstracted behind the Transport
 * interface (src/transport/), so the core deals only in an opaque reply target.
 * Hook events arrive over a Unix socket from hook.py.
 *
 * Multi-session model: every discovered tmux session (claude/codex pane) owns an
 * independent SessionState — its own message queue, in-flight turn, quiz, status
 * message and orphan polls — so sessions work CONCURRENTLY. Hook events route by
 * the pane id hook.py self-reports (TMUX_PANE); inbound IM messages route by
 * forum topic (Telegram topics mode) or to the active session (private chat /
 * WeChat fallback).
 *
 * Commands (also mapped from /-aliases and the Telegram command menu):
 *   #ls            — compact tmux-session list (tap a button to switch focus)
 *   #sw <n|name>   — move the default-route pointer (other sessions keep running)
 *   #fc <n|name>   — focus one tmux session (other topics removed, rebuilt on refocus)
 *   #rename <name> — rename a session (tmux window + registry + topic, pinned)
 *   #model         — model menu; #esc — interrupt; #bind — bind a topics group
 */

import net from 'node:net';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, readlinkSync, unlinkSync, appendFileSync, chmodSync, renameSync, openSync, readSync, closeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname, basename } from 'node:path';

// Pluggable IM transport (WeChat / Telegram). The core never references a
// specific IM — it talks to the Transport interface and an opaque reply target.
import { createTransport, resolveTransportName } from '../dist/transport/index.js';
import { encodeCwd, isSameProjectDir } from '../dist/constants.js';
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
import {
  sessionKeyFor, newSessionState,
  resolveSessionForHook, resolveSessionForInbound,
  persistableState, migrateLegacyIlink, planTopicSync,
  tmuxSessionOf, effectiveFocus, orderedSessionNames, sanitizeSessionName,
} from '../dist/sessions.js';

// ── Paths ────────────────────────────────────────────────────────────
const HOOK_SOCKET    = '/tmp/cc_wechat_hook.sock';
const CC_WECHAT      = join(homedir(), '.wechat-remote-control');
const STATE_FILE     = join(CC_WECHAT, 'state.json');       // legacy single-session
const SESSIONS_FILE  = join(CC_WECHAT, 'sessions.json');    // multi-session registry
const HISTORY_FILE   = join(CC_WECHAT, 'history.jsonl');
const SESSION_FILE   = join(CC_WECHAT, 'ilink_session.json');
const SESS_STATE_FILE = join(CC_WECHAT, 'sessions_state.json'); // per-session crash-recovery turns
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
// Every per-turn variable that used to live here as a module global is now a
// field of a per-session SessionState (see src/sessions.ts): each discovered
// tmux session runs its own queue / in-flight turn / quiz / status message,
// fully concurrently. Only genuinely cross-session state stays global.
const MAX_PENDING_QUEUE = 50;         // per-session queue bound
const sessionStates = new Map();      // sessionKey (paneId) → SessionState
const sidToState    = new Map();      // short runtime id → SessionState (callback routing)
let lastTarget       = '';     // most recent inbound reply target (opaque)
let lastUserKey      = '';     // stable user id of the most recent inbound (welcome dedup)
let persistedTarget  = '';     // last (target,userKey) written to ilink_session.json
const welcomedUsers  = new Set(); // users already sent a welcome this process run

// ── Transport (WeChat / Telegram), set in main() ─────────────────────
let transport            = null;

/** Get (or lazily create) the SessionState for a registry entry. */
function getStateFor(name, entry) {
  const key = sessionKeyFor(entry);
  let sess = sessionStates.get(key);
  if (!sess && entry.paneId) {
    // Key churn: a state created before the entry's paneId was known lives
    // under the tmux-coordinates fallback key. Migrate it — with its in-flight
    // turn and queue intact — instead of creating an amnesiac duplicate.
    const legacy = sessionStates.get(`tmux:${entry.tmux}`);
    if (legacy) {
      sessionStates.delete(legacy.key);
      legacy.key = key;
      sessionStates.set(key, legacy);
      persistStates();
      sess = legacy;
      logger.info('Migrated session state to pane key', { name, key });
    }
  }
  if (!sess) {
    sess = newSessionState(key, name);
    sessionStates.set(key, sess);
    sidToState.set(sess.sid, sess);
  }
  if (sess.name !== name) sess.name = name;
  return sess;
}

/** Iterate live states (view for the pure resolvers). */
function statesView() { return sessionStates.values(); }

/** Persist every in-flight turn for daemon-restart recovery. */
function persistStates() {
  const out = {};
  for (const [key, s] of sessionStates) {
    if (s.lastInjectedText) out[key] = persistableState(s);
  }
  writeJson(SESS_STATE_FILE, out);
}

/** Tear down a session's runtime state (timers, in-flight notice). */
function destroyState(key, reason) {
  const sess = sessionStates.get(key);
  if (!sess) return;
  stopTurnStatus(sess);
  cancelPending(sess);
  if (sess.lastInjectedText) {
    const target = sess.injectedTarget || lastTarget;
    if (transport && target) {
      transport.sendTyping(target, false).catch(() => {});
      transport.sendText(target, `⚠️ 会话 ${sess.name} 已消失（${reason}），该条消息的回复不再跟踪`).catch(() => {});
    }
  }
  // Null the turn so any orphan-poll closure still holding this state sees it
  // resolved and dies silently, instead of double-signalling the user later.
  sess.lastInjectedText = null;
  sess.orphanPollText = null;
  sess.pendingQueue = [];
  sessionStates.delete(key);
  sidToState.delete(sess.sid);
  persistStates();
}

/** React to a user's message (👀 injected / 👍 delivered / 💔 abandoned) where supported. */
function reactTo(target, messageId, emoji) {
  if (!transport?.caps.reactions || !transport.react || !target || !messageId) return;
  transport.react(target, messageId, emoji).catch(() => {});
}

// ── Per-turn live status ─────────────────────────────────────────────
// The typing indicator dies client-side after ~15s, so on multi-minute tool
// loops the user is left staring at silence wondering if the bridge crashed.
// Edit-capable transports (Telegram) get ONE status message per turn, edited in
// place: elapsed time + tool activity + a ⏹ interrupt button. Non-edit
// transports (WeChat) keep the old single "still working" notice. Self-stops
// once the turn resolves (sess.lastInjectedText cleared) so a forgotten call
// site can never leave it running.
const HEARTBEAT_MS       = 25_000;
const STATUS_DEBOUNCE_MS = 3_000;   // min gap between tool-triggered edits (TG rate limits)

// The typing indicator is owned by each transport adapter (WeChat's
// getConfig→ticket dance, Telegram's sendChatAction). The core just calls
// transport.sendTyping(target, on).

function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60 ? `${s % 60}s` : ''}`;
}

function statusBody(sess) {
  const elapsed = fmtDur(Date.now() - sess.turnStartedAt);
  return sess.turnToolCount > 0
    ? `⏳ ${elapsed} · 已调用 ${sess.turnToolCount} 个工具${sess.turnLastTool ? ` · 最近 ${sess.turnLastTool}` : ''}`
    : `🚀 处理中… ${elapsed}`;
}

function statusButtons(sess) {
  return [[{ label: '⏹ 中断', data: `intr:${sess.sid}` }]];
}

function editStatus(sess) {
  const target = sess.injectedTarget || lastTarget;
  if (!transport || !target || !sess.lastInjectedText) return;
  if (sess.pendingQuiz || sess.pendingSelect) return;  // user is being asked something — don't nag
  if (!sess.statusMsgId) return;
  transport.editText(target, sess.statusMsgId, statusBody(sess), statusButtons(sess)).catch(() => {});
}

function startTurnStatus(sess) {
  stopTurnStatus(sess);
  sess.turnStartedAt     = Date.now();
  sess.turnToolCount     = 0;
  sess.turnLastTool      = '';
  sess.statusMsgId       = null;
  sess.heartbeatSentOnce = false;
  if (transport?.caps.editMessages && transport.caps.inlineKeyboards) {
    transport.sendButtons(sess.injectedTarget || lastTarget, statusBody(sess), statusButtons(sess))
      .then(s => { sess.statusMsgId = s?.messageId ?? null; })
      .catch(() => {});
  }
  sess.heartbeatTimer = setInterval(() => {
    if (!sess.lastInjectedText) { stopTurnStatus(sess); return; }
    if (sess.pendingQuiz || sess.pendingSelect) return;
    if (!transport) return;
    if (transport.caps.editMessages) { editStatus(sess); return; }
    // Non-edit transports (WeChat) can't update a status line in place, so every
    // tick would post a NEW chat message — ~12 per 5-min turn. Send a single
    // progress notice on the first tick, then stay quiet until the turn resolves.
    if (sess.heartbeatSentOnce) return;
    const target = sess.injectedTarget || lastTarget;
    if (!target) return;
    sess.heartbeatSentOnce = true;
    transport.sendText(target, sess.turnToolCount > 0
      ? `🔧 处理中：已调用 ${sess.turnToolCount} 个工具${sess.turnLastTool ? `，最近 ${sess.turnLastTool}` : ''}`
      : '🔧 仍在处理中…').catch(() => {});
  }, HEARTBEAT_MS);
}

/** Tool-event nudge: debounce edits so a rapid tool loop can't hit TG rate limits. */
function bumpTurnStatus(sess) {
  if (!transport?.caps.editMessages || !sess.statusMsgId) return;
  if (sess.statusEditTimer) return;
  sess.statusEditTimer = setTimeout(() => {
    sess.statusEditTimer = null;
    editStatus(sess);
  }, STATUS_DEBOUNCE_MS);
}

/** Finalize the status message (✅/⚠️ summary, button removed) and stop timers. */
function finishTurnStatus(sess, summary) {
  if (sess.statusEditTimer) { clearTimeout(sess.statusEditTimer); sess.statusEditTimer = null; }
  if (sess.heartbeatTimer) { clearInterval(sess.heartbeatTimer); sess.heartbeatTimer = null; }
  const target = sess.injectedTarget || lastTarget;
  if (summary && transport?.caps.editMessages && sess.statusMsgId && target) {
    transport.editText(target, sess.statusMsgId, summary).catch(() => {});
  }
  sess.statusMsgId = null;
}

function stopTurnStatus(sess) {
  finishTurnStatus(sess, null);
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
  // display-message resolves both coordinate ("s:w.p") and pane-id ("%5") targets.
  try {
    execFileSync('tmux', ['display-message', '-p', '-t', target, '#{pane_id}'],
      { stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch { return false; }
}

/** Resolve a tmux target (session:window.pane) to its pane pid, or null. */
function panePidFor(tmuxStr) {
  if (!tmuxStr) return null;
  try {
    const rows = execFileSync('tmux', [
      'list-panes', '-a', '-F', '#{session_name}:#{window_index}.#{pane_index}\t#{pane_pid}',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n');
    const row = rows.map(l => l.split('\t')).find(([t]) => t === tmuxStr);
    return row ? row[1] : null;
  } catch { return null; }
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
function sendKeys(target, text, bufKey = '') {
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
    // The buffer name is namespaced per session — two sessions injecting
    // multi-line messages concurrently must not race one shared buffer.
    const buf = `wrc-inject-${(bufKey || 'default').replace(/[^%\w.-]/g, '_')}`;
    execFileSync('tmux', ['set-buffer', '-b', buf, safe]);
    execFileSync('tmux', ['paste-buffer', '-d', '-p', '-b', buf, '-t', target]);
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
function tryAutoConfirmCompaction(sess, target) {
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
  // Set grace period so the Stop handler accepts the new post-compaction transcript.
  // Anchor it to the project we're compacting (the injected transcript) BEFORE
  // nulling lastInjectedTranscript below, so the grace can only authorize accepting a
  // Stop from THE SAME project — never an unrelated Claude session that happens to
  // compact within the window (which would otherwise forward its reply to our chat).
  sess.compactionGraceUntil = Date.now() + 120_000; // 2 minutes
  sess.compactionGraceTranscript = sess.lastInjectedTranscript
    || readSessions().sessions[sess.name]?.transcriptPath || null;
  sess.lastInjectedTranscript = null;  // will be re-set from the Stop payload
  return true;
}

/**
 * Forward an AskUserQuestion question to the IM. On transports with inline
 * keyboards (Telegram) each option is a tap-able button (callback_data
 * `quiz:<sid>:<qIdx>:<optIdx>`, plus a "完成" button for multi-select);
 * otherwise a numbered text menu (WeChat). A typed custom answer also works.
 */
function sendQuiz(sess, question, replyTarget, qIdx) {
  if (transport.caps.inlineKeyboards) {
    const rows = question.options.map((opt, i) => [{ label: `${i + 1}. ${opt.label}`, data: `quiz:${sess.sid}:${qIdx}:${i}` }]);
    let text;
    if (question.multiSelect) {
      rows.push([{ label: '✅ 完成', data: `quiz:${sess.sid}:${qIdx}:done` }]);
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
function handleQuizResponse(sess, text, replyTarget) {
  const q = sess.pendingQuiz.questions[sess.pendingQuiz.questionIndex];
  const send = (msg) => transport.sendText(replyTarget, msg)
    .catch(err => logger.error('Quiz reply failed', { error: err.message }));

  const target = tmuxTargetFor(sess);
  if (!target || !paneExists(target)) {
    send('❌ tmux 不可用');
    sess.pendingQuiz = null;
    return;
  }

  try {
    const selected = injectQuizAnswer(target, q, text);
    send(`✅ ${selected}`);
    appendHistory({ type: 'quiz_answer', session: sess.name, question: q.question, answer: selected });
    logger.info('Quiz answer injected', { question: q.question.slice(0, 60), answer: selected });
  } catch (err) {
    send(`❌ 注入失败: ${err.message}`);
    logger.error('Quiz inject failed', { error: err.message });
  }

  advanceQuiz(sess, replyTarget);
}

/** Advance to the next quiz question (or clear state). Shared by text + callback paths. */
function advanceQuiz(sess, replyTarget) {
  sess.pendingQuiz.questionIndex++;
  if (sess.pendingQuiz.questionIndex >= sess.pendingQuiz.questions.length) {
    sess.pendingQuiz = null;
  } else {
    setTimeout(() => {
      if (sess.pendingQuiz) {
        sess.pendingQuiz.selected = new Set();
        sendQuiz(sess, sess.pendingQuiz.questions[sess.pendingQuiz.questionIndex], replyTarget, sess.pendingQuiz.questionIndex);
      }
    }, 800);
  }
}

/**
 * Registry-empty fallback: an attach may exist only in legacy state.json (very
 * old install, sessions.json wiped by hand, or an agent process the scanner
 * cannot classify). Synthesize a registry entry from it so messages keep
 * flowing — parity with the old getActiveState() legacy fallback.
 */
function synthesizeLegacySession(reg) {
  const state = readState();
  const target = tmuxTarget(state);
  if (!target || !paneExists(target)) return null;
  const name = 'attached';
  reg.sessions[name] = {
    tmux: target,
    cwd: '',
    transcriptPath: state.transcriptPath || null,
    kind: 'claude',
    lastSeen: Date.now(),
  };
  reg.active = name;
  writeSessions(reg);
  logger.info('Synthesized session from legacy state.json', { target });
  return { name, viaTopic: false };
}

/**
 * Resolve a session's tmux pane target from the registry. Prefers the stable
 * pane id (survives window moves/renames) over coordinates.
 */
function tmuxTargetFor(sess) {
  const reg = readSessions();
  const entry = reg.sessions[sess.name]
    ?? Object.values(reg.sessions).find(s => sessionKeyFor(s) === sess.key);
  if (!entry) return null;
  return entry.paneId || entry.tmux;
}

// ── Transcript helpers ───────────────────────────────────────────────
// CC transcripts are append-only JSONL and grow into MBs over a long session.
// parseTranscript runs synchronously on the hook event loop (every Stop /
// Notification) and inside poll timers, so reading the WHOLE file each time stalls
// the daemon (blocking the IM long-poll, other hooks, timers). Callers on the hot
// path pass maxBytes to read only the tail — the current turn (injected user msg +
// its response) is always at the very end. The first, possibly-partial, line of a
// tailed read is dropped. maxBytes <= 0 (default) reads the whole file, preserving
// behaviour for cold paths (#sw context replay, etc.).
const TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024; // ample for any single turn

function parseTranscript(filePath, maxBytes = 0) {
  try {
    let raw;
    if (maxBytes > 0) {
      const size = statSync(filePath).size;
      if (size > maxBytes) {
        const fd = openSync(filePath, 'r');
        try {
          const buf = Buffer.allocUnsafe(maxBytes);
          const read = readSync(fd, buf, 0, maxBytes, size - maxBytes);
          raw = buf.toString('utf8', 0, read);
        } finally { closeSync(fd); }
        const nl = raw.indexOf('\n');      // drop the leading partial line
        raw = nl >= 0 ? raw.slice(nl + 1) : raw;
      } else {
        raw = readFileSync(filePath, 'utf8');
      }
    } else {
      raw = readFileSync(filePath, 'utf8');
    }
    const lines = raw.trim().split('\n');
    return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/** Is `filePath` larger than the hot-path tail cap? (used to decide a full-read fallback) */
function transcriptExceedsTail(filePath) {
  try { return statSync(filePath).size > TRANSCRIPT_TAIL_BYTES; } catch { return false; }
}

// textFromContent / findResponseToInjected / findLastCompleteResponse /
// splitMessage now live in src/message.ts (pure + unit-tested), imported above.

// ── Multi-session: discovery ─────────────────────────────────────────

// encodeCwd is imported from ../dist/constants.js (single source of truth, shared
// with detect.py's encode_cwd via the unit test). Previously index.js carried its
// own copy that silently diverged from constants.ts/detect.py on non-ASCII paths.

// isSameProjectDir is imported from ../dist/constants.js (shared + unit-tested).

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

// One-shot guard so the "auto-focused a tmux session" notice is pushed once per
// transition into focus, not on every 30s rescan.
let autoFocusNotified = false;

/**
 * Scan all tmux panes for active CC sessions and update the registry.
 * A pane is considered a CC session if its cwd has a corresponding
 * ~/.claude/projects/<encoded>/*.jsonl file.
 */
function scanTmuxForCC() {
  try {
    const output = execFileSync('tmux', [
      'list-panes', '-a',
      '-F', '#{session_name}:#{window_index}.#{pane_index}|#{pane_id}|#{window_name}|#{pane_current_path}|#{pane_pid}',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

    const reg = readSessions();
    const now = Date.now();
    const activeTmuxTargets = new Set();
    const activePaneIds = new Set();
    // Every pane that EXISTS, before the agent-detection filter. Prune uses
    // this: an entry whose pane is still alive is kept even when detection
    // temporarily fails (agent launched via a wrapper, pgrep hiccup, agent
    // restarting) — killing a live session's registration would drop messages
    // and abandon its in-flight turn.
    const existingPaneIds = new Set();
    const existingTmuxTargets = new Set();

    for (const line of output.trim().split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split('|');
      if (parts.length < 5) continue;
      const [tmuxStr, paneId, windowName, cwd, panePid] = parts;
      existingPaneIds.add(paneId);
      existingTmuxTargets.add(tmuxStr);
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
      activePaneIds.add(paneId);

      // Codex rollouts have no /rename custom-title, so never read one for codex.
      const useCustomTitle = (reliable) => kind === 'claude' && reliable;

      // Already registered — refresh transcript path and lastSeen. Match by the
      // stable pane id first (survives window moves/renames); fall back to tmux
      // coordinates for entries the attach writer created before the first scan.
      const existing = Object.entries(reg.sessions).find(([, s]) => s.paneId === paneId)
        ?? Object.entries(reg.sessions).find(([, s]) => !s.paneId && s.tmux === tmuxStr);
      if (existing) {
        reg.sessions[existing[0]].lastSeen = now;
        reg.sessions[existing[0]].kind = kind;
        reg.sessions[existing[0]].paneId = paneId;   // authoritative each pass (heals pane-id reuse)
        reg.sessions[existing[0]].tmux = tmuxStr;    // coordinates may drift as windows move
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

      reg.sessions[name] = { tmux: tmuxStr, paneId, cwd, transcriptPath, kind, lastSeen: now };
      logger.info(`Auto-discovered ${kind} session: ${name} [${tmuxStr} ${paneId}]`);

      // A pane outside the /fc focus gets no topic — surface it in General so
      // the user still learns it exists. (Restored entries match by paneId
      // above and never reach this branch, so restarts don't spam.)
      const focus = effectiveFocus(reg);
      if (focus && transport?.caps.topics && tmuxSessionOf(reg.sessions[name]) !== focus) {
        const home = transport.homeTarget?.();
        if (home) {
          transport.sendText(home,
            `🆕 发现新会话 ${name}（tmux 会话 ${tmuxSessionOf(reg.sessions[name])}，不在聚焦的 ${focus} 内，未创建话题）— /fc 可切换聚焦`,
          ).catch(() => {});
        }
      }
    }

    // Prune sessions whose PANE is gone (not merely "agent not detected") and
    // that haven't been seen in 2 scan intervals. A pruned session's topic is
    // closed (kept in the group with its history) and tombstoned so a
    // reappearing session under the same name reopens it instead of duplicating.
    for (const [name, s] of Object.entries(reg.sessions)) {
      const seen = s.paneId ? activePaneIds.has(s.paneId) : activeTmuxTargets.has(s.tmux);
      const paneAlive = s.paneId ? existingPaneIds.has(s.paneId) : existingTmuxTargets.has(s.tmux);
      if (seen || paneAlive) {
        if (paneAlive && !seen) s.lastSeen = s.lastSeen || now; // keep, but don't refresh lastSeen
        continue;
      }
      if (!seen && now - (s.lastSeen || 0) > SCAN_INTERVAL * 2) {
        logger.info(`Removing stale session: ${name}`);
        if (reg.active === name) reg.active = null;
        if (s.imTarget) {
          reg.closedTopics = reg.closedTopics || {};
          reg.closedTopics[name] = s.imTarget;
          if (transport?.topics && transport.caps.topics) {
            transport.topics.close(s.imTarget).catch(() => {});
          }
        }
        destroyState(sessionKeyFor(s), 'tmux 会话已关闭');
        delete reg.sessions[name];
      }
    }

    // A focus whose tmux session vanished entirely would filter out every
    // topic; drop it so the group falls back to showing all sessions.
    if (reg.focusedTmuxSession
        && !Object.values(reg.sessions).some(s => tmuxSessionOf(s) === reg.focusedTmuxSession)) {
      logger.info('Focused tmux session vanished, clearing focus', { focus: reg.focusedTmuxSession });
      reg.focusedTmuxSession = null;
      autoFocusNotified = false; // announce the next auto-focus transition
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

    // Focus is sticky (there is no "unfocus"): whenever more than one tmux
    // session is live but none is focused — a fresh start, or right after the
    // previously focused session vanished (cleared just above) — auto-focus the
    // default-route session's group so we never spread every session's topics
    // across the group at once. One tmux session ⇒ nothing to collapse, leave
    // focus off.
    if (transport?.caps.topics && !effectiveFocus(reg)) {
      const groups = new Set(Object.values(reg.sessions).map(s => tmuxSessionOf(s)));
      if (groups.size > 1) {
        const activeEntry = reg.active ? reg.sessions[reg.active] : null;
        const target = activeEntry ? tmuxSessionOf(activeEntry) : [...groups][0];
        reg.focusedTmuxSession = target;
        logger.info('Auto-focused tmux session (multi-session, none focused)', { focus: target });
        if (!autoFocusNotified) {
          autoFocusNotified = true;
          const home = transport.homeTarget?.();
          if (home) {
            transport.sendText(home,
              `🎯 检测到多个 tmux 会话，已自动聚焦 ${target}（其余话题已收起，切回时重建）。/fc 切换。`,
            ).catch(() => {});
          }
        }
      }
    }

    writeSessions(reg);
    reconcileStates(reg);
    syncSessionTopics().catch(err => logger.debug('topic sync error', { error: err.message }));
  } catch (err) {
    logger.debug('tmux scan error', { error: err.message });
  }
}

/**
 * Align the runtime SessionState map with the registry after a scan: rename
 * states whose entry was renamed, migrate states stranded on a pre-paneId
 * fallback key (the scan just stamped paneId, changing sessionKeyFor), drop
 * states whose entry genuinely disappeared.
 */
function reconcileStates(reg) {
  const byKey = new Map();      // current key → name
  const migrations = new Map(); // legacy tmux-coords key → [current key, name]
  for (const [name, s] of Object.entries(reg.sessions)) {
    const key = sessionKeyFor(s);
    byKey.set(key, name);
    if (s.paneId) migrations.set(`tmux:${s.tmux}`, [key, name]);
  }
  for (const [key, sess] of [...sessionStates]) {
    let name = byKey.get(key);
    if (!name && migrations.has(key)) {
      const [newKey, newName] = migrations.get(key);
      const dupe = sessionStates.get(newKey);
      if (!dupe) {
        sessionStates.delete(key);
        sess.key = newKey;
        sessionStates.set(newKey, sess);
        persistStates();
        name = newName;
        logger.info('Migrated session state to pane key (scan)', { name, key: newKey });
      } else if (!dupe.lastInjectedText && sess.lastInjectedText) {
        // A fresh idle duplicate was created under the new key before this
        // reconcile ran — the legacy state carries the real in-flight turn, so
        // it wins; retire the duplicate quietly.
        stopTurnStatus(dupe);
        cancelPending(dupe);
        sidToState.delete(dupe.sid);
        sessionStates.delete(key);
        sess.key = newKey;
        sessionStates.set(newKey, sess);
        persistStates();
        name = newName;
        logger.info('Merged legacy in-flight state over idle duplicate', { name });
      } else {
        // Legacy state is idle (or both carry turns — keep the pane-keyed one,
        // it received the newer events). Retire it without the "gone" notice.
        stopTurnStatus(sess);
        cancelPending(sess);
        sess.lastInjectedText = null;
        sidToState.delete(sess.sid);
        sessionStates.delete(key);
        persistStates();
        continue;
      }
    }
    if (!name) destroyState(key, '会话已不在注册表');
    else if (sess.name !== name) sess.name = name;
  }
}

// ── Forum topics lifecycle ───────────────────────────────────────────
// After every scan, make the bound Telegram group's topics mirror the registry:
// each session in focus gets its own topic (reopening a tombstoned one when a
// session reappears), renames propagate, and sessions outside a /fc focus get
// their topic deleted. Serialised — a slow Telegram call must not overlap the
// next scan's sync.
let topicSyncBusy = false;
let topicRightsWarned = false;
// Dead-thread forensics: thread target → session name for topics that were
// deleted (focus purge or user deletion). handleTopicSendError consults this
// when the registry binding was already cleared — a late reply from a turn
// that outlived its topic must still re-route to General instead of dying in
// retries against the dead thread. In-memory only: after a daemon restart the
// (rare) purged-mid-turn reply just falls back to plain retries.
const purgedTopicNames = new Map();

/** Sessions whose topic must not be deleted right now: an in-flight or queued
 *  turn would aim its reply at the thread this sync just destroyed. */
function busySessionNames(reg) {
  const busy = new Set();
  for (const [name, s] of Object.entries(reg.sessions)) {
    const st = sessionStates.get(sessionKeyFor(s));
    if (st && (st.busy || st.lastInjectedText || st.pendingQueue.length > 0)) busy.add(name);
  }
  return busy;
}

async function syncSessionTopics() {
  if (!transport?.topics || !transport.caps.topics) return;
  if (topicSyncBusy) return;
  topicSyncBusy = true;
  try {
    const regNow = readSessions();
    const ops = planTopicSync(regNow, busySessionNames(regNow));
    for (const op of ops) {
      try {
        if (op.op === 'create') {
          const imTarget = await transport.topics.create(op.name);
          applyTopicResult(op.name, imTarget);
          const fresh = readSessions().sessions[op.name];
          if (fresh) {
            transport.sendText(imTarget,
              `🆕 已连接会话 ${op.name}（${sessionKind(fresh)}）\n📁 ${fresh.cwd}\n\n在此话题内发消息即发送到该会话，回复也只出现在这里。`,
            ).catch(() => {});
            // Recreated after a purge (/fc switch or user deletion): the old
            // thread's history is gone, so replay recent rounds into the fresh one.
            if (op.replay && fresh.transcriptPath) {
              const replay = contextReplayFor(sessionKind(fresh), fresh.transcriptPath);
              for (const chunk of splitMessage(replay, transport.caps.maxMessageLen)) {
                await transport.sendText(imTarget, chunk).catch(() => {});
              }
            }
          }
        } else if (op.op === 'reopen') {
          // Best-effort: reopening an already-open or user-deleted topic fails
          // harmlessly; a deleted topic is recreated on the next send failure.
          await transport.topics.reopen(op.imTarget).catch(() => {});
          applyTopicResult(op.name, op.imTarget);
        } else if (op.op === 'rename') {
          await transport.topics.rename(op.imTarget, op.name);
          applyTopicResult(op.name, op.imTarget);
        } else if (op.op === 'remove') {
          try {
            await transport.topics.remove(op.imTarget);
          } catch (err) {
            const m = err?.message || String(err);
            // Already gone (the user deleted it first): treat as success so the
            // binding is cleared — otherwise this op re-fails every 30s forever
            // and the entry stays bound to a dead thread, blocking recreation.
            if (!/thread not found|TOPIC_DELETED/i.test(m)) throw err;
          }
          applyTopicRemoved(op.name, op.imTarget);
        }
      } catch (err) {
        const m = err?.message || String(err);
        logger.warn('Topic sync op failed', { op: op.op, name: op.name, error: m });
        // Missing "Manage Topics" admin right → tell the user once, in General.
        if (/not enough rights|CHAT_ADMIN_REQUIRED|administrator/i.test(m) && !topicRightsWarned) {
          topicRightsWarned = true;
          const home = transport.homeTarget?.();
          if (home) {
            transport.sendText(home,
              '⚠️ 无法创建话题：请把 bot 设为本群管理员并勾选「管理话题」权限，之后会自动重试。',
            ).catch(() => {});
          }
        }
      }
    }
  } finally {
    topicSyncBusy = false;
  }
}

/** Persist a topic op result, re-reading the registry to avoid clobbering a concurrent scan. */
function applyTopicResult(name, imTarget) {
  const reg = readSessions();
  if (reg.sessions[name]) {
    reg.sessions[name].imTarget = imTarget;
    reg.sessions[name].topicName = name;
    delete reg.sessions[name].topicPurged;
    if (reg.closedTopics && reg.closedTopics[name] === imTarget) delete reg.closedTopics[name];
  } else {
    // The entry was renamed/pruned while the Telegram call was in flight —
    // tombstone the topic so a session reappearing under this name reuses it
    // instead of leaving an orphan; close it in the group meanwhile.
    reg.closedTopics = reg.closedTopics || {};
    reg.closedTopics[name] = imTarget;
    if (transport?.topics) transport.topics.close(imTarget).catch(() => {});
  }
  writeSessions(reg);
}

/** Persist a focus-driven topic deletion: unbind the dead thread and mark the
 *  entry so a topic created for it later gets a context replay. */
function applyTopicRemoved(name, imTarget) {
  purgedTopicNames.set(imTarget, name);
  const reg = readSessions();
  const s = reg.sessions[name];
  if (s && s.imTarget === imTarget) {
    delete s.imTarget;
    delete s.topicName;
    s.topicPurged = true;
    writeSessions(reg);
  }
}

/**
 * A send into a session's topic failed. Two distinct causes:
 *  - TOPIC_CLOSED: the topic still exists but is closed (e.g. a send raced the
 *    reopen after a session reappeared) → reopen it and let the caller retry.
 *    Recreating here would leave a duplicate closed topic behind.
 *  - thread not found / TOPIC_DELETED: the topic is gone (user deletion, or an
 *    /fc focus purge racing an in-flight reply) → clear the binding so the next
 *    sync recreates it (focused sessions only), and return the session's name
 *    so the caller can re-route the undeliverable text instead of dropping it.
 * Returns { name } when the thread is dead, null otherwise (the closed case
 * returns null so the caller's retry can land after the reopen).
 */
function handleTopicSendError(target, err) {
  const m = err?.message || String(err);
  if (/TOPIC_CLOSED/i.test(m)) {
    if (transport?.topics) transport.topics.reopen(target).catch(() => {});
    return null; // let the caller's retry re-send into the reopened topic
  }
  if (!/thread not found|TOPIC_DELETED/i.test(m)) return null;
  const reg = readSessions();
  let hit = null;
  for (const [name, s] of Object.entries(reg.sessions)) {
    if (s.imTarget === target) {
      delete s.imTarget;
      delete s.topicName;
      s.topicPurged = true; // replay context into the recreated thread
      if (reg.closedTopics) delete reg.closedTopics[name];
      hit = name;
      logger.info('Topic gone, will recreate on next sync', { name });
    }
  }
  if (hit) {
    purgedTopicNames.set(target, hit);
    writeSessions(reg);
    syncSessionTopics().catch(() => {});
    return { name: hit };
  }
  // Binding already cleared (a focus purge beat this send, or an earlier chunk
  // of the same reply cleared it) — the dead-thread map still knows the owner.
  const purged = purgedTopicNames.get(target);
  return purged ? { name: purged } : null;
}

// ── Multi-session: WeChat bridge commands ────────────────────────────

function formatSessionList(reg) {
  const names = orderedSessionNames(reg);
  if (names.length === 0) return '暂无发现活跃的会话（等待自动扫描，约30秒）';
  const home = homedir();
  const focus = effectiveFocus(reg);
  const topics = !!transport?.caps.topics;
  // Always render as a tree: tmux session headers with their cc/codex sessions
  // indented beneath, rather than one flat spread.
  const lines = ['📋 Sessions:'];
  let lastGroup = null;
  names.forEach((name, i) => {
    const s = reg.sessions[name];
    const group = tmuxSessionOf(s);
    if (group !== lastGroup) {
      lastGroup = group;
      const mark = group === focus ? ' 🎯' : '';
      // Only the topics transport hides out-of-focus groups; WeChat has no topics.
      const hidden = topics && focus && group !== focus ? '（话题已收起）' : '';
      lines.push(`▸ tmux: ${group}${mark}${hidden}`);
    }
    const sess = getStateFor(name, s);
    const busy = (sess.busy || sess.lastInjectedText) ? '🔵' : '⚪';
    const marker = name === reg.active ? '▶' : '○';
    const shortPath = s.cwd.replace(home, '~');
    const queued = sess.pendingQueue.length ? ` · 排队 ${sess.pendingQueue.length}` : '';
    lines.push(`   ${marker} ${i + 1}. ${busy} ${name} (${sessionKind(s)})${queued}`);
    lines.push(`      ${shortPath}`);
  });
  lines.push(`\n默认路由: ${reg.active || '无'}`);
  if (focus) lines.push(`🎯 聚焦: ${focus}（其余话题已收起，切回时重建；/fc 切换）`);
  if (topics) lines.push('每个会话有独立话题，进入话题即可对话');
  lines.push('切换默认: /sw <名字/序号>；改名: /rename <新名字>；聚焦: /fc');
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
async function injectSlashAndCapture(sess, target, command, send) {
  // Serialize per session: two captures racing the SAME pane within the 2.5s
  // window interleave their pane reads and the bottom-up echo match
  // duplicates/garbles output. Distinct sessions may capture concurrently.
  if (sess.slashCaptureBusy) {
    await send('⏳ 上一个命令还在执行，请稍候重试');
    return;
  }
  sess.slashCaptureBusy = true;
  try {
    await injectSlashAndCaptureInner(sess, target, command, send);
  } finally {
    sess.slashCaptureBusy = false;
  }
}

async function injectSlashAndCaptureInner(sess, target, command, send) {
  const beforeContent = capturePaneContent(target);
  const beforeLineCount = beforeContent.trimEnd().split('\n').length;

  try {
    sendKeys(target, command, sess.key);
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

  appendHistory({ type: 'slash_command', session: sess.name, command, output: output?.slice(0, 200) });
}

/**
 * Inline-keyboard rows for the session list. Topics mode adds a deep link
 * straight into each session's topic; the switch button moves the default
 * route (used by the General topic / private chat).
 */
function sessionButtons(reg) {
  return orderedSessionNames(reg).map((name, i) => {
    const s = reg.sessions[name];
    const sess = getStateFor(name, s);
    const busy = (sess.busy || sess.lastInjectedText) ? '🔵' : '⚪';
    const marker = name === reg.active ? '▶ ' : '';
    const row = [{ label: `${marker}${busy} ${i + 1}. ${name} (${sessionKind(s)})`, data: `sw:${sess.sid}` }];
    if (transport?.caps.topics && s.imTarget && transport.topics) {
      const url = transport.topics.link(s.imTarget);
      if (url) row.push({ label: '↗ 进入话题', url });
    }
    return row;
  });
}

/** Inline-keyboard rows for the model list (one button per model, bound to a session). */
function modelButtons(sess, models, current) {
  return models.map((m, i) => [{ label: `${m.id === current ? '✅ ' : ''}${i + 1}. ${m.display}`, data: `model:${sess.sid}:${i}` }]);
}

/**
 * Move the default-route pointer to another session (shared by the #sw command
 * and the sw:<sid> button callback). Sessions run independent turns now, so a
 * switch touches NOTHING about any session's in-flight state — the old
 * session's queue keeps draining and its responses still land in the
 * conversation that sent them; hook events route by pane id, not by "active".
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

// ── /fc: tmux-session focus ──────────────────────────────────────────
// One tmux session ≈ one project. /fc collapses the group's topic list to just
// the focused session's panes by DELETING every other topic (Telegram offers
// no true per-topic hide: close only greys a topic out, it stays in the list).
// Deleted topics are recreated with a context replay on refocus. Focus filters
// topic visibility ONLY — the default route (#sw) and in-flight turns are
// untouched.
// Focus is STICKY: /fc only switches which session is focused, there is no
// "unfocus"/"show all" (spreading every session's topics at once is the bad UX
// this feature exists to avoid). The scanner auto-focuses the default-route
// session's group whenever >1 session is live and none is focused.
let fcMenu = null; // { names: string[], expires: number } — snapshot behind fc:<idx> callbacks
const FC_MENU_TTL = 15 * 60 * 1000;

/** Registry names grouped by tmux session, in orderedSessionNames order. */
function tmuxGroups(reg) {
  const groups = new Map();
  for (const name of orderedSessionNames(reg)) {
    const g = tmuxSessionOf(reg.sessions[name]);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(name);
  }
  return groups;
}

// Shared by /ls and the bare /fc menu: one line per tmux session, members
// inline. Focus markers only exist in topics mode; WeChat / unbound chats get
// a plain numbered list.
function formatTmuxList(reg) {
  const groups = tmuxGroups(reg);
  if (groups.size === 0) return '暂无发现活跃的会话（等待自动扫描，约30秒）';
  const topics = !!transport?.caps.topics;
  const focus = topics ? effectiveFocus(reg) : null;
  const lines = ['📋 tmux 会话:'];
  let i = 0;
  for (const [g, members] of groups) {
    i++;
    const busyCount = members.filter(n => {
      const st = sessionStates.get(sessionKeyFor(reg.sessions[n]));
      return st && (st.busy || st.lastInjectedText);
    }).length;
    // sendButtons never splits the message — cap the inline member list.
    const shown = members.length > 6 ? [...members.slice(0, 5), `…+${members.length - 5}`] : members;
    const mark = topics ? (g === focus ? '🎯 ' : '○ ') : '';
    lines.push(`${mark}${i}. ${g} — ${shown.join(', ')}${busyCount ? `（${busyCount} 忙碌）` : ''}`);
  }
  lines.push('', `默认路由: ${reg.active || '无'}` + (focus ? ` · 🎯 聚焦: ${focus}` : ''));
  return lines.join('\n');
}

function tmuxButtons(names, focus) {
  return names.map((g, i) => [{ label: `${g === focus ? '🎯 ' : ''}${i + 1}. ${g}`, data: `fc:${i}` }]);
}

/**
 * Probe every existing topic in the focused group and unbind any the user
 * deleted in Telegram (there is no "topic deleted" update, so a stale imTarget
 * otherwise lingers and planTopicSync never recreates the tab). reopen() is the
 * probe: it fails with "thread not found"/TOPIC_DELETED for a dead thread, and
 * for a live one it's a no-op (an open topic just returns TOPIC_NOT_MODIFIED,
 * a closed one is reopened — which is what a focused topic should be anyway).
 * Runs only on user-initiated /fc, so the handful of extra API calls is fine.
 */
async function repairFocusedTopics(groupName) {
  if (!transport?.topics || !transport.caps.topics) return;
  const reg = readSessions();
  const members = tmuxGroups(reg).get(groupName) || [];
  let changed = false;
  for (const name of members) {
    const s = reg.sessions[name];
    if (!s?.imTarget) continue;
    try {
      await transport.topics.reopen(s.imTarget);
    } catch (err) {
      const m = err?.message || String(err);
      if (!/thread not found|TOPIC_DELETED/i.test(m)) continue; // live topic / transient
      delete s.imTarget;
      delete s.topicName;
      s.topicPurged = true; // recreated tab replays recent context
      changed = true;
      logger.info('Focus repair: topic gone, will recreate', { name });
    }
  }
  if (changed) writeSessions(reg);
}

/**
 * Switch the focused tmux session and kick a topic sync. Shared by the #fc
 * command and the fc:<idx> button callback. Focus is sticky — groupName is
 * always a real group (there is no unfocus). The reply goes out before the sync
 * — deleting/recreating many topics can take a while and busy sessions defer
 * their deletion to a later sync anyway.
 */
async function performFocus(groupName, send) {
  const reg = readSessions();
  reg.focusedTmuxSession = groupName;
  writeSessions(reg);
  const members = new Set(tmuxGroups(reg).get(groupName) || []);
  // Count only topics that actually exist and will be deleted.
  const toRemove = Object.entries(reg.sessions)
    .filter(([n, s]) => !members.has(n) && s.imTarget).length;
  await send(
    (toRemove > 0
      ? `🎯 已聚焦 ${groupName}：保留 ${members.size} 个会话话题，收起（删除）其余 ${toRemove} 个，切回时重建并回放上下文。`
      : `🎯 已聚焦 ${groupName}（${members.size} 个会话）。`)
    + `\n默认路由不变: ${reg.active || '无'}`);
  // Recreate any tab the user manually deleted in the (re)focused group before
  // the sync runs, so re-selecting the current focus brings deleted tabs back.
  await repairFocusedTopics(groupName);
  syncSessionTopics().catch(() => {});
  logger.info('Focus switched', { focus: groupName });
}

/**
 * Rename a session everywhere it has a name: the tmux window, the registry key
 * (pinned so rescans never revert it) and the live runtime state. Shared by
 * the #rename command and Telegram-side topic renames; callers validate
 * newName (non-empty, no [:.\t\n], no collision) first. `topicName` (when
 * given) records what the topic currently displays, so the next sync only
 * renames the topic if it actually drifts from the registry name.
 */
function renameSession(reg, oldName, newName, { topicName } = {}) {
  const s = reg.sessions[oldName];
  if (!s) return false;
  // Prefer the pane id — tmux resolves it to the containing window for
  // window-level commands and it survives window moves; coordinates are the
  // pre-paneId fallback. rename-window also disables automatic-rename for the
  // window, so the new name sticks.
  const windowTarget = s.paneId || s.tmux.split('.')[0];
  try {
    execFileSync('tmux', ['rename-window', '-t', windowTarget, newName], { stdio: 'ignore' });
  } catch (err) {
    logger.error('tmux rename-window failed', { error: err.message, target: windowTarget });
    // Non-fatal — the registry rename below still makes #ls/#sw use the new name.
  }
  reg.sessions[newName] = {
    ...s, pinnedName: newName, lastSeen: Date.now(),
    ...(topicName !== undefined ? { topicName } : {}),
  };
  delete reg.sessions[oldName];
  // Follow only when the renamed session IS the default route — renaming a
  // non-active session (e.g. from inside its topic) must not hijack the pointer.
  if (reg.active === oldName) reg.active = newName;
  writeSessions(reg);
  // Refresh the live state's name now instead of waiting ≤30s for the scanner.
  const st = sessionStates.get(sessionKeyFor(s));
  if (st) st.name = newName;
  return true;
}

/**
 * A topic was renamed in the Telegram UI (long-press → Edit): apply it to the
 * bound session's tmux window + registry. The bridge's own editForumTopic
 * calls echo the same service message — absorbed by the name-equality guard,
 * so no rename ping-pong is possible (the bridge only renames a topic when
 * topicName !== registry name, and every path below ends with them equal).
 */
async function handleTopicRename(inbound) {
  const reg = readSessions();
  const routed = resolveSessionForInbound(reg, inbound.target);
  if (!routed?.viaTopic) return; // General / unknown thread — never touch the active fallback
  const oldName = routed.name;
  const raw = (inbound.topicName || '').trim();
  if (!raw || raw === oldName) return; // echo of our own rename, or a no-op
  const newName = sanitizeSessionName(raw);
  if (!newName || newName === oldName) {
    // Nothing usable survives sanitizing (or it sanitizes back to the current
    // name): record what the topic now shows so the next sync renames it back.
    const entry = reg.sessions[oldName];
    if (entry) { entry.topicName = raw; writeSessions(reg); syncSessionTopics().catch(() => {}); }
    return;
  }
  if (reg.sessions[newName]) {
    // Record what the topic now shows and let the drift sync rename it back —
    // unlike a one-shot revert call, the sync retries every cycle if it fails.
    const entry = reg.sessions[oldName];
    if (entry) { entry.topicName = raw; writeSessions(reg); syncSessionTopics().catch(() => {}); }
    transport.sendText(inbound.target, `⚠️ 已存在同名会话「${newName}」，话题名已改回「${oldName}」`).catch(() => {});
    return;
  }
  renameSession(reg, oldName, newName, { topicName: raw });
  logger.info(`Session renamed via topic edit: ${oldName} → ${newName}`);
  transport.sendText(inbound.target, `✅ 已同步重命名 tmux 窗口: ${oldName} → ${newName}`).catch(() => {});
  // raw carried chars we sanitized away → topicName(raw) ≠ name(newName), so
  // kick a sync to converge the topic onto the sanitized form.
  if (raw !== newName) syncSessionTopics().catch(() => {});
}

async function handleBridgeCommand(text, replyTarget, ctxSess) {
  const send = (msg) => transport.sendText(replyTarget, msg)
    .catch(err => logger.error('Bridge command reply failed', { error: err.message }));

  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();

  // #bind — bind the topics supergroup this message came from.
  if (cmd === '#bind') {
    if (!transport.topics) { await send('当前通道不支持话题群绑定'); return; }
    const r = await transport.topics.bind(replyTarget);
    if (r.ok) {
      await send('✅ 已绑定本群为话题群。每个 tmux 会话将自动获得一个专属话题（约 30 秒内出现）。');
      syncSessionTopics().catch(() => {});
    } else {
      await send(`❌ 绑定失败：${r.reason || '未知原因'}`);
    }
    return;
  }

  // #esc — interrupt the context session's current turn (tmux Escape).
  if (cmd === '#esc' || cmd === '#stop') {
    if (!ctxSess) { await send('当前没有会话'); return; }
    const target = tmuxTargetFor(ctxSess);
    if (!target || !paneExists(target)) { await send('❌ tmux 不可用'); return; }
    try {
      sendTmuxKey(target, 'Escape');
      await send(`⏹ 已向 ${ctxSess.name} 发送中断`);
    } catch (err) {
      await send(`❌ 中断失败: ${err.message}`);
    }
    return;
  }

  // #ls / #sessions — compact tmux-session list (tap a button to switch
  // focus). Per-session detail (paths, sw buttons, topic links) lives in /sw.
  if (cmd === '#ls' || cmd === '#sessions') {
    const reg = readSessions();
    const groupNames = [...tmuxGroups(reg).keys()];
    const list = formatTmuxList(reg);
    // Focus buttons only make sense where topics exist; otherwise plain text.
    if (transport.caps.topics && transport.caps.inlineKeyboards && groupNames.length > 0) {
      fcMenu = { names: groupNames, expires: Date.now() + FC_MENU_TTL };
      await transport.sendButtons(replyTarget, list, tmuxButtons(groupNames, effectiveFocus(reg)))
        .catch(err => logger.error('Session list push failed', { error: err.message }));
    } else {
      // No focus buttons on this transport — leave a /sw pointer so the
      // numbered list isn't a dead end (its numbers are /fc's, not /sw's).
      const hint = !transport.caps.topics && groupNames.length > 0 ? '\n切换默认: /sw <名字/序号>' : '';
      await send(list + hint);
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
    // Same ordering as the bare-/sw menu (formatSessionList) and its buttons,
    // so "/sw 3" always means the session shown there as 3. (/ls numbers tmux
    // groups for /fc — different numbering.)
    const names = orderedSessionNames(reg);
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

  // #fc [name|number] — focus one tmux session (see the /fc block above).
  if (cmd === '#fc') {
    if (!transport.caps.topics) {
      await send('话题模式未开启（先在开启「话题」的超级群里 /bind），/fc 无效');
      return;
    }
    const arg = parts.slice(1).join(' ').trim();
    const reg = readSessions();
    const groupNames = [...tmuxGroups(reg).keys()];
    if (!arg) {
      fcMenu = { names: groupNames, expires: Date.now() + FC_MENU_TTL };
      const list = formatTmuxList(reg);
      if (transport.caps.inlineKeyboards && groupNames.length > 0) {
        await transport.sendButtons(replyTarget, list, tmuxButtons(groupNames, effectiveFocus(reg)))
          .catch(err => logger.error('Focus menu push failed', { error: err.message }));
      } else {
        await send(`${list}\n\n用法: /fc <名字/序号>`);
      }
      return;
    }
    let groupName = null;
    const num = parseInt(arg, 10);
    if (!isNaN(num) && num >= 1 && num <= groupNames.length) {
      groupName = groupNames[num - 1];
    } else {
      groupName = groupNames.find(g => g.toLowerCase() === arg.toLowerCase())
        ?? groupNames.find(g => g.toLowerCase().includes(arg.toLowerCase()));
    }
    if (!groupName) { await send(`找不到 tmux 会话: "${arg}"\n\n${formatTmuxList(reg)}`); return; }
    await performFocus(groupName, send);
    return;
  }

  // #rename <newname> — rename the context session (topic → that session;
  // private chat / WeChat → the active session). Renames the tmux window, the
  // registry entry and (topics mode) the forum topic; pinned so periodic
  // rescans won't revert it.
  if (cmd === '#rename' || cmd === '#mv') {
    const newName = parts.slice(1).join(' ').trim();
    if (!newName) { await send('用法: /rename <新名字>'); return; }
    // tmux window targets use ':' and '.' as separators; reject them in names.
    if (/[:.\n\t]/.test(newName)) { await send('名字不能包含 : . 制表符或换行'); return; }

    const reg = readSessions();
    const oldName = ctxSess?.name && reg.sessions[ctxSess.name] ? ctxSess.name : reg.active;
    if (!oldName || !reg.sessions[oldName]) { await send('当前没有活动 session'); return; }
    if (newName === oldName) { await send(`已经叫 ${newName} 了`); return; }
    if (reg.sessions[newName]) { await send(`已存在同名 session: ${newName}`); return; }

    const tmuxCoords = reg.sessions[oldName].tmux;
    renameSession(reg, oldName, newName);
    logger.info(`Session renamed via #rename: ${oldName} → ${newName} [${tmuxCoords}]`);
    await send(`✅ 已重命名: ${oldName} → ${newName} [${tmuxCoords}]`);
    return;
  }

  // #model [selection] — text-based model switcher for the context session
  // (bypasses the TUI).
  if (cmd === '#model') {
    if (!ctxSess) { await send('当前没有会话'); return; }
    const arg = parts.slice(1).join(' ').trim();
    const reg = readSessions();
    const entry = reg.sessions[ctxSess.name];
    const kind = entry ? sessionKind(entry) : 'claude';
    const models = getAgent(kind).models;

    if (!arg) {
      // Claude exposes the current model via settings.json; Codex stores it in
      // config.toml (no marker shown).
      let current = null;
      if (kind === 'claude') {
        const settings = readJson(join(CLAUDE_CONFIG_DIR, 'settings.json'), {});
        current = settings.model || 'claude-sonnet-4-6';
      }
      ctxSess.pendingSelect = { type: 'model', expires: Date.now() + 5 * 60 * 1000 };
      // Tap-able buttons (Telegram) or a numbered text menu (WeChat).
      if (transport.caps.inlineKeyboards) {
        await transport.sendButtons(replyTarget, `🤖 为 ${ctxSess.name} 选择模型（5 分钟内有效）:`, modelButtons(ctxSess, models, current))
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

    ctxSess.pendingSelect = null;
    const target = tmuxTargetFor(ctxSess);
    if (!target || !paneExists(target)) {
      await send('❌ tmux 不可用');
      return;
    }
    // Both Claude and Codex accept `/model <id>` as a direct argument.
    await injectSlashAndCapture(ctxSess, target, `/model ${resolved.id}`, send);
    return;
  }

  await send(`未知指令: ${text}\n可用:\n  /ls — 列出 tmux 会话\n  /sw <名字/序号> — 切换默认路由\n  /fc <名字/序号> — 聚焦 tmux 会话（其余话题收起，切回重建）\n  /rename <新名字> — 重命名\n  /model — 切换模型\n  /esc — 中断当前回合\n  /bind — 在话题群里绑定`);
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

  // All callback payloads are sid-scoped (`<verb>:<sid>:...`): the sid pins the
  // tap to the SESSION that produced the buttons, so concurrent sessions can
  // show menus/quizzes at the same time without cross-talk. A sid from before a
  // daemon restart resolves to nothing → graceful "expired" ack.
  const segs = data.split(':');
  const verb = segs[0];
  const sess = sidToState.get(parseInt(segs[1], 10)) ?? null;

  // ── intr:<sid> — interrupt button on the live status message ──
  if (verb === 'intr') {
    if (!sess) { ack('该会话已不存在'); return; }
    const tmux = tmuxTargetFor(sess);
    if (!tmux || !paneExists(tmux)) { ack('tmux 不可用'); return; }
    try {
      sendTmuxKey(tmux, 'Escape');
      ack(`已向 ${sess.name} 发送中断`);
      logger.info('Interrupt sent via status button', { session: sess.name });
    } catch (err) {
      ack('中断失败');
      logger.error('Interrupt failed', { error: err.message });
    }
    return;
  }

  // ── model:<sid>:<idx> ──
  if (verb === 'model') {
    if (!sess || !sess.pendingSelect || sess.pendingSelect.type !== 'model' || Date.now() > sess.pendingSelect.expires) {
      if (sess) sess.pendingSelect = null;
      ack('菜单已过期'); return;
    }
    const idx = parseInt(segs[2], 10);
    const reg = readSessions();
    const entry = reg.sessions[sess.name];
    const kind = entry ? sessionKind(entry) : 'claude';
    const models = getAgent(kind).models;
    if (isNaN(idx) || idx < 0 || idx >= models.length) { ack('无效选项'); return; }
    const resolved = models[idx];
    sess.pendingSelect = null;
    ack(`切换到 ${resolved.display}`);
    const tmux = tmuxTargetFor(sess);
    if (tmux && paneExists(tmux)) await injectSlashAndCapture(sess, tmux, `/model ${resolved.id}`, send);
    else send('❌ tmux 不可用');
    return;
  }

  // ── sw:<sid> ──
  if (verb === 'sw') {
    if (!sess || !readSessions().sessions[sess.name]) { ack('该 session 已不存在'); return; }
    ack(`切换到 ${sess.name}`);
    await performSwitch(sess.name, send);
    return;
  }

  // ── fc:<idx> — focus a tmux session from the /fc menu ──
  // (Not sid-scoped: the payload indexes the fcMenu snapshot taken when the
  // menu was sent; a stale/pre-restart tap lands on the expired ack.)
  if (verb === 'fc') {
    if (!fcMenu || Date.now() > fcMenu.expires) { ack('菜单已过期'); return; }
    const groupName = fcMenu.names[parseInt(segs[1], 10)];
    if (!groupName) { ack('无效选项'); return; }
    ack(`🎯 已聚焦 ${groupName}`);
    await performFocus(groupName, send);
    return;
  }

  // ── quiz:<sid>:<qIdx>:<optIdx|done> ──
  if (verb === 'quiz') {
    if (!sess || !sess.pendingQuiz || Date.now() > sess.pendingQuiz.expires) {
      if (sess) sess.pendingQuiz = null;
      ack('问卷已过期'); return;
    }
    const quiz = sess.pendingQuiz;
    const qIdx = parseInt(segs[2], 10);
    const rest = segs[3];
    if (qIdx !== quiz.questionIndex) { ack('该问题已过期'); return; }
    const q = quiz.questions[quiz.questionIndex];
    const tmux = tmuxTargetFor(sess);

    if (q.multiSelect) {
      if (rest === 'done') {
        const sel = [...(quiz.selected || new Set())].sort((a, b) => a - b);
        if (sel.length === 0) { ack('请至少选择一项'); return; }
        if (!tmux || !paneExists(tmux)) { ack('tmux 不可用'); send('❌ tmux 不可用'); sess.pendingQuiz = null; return; }
        try {
          const selected = injectQuizAnswer(tmux, q, sel.map(n => n + 1).join(','));
          ack('已提交'); send(`✅ ${selected}`);
          appendHistory({ type: 'quiz_answer', session: sess.name, question: q.question, answer: selected });
        } catch (err) { ack('注入失败'); send(`❌ 注入失败: ${err.message}`); }
        advanceQuiz(sess, replyTarget);
        return;
      }
      const optIdx = parseInt(rest, 10);
      if (isNaN(optIdx) || optIdx < 0 || optIdx >= q.options.length) { ack('无效选项'); return; }
      if (!quiz.selected) quiz.selected = new Set();
      if (quiz.selected.has(optIdx)) quiz.selected.delete(optIdx);
      else quiz.selected.add(optIdx);
      const chosen = [...quiz.selected].sort((a, b) => a - b).map(i => q.options[i].label).join(', ');
      ack(chosen ? `已选: ${chosen}` : '已清空');
      return;
    }

    // single-select
    const optIdx = parseInt(rest, 10);
    if (isNaN(optIdx) || optIdx < 0 || optIdx >= q.options.length) { ack('无效选项'); return; }
    if (!tmux || !paneExists(tmux)) { ack('tmux 不可用'); send('❌ tmux 不可用'); sess.pendingQuiz = null; return; }
    try {
      const selected = injectQuizAnswer(tmux, q, String(optIdx + 1));
      ack(selected); send(`✅ ${selected}`);
      appendHistory({ type: 'quiz_answer', session: sess.name, question: q.question, answer: selected });
    } catch (err) { ack('注入失败'); send(`❌ 注入失败: ${err.message}`); }
    advanceQuiz(sess, replyTarget);
    return;
  }

  ack(); // unknown callback — just clear the client spinner
}

// ── Injection state machine (per session) ────────────────────────────
function cancelPending(sess) {
  if (sess.injectTimer) { clearTimeout(sess.injectTimer); sess.injectTimer = null; }
}

function scheduleInject(sess) {
  cancelPending(sess);
  // One turn at a time PER SESSION: never inject while this session's previous
  // message is still awaiting its response (lastInjectedText set). The Stop
  // handler clears it and re-calls scheduleInject(sess) to drain the queue in
  // order. Other sessions inject in parallel — each pane is independent.
  if (sess.lastInjectedText) return;
  if (sess.pendingQueue.length === 0) return;
  sess.injectTimer = setTimeout(() => {
    sess.injectTimer = null;
    if (sess.lastInjectedText || sess.pendingQueue.length === 0) return;
    const reg = readSessions();
    const entry = reg.sessions[sess.name];
    const target = entry ? (entry.paneId || entry.tmux) : null;
    if (!target || !paneExists(target)) {
      logger.warn('Cannot inject: tmux target unavailable', { session: sess.name, target });
      return;
    }
    const item = sess.pendingQueue.shift();
    try {
      sendKeys(target, item.text, sess.key);
      sess.lastInjectedText       = item.text;
      sess.lastInjectedTranscript = entry.transcriptPath || null;
      sess.injectedTarget         = item.target;
      sess.injectedMessageId      = item.messageId || '';
      persistStates();
      appendHistory({ type: 'user_wechat', session: sess.name, text: item.text });
      reactTo(item.target, item.messageId, '👀');
      startTurnStatus(sess);  // live status / progress pings until this turn resolves
      logger.info('Injected message', { session: sess.name, chars: item.text.length, queued: sess.pendingQueue.length, transcript: sess.lastInjectedTranscript?.slice(-40) });
    } catch (err) {
      // Re-queue at the head so the message is not lost on a transient tmux error.
      sess.pendingQueue.unshift(item);
      logger.error('tmux inject failed', { session: sess.name, error: err.message });
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
      // The topic is gone (user deletion / /fc focus purge) — stop retrying the
      // dead thread and deliver to the General topic instead, tagged with the
      // session of origin, so the reply is not silently lost.
      const gone = handleTopicSendError(target, err);
      if (gone) {
        const home = transport.homeTarget?.();
        if (home && home !== target) {
          try {
            await transport.sendText(home, `【${gone.name}】\n${text}`);
            return true;
          } catch (homeErr) {
            logger.warn('General-topic fallback send failed', { error: homeErr.message });
          }
        }
        return false;
      }
      if (i < attempts) { await new Promise(r => setTimeout(r, delay)); delay *= 2; }
    }
  }
  logger.error('sendText permanently failed after retries', { chars: text.length });
  return false;
}

// Responses beyond this many characters arrive as a Markdown FILE (one tap to
// open, no 10-chunk wallpaper) on transports that support documents.
const DOC_THRESHOLD = 8_000;

/**
 * Forward a full assistant response to a captured reply target. Very long
 * responses go as a .md document (with the head as caption); everything else
 * is split into chunks (prefixed [i/n] when more than one), each sent with
 * retry. On any permanent chunk failure, send one best-effort notice.
 */
async function forwardResponse(target, fullText, opts = {}) {
  if (fullText.length > DOC_THRESHOLD && transport.caps.documents && transport.sendDocument) {
    const caption = `📄 回复较长（${fullText.length} 字符），已作为文件发送\n\n${fullText.slice(0, 200)}…`;
    try {
      await transport.sendDocument(target, {
        filename: opts.filename || `response-${Date.now()}.md`,
        content: fullText,
        caption: caption.slice(0, 900), // TG caption hard limit is 1024
      });
      return;
    } catch (err) {
      logger.warn('sendDocument failed, falling back to chunks', { error: err.message });
    }
  }
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
function pushResponse(sess, responseText) {
  const target = sess.injectedTarget || lastTarget;
  const messageId = sess.injectedMessageId;
  // Final status-message edit: turn summary replaces the live progress line.
  finishTurnStatus(sess, `✅ 完成 · ${sess.turnToolCount} 个工具 · ${fmtDur(Date.now() - sess.turnStartedAt)}`);
  if (transport && target) transport.sendTyping(target, false).catch(() => {});
  reactTo(target, messageId, '👍');
  sess.lastPushedText         = responseText;
  sess.lastInjectedText       = null;
  sess.lastInjectedTranscript = null;
  sess.injectedTarget         = '';
  sess.injectedMessageId      = '';
  persistStates();
  appendHistory({ type: 'assistant', session: sess.name, text: responseText.slice(0, 500) });
  // target is always set in the normal flow (every queued message carries one),
  // but guard defensively so we never call forwardResponse with an empty target.
  if (!target) {
    logger.error('pushResponse: no reply target, dropping forward', { chars: responseText.length });
    return;
  }
  // Private-chat / WeChat fallback: several sessions share one conversation, so
  // tag the response with its origin. Topic-routed replies need no tag.
  let out = responseText;
  const reg = readSessions();
  const entry = reg.sessions[sess.name];
  const viaTopic = !!(entry?.imTarget && entry.imTarget === target);
  if (!viaTopic && Object.keys(reg.sessions).length > 1) {
    out = `【${sess.name}】\n${responseText}`;
  }
  forwardResponse(target, out, { filename: docFilename(sess.name) });
}

/** Safe .md filename for a session's long response. */
function docFilename(name) {
  const safe = (name || 'session').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'session';
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${safe}-${ts}.md`;
}

/**
 * Give up on a session's in-flight turn (orphan-poll deadline / idle cleanup):
 * clear the turn state, mark the user's message 💔, and drain the queue.
 */
function abandonTurn(sess, reason) {
  const target = sess.injectedTarget || lastTarget;
  finishTurnStatus(sess, `⚠️ ${reason || '未捕获到回复'}`);
  if (transport && target) transport.sendTyping(target, false).catch(() => {});
  reactTo(target, sess.injectedMessageId, '💔');
  sess.lastInjectedText       = null;
  sess.lastInjectedTranscript = null;
  sess.injectedTarget         = '';
  sess.injectedMessageId      = '';
  persistStates();
  scheduleInject(sess);
}

/**
 * Codex Stop handler. Codex rollouts use a different JSONL schema and the Stop
 * payload carries `last_assistant_message`. We forward only WeChat-initiated
 * turns: gate on the rollout's latest user_message matching what we injected,
 * since Codex also fires Stop for turns the user types at the terminal.
 */
function onStopCodex(sess, payload, readPath) {
  if (!sess.lastInjectedText) {
    logger.info('Codex Stop with no injected message, ignoring');
    scheduleInject(sess);
    return;
  }
  const agent = getAgent('codex');
  const entries = agent.parseRollout(readPath);
  const latestUser = agent.latestUserMessage(entries);
  const injected = sess.lastInjectedText;

  // Gate against terminal-initiated turns. If the rollout's most recent user
  // message exists and isn't ours, this Stop belongs to a terminal turn — leave
  // lastInjectedText set; our own turn's Stop will arrive later.
  if (latestUser !== null && latestUser !== injected) {
    logger.debug('Codex Stop for terminal-initiated turn, ignoring', { latestUser: latestUser.slice(0, 60) });
    return;
  }

  const pickText = (eList) => {
    const r = agent.responseToInjected(eList, injected);
    if (r?.text) return r.text;
    if (typeof payload.last_assistant_message === 'string' && payload.last_assistant_message.trim()) {
      return payload.last_assistant_message.trim();
    }
    return null;
  };

  const text = pickText(entries);
  if (text) {
    pushResponse(sess, text);
    logger.info('Pushed codex response', { chars: text.length });
    scheduleInject(sess);
    return;
  }

  // No response text yet — rollout may not be flushed. Defer with a bounded poll
  // (Codex has no Notification event to act as a later safety net).
  armOrphanPoll(sess, injected, () => pickText(agent.parseRollout(readPath)), 60_000, 5_000);
  scheduleInject(sess);
}

/**
 * Does `tpath` actually contain our injected user message? Used to gate the
 * "same project dir, different file" acceptance: without this, a late Stop from
 * a DIFFERENT session sharing the cwd (e.g. right after #sw) is wrongly accepted
 * and the response search runs against the wrong transcript (H4).
 */
function transcriptHasInjectedUser(tpath, injectedText) {
  if (!tpath || !injectedText) return false;
  return transcriptHasUserText(parseTranscript(tpath, TRANSCRIPT_TAIL_BYTES), injectedText);
}

/**
 * Arm a bounded poll that resolves (or, at the deadline, abandons) a session's
 * in-flight injected turn whose Stop we may never receive — e.g. the daemon was
 * down when the agent finished, or a missed end_turn. Without this, a
 * restored-on-startup lastInjectedText (see main()) would stay set forever and
 * scheduleInject() would perpetually no-op, silently swallowing every future
 * message for that session. The ONE orphan-poll implementation for both agents:
 * `probe` returns the response text (or null) — the Claude default reads the
 * transcript via findResponseToInjected; Codex passes a rollout probe. Deduped
 * per session on orphanPollText so only one chain runs per injected message.
 */
function armOrphanPoll(sess, savedInjectedText, probe, graceMs = 5 * 60 * 1000, pollMs = 5_000) {
  if (!savedInjectedText) return;
  if (sess.orphanPollText === savedInjectedText) return; // already polling this turn
  sess.orphanPollText = savedInjectedText;
  const deadline = Date.now() + graceMs;
  const poll = () => {
    if (sess.lastInjectedText !== savedInjectedText) { sess.orphanPollText = null; return; } // resolved elsewhere
    const text = probe();
    if (text) {
      sess.orphanPollText = null;
      pushResponse(sess, text);
      logger.info('Pushed response via orphan poll', { session: sess.name, chars: text.length });
      scheduleInject(sess);
      return;
    }
    if (Date.now() >= deadline) {
      logger.warn('Orphan poll grace expired, cleaning up', { session: sess.name, lastInjected: savedInjectedText.slice(0, 60) });
      sess.orphanPollText = null;
      if (sess.lastInjectedText === savedInjectedText) abandonTurn(sess, '未在时限内捕获到回复，请回终端查看');
      return;
    }
    setTimeout(poll, pollMs);
  };
  setTimeout(poll, pollMs);
}

/** Standard Claude transcript probe for armOrphanPoll. */
function claudeProbe(readPath, injectedText) {
  return () => {
    if (!readPath) return null;
    const r = findResponseToInjected(parseTranscript(readPath, TRANSCRIPT_TAIL_BYTES), injectedText);
    return (r?.text && r.complete) ? r.text : null;
  };
}

async function onStop(payload) {
  const reg = readSessions();
  const route = resolveSessionForHook(reg, statesView(), payload);
  if (!route) {
    logger.debug('Stop: no session resolved, ignoring', { tpath: (payload.transcript_path || '').slice(-60) });
    return;
  }
  const entry = reg.sessions[route.name];
  const sess = getStateFor(route.name, entry);
  backfillPaneId(reg, route.name, payload);
  const kind = sessionKind(entry);
  const tpath = payload.transcript_path || entry.transcriptPath;
  if (!tpath) { sess.busy = false; scheduleInject(sess); return; }

  if (route.via === 'pane') {
    // Authoritative routing: the agent in this very pane reported its own
    // transcript, so tpath IS this session's transcript — trust it over the
    // scanner's guess. This subsumes the old flip-flop / compaction-transcript
    // heuristics whenever the new hook.py is installed.
    if (sess.lastInjectedText && sess.lastInjectedTranscript !== tpath) {
      logger.info('Pane-routed Stop, adopting reported transcript', { session: sess.name, tpath: tpath.slice(-40) });
      sess.lastInjectedTranscript = tpath;
    }
    if (entry.transcriptPath !== tpath) {
      entry.transcriptPath = tpath;
      writeSessions(reg);
    }
  } else {
    // Fallback routing (old hook.py without _tmuxPane): keep the conservative
    // acceptance gating so a same-cwd sibling's Stop can't hijack this session.
    const matchesInjected = sess.lastInjectedTranscript && tpath === sess.lastInjectedTranscript;
    const matchesEntry    = entry.transcriptPath && tpath === entry.transcriptPath;
    const hasExpected     = !!(sess.lastInjectedTranscript || entry.transcriptPath);
    if (hasExpected && !matchesInjected && !matchesEntry) {
      // The compaction-grace and same-project acceptance branches are Claude-only:
      // Codex rollouts live in date-based dirs, so "same dir" is NOT project identity
      // and would wrongly accept an unrelated session's Stop.
      if (kind === 'claude' && sess.lastInjectedText && Date.now() < sess.compactionGraceUntil
          && isSameProjectDir(tpath, sess.compactionGraceTranscript || entry.transcriptPath)) {
        // Post-compaction transcript, AND it lives in the same project the grace was
        // armed for. Without the same-project check, a foreign Claude session's Stop
        // during the 2-min window would be accepted and its reply forwarded to our
        // chat (wrong-session / data-leak).
        logger.info('Accepting post-compaction transcript (same project)', { tpath: tpath.slice(-40) });
        sess.lastInjectedTranscript = tpath;  // update to new transcript
      } else if (kind === 'claude' && sess.lastInjectedText
                 && isSameProjectDir(tpath, sess.lastInjectedTranscript || entry.transcriptPath)
                 && transcriptHasInjectedUser(tpath, sess.lastInjectedText)) {
        // Same project dir, different file, AND this transcript actually contains our
        // injected message → the scanner picked the wrong .jsonl at injection time and
        // the hook's tpath is authoritative. Accept it. (If it does NOT contain our
        // message it belongs to a different session sharing the cwd — fall through to
        // ignore.)
        logger.info('Stop from same project, accepting transcript switch', { tpath: tpath.slice(-40), was: (sess.lastInjectedTranscript || entry.transcriptPath)?.slice(-40) });
        sess.lastInjectedTranscript = tpath;
      } else {
        logger.debug('Stop transcript mismatch, ignoring', { session: sess.name, tpath: tpath.slice(-60), injected: sess.lastInjectedTranscript?.slice(-40), entry: entry.transcriptPath?.slice(-40) });
        // Do NOT clear busy here: a mismatched Stop must not unblock a
        // terminal-initiated turn genuinely in flight (where lastInjectedText is
        // null and busy is the only interlock). Only drain if nothing is busy.
        if (!sess.busy) scheduleInject(sess);
        return;
      }
    }
    // If tpath matched the entry but not the injected one, update injected
    // so that subsequent reads use the correct transcript.
    if (!matchesInjected && matchesEntry && sess.lastInjectedTranscript) {
      logger.info('Updating lastInjectedTranscript to match session entry', { from: sess.lastInjectedTranscript.slice(-40), to: tpath.slice(-40) });
      sess.lastInjectedTranscript = tpath;
    }
  }

  // This Stop is for this session — the turn has ended, so clear the busy flag.
  sess.busy = false;

  logger.info('Stop hook received', { session: sess.name, kind, via: route.via, transcript_path: tpath.slice(-60) });

  const readPath = sess.lastInjectedTranscript || tpath;

  // Codex has a distinct rollout schema and supplies last_assistant_message on
  // the Stop payload — handle it separately and return.
  if (kind === 'codex') { onStopCodex(sess, payload, readPath); return; }

  // Read only the tail on the hot path; if our injected message isn't in the tail
  // (a single turn larger than the cap), fall back to one full read so we don't
  // miss the response on an extremely large turn.
  let entries = parseTranscript(readPath, TRANSCRIPT_TAIL_BYTES);
  let result = findResponseToInjected(entries, sess.lastInjectedText);
  if (!result && sess.lastInjectedText && transcriptExceedsTail(readPath)) {
    entries = parseTranscript(readPath);
    result = findResponseToInjected(entries, sess.lastInjectedText);
  }

  // Post-compaction fallback: injected text was summarized away in the new
  // transcript, so text-based matching fails. Use the last end_turn entry.
  // Guard: skip if it matches the last pushed response (avoids sending stale/duplicate).
  // Also require the transcript to be in the project the grace was armed for —
  // findLastCompleteResponse ignores injectedText, so without this an unrelated
  // transcript's last answer could be forwarded.
  if (!result && sess.lastInjectedText && Date.now() < sess.compactionGraceUntil
      && (!sess.compactionGraceTranscript || isSameProjectDir(readPath, sess.compactionGraceTranscript))) {
    result = findLastCompleteResponse(entries);
    if (result) {
      if (sess.lastPushedText && result.text === sess.lastPushedText) {
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
    session: sess.name,
    responseLen: responseText?.length ?? 0,
    complete: responseComplete,
    lastInjected: sess.lastInjectedText?.slice(0, 60),
  });

  // ── Path A: Complete response → forward to the IM
  if (responseText && responseComplete && sess.lastInjectedText) {
    pushResponse(sess, responseText);
    logger.info('Pushed response', { chars: responseText.length });
    scheduleInject(sess);
    return;
  }

  // ── Path B: Incomplete response (no end_turn) → CC interrupted mid-loop
  //    (e.g. context overflow before compaction). Defer — keep lastInjectedText.
  //    Also schedule a delayed retry: the transcript JSONL may not have been fully
  //    flushed with end_turn yet, or the end_turn Stop may never arrive if the
  //    terminal user interacts before CC becomes idle.
  if (responseText && !responseComplete && sess.lastInjectedText) {
    logger.info('Incomplete response (no end_turn), deferring', {
      partialLen: responseText.length, snippet: responseText.slice(0, 80),
    });
    const target = tmuxTargetFor(sess);
    if (target) tryAutoConfirmCompaction(sess, target);

    // Delayed retry: re-read transcript after 3s to check for late end_turn flush
    const savedInjectedText = sess.lastInjectedText;
    const savedReadPath = readPath;
    setTimeout(() => {
      if (sess.lastInjectedText !== savedInjectedText) return; // already resolved
      const retryEntries = parseTranscript(savedReadPath, TRANSCRIPT_TAIL_BYTES);
      const retryResult = findResponseToInjected(retryEntries, savedInjectedText);
      if (retryResult?.text && retryResult.complete) {
        pushResponse(sess, retryResult.text);
        logger.info('Pushed response via deferred retry', { chars: retryResult.text.length });
        scheduleInject(sess);
      }
    }, 3000);

    scheduleInject(sess);
    return;
  }

  // ── Path C: No response found
  if (!responseText && sess.lastInjectedText) {
    // Race condition: the Stop hook may arrive before the transcript is fully
    // flushed.  Retry after a short delay to catch late writes.
    if (!result) {
      await new Promise(r => setTimeout(r, 500));
      const retryEntries = parseTranscript(readPath, TRANSCRIPT_TAIL_BYTES);
      result = findResponseToInjected(retryEntries, sess.lastInjectedText);
      if (result?.text && result.complete) {
        pushResponse(sess, result.text);
        logger.info('Pushed response via retry', { chars: result.text.length });
        scheduleInject(sess);
        return;
      }
    }

    // Check if CC is still mid-loop (tool_use) — the last assistant entry has
    // stop_reason === 'tool_use', meaning more responses will follow.  In that
    // case, keep lastInjectedText so the eventual end_turn Stop can forward it.
    const lastAssistantStop = (() => {
      const checkEntries = result ? entries : parseTranscript(readPath, TRANSCRIPT_TAIL_BYTES);
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
      const target = tmuxTargetFor(sess);
      if (target && tryAutoConfirmCompaction(sess, target)) {
        logger.info('Auto-confirmed compaction, keeping lastInjectedText');
      } else {
        // Don't clean up immediately. Stop can fire prematurely (e.g. CC is
        // still generating, an interrupt fired, or transcript flush lagged).
        // Give the real response a long window to arrive — only abandon the
        // injected message if nothing matches after the deadline.
        logger.info('Stop arrived with no response yet, deferring cleanup', {
          session: sess.name, lastInjected: sess.lastInjectedText.slice(0, 60),
        });
        armOrphanPoll(sess, sess.lastInjectedText, claudeProbe(readPath, sess.lastInjectedText));
      }
    }
  }

  scheduleInject(sess);
}

/**
 * A hook payload carrying _tmuxPane can stamp paneId onto a just-attached
 * registry entry before the next scan pass gets to it (routing then upgrades
 * from transcript-fallback to authoritative pane matching immediately).
 */
function backfillPaneId(reg, name, payload) {
  const pane = (payload._tmuxPane || '').trim();
  const entry = reg.sessions[name];
  if (!pane || !entry || entry.paneId) return;
  entry.paneId = pane;
  writeSessions(reg);
  logger.info('Backfilled paneId from hook payload', { session: name, paneId: pane });
}

function onPreToolUse(payload) {
  // Route to the owning session; a PreToolUse from an untracked agent (e.g. a
  // Claude outside any registered pane) resolves to nothing → return no
  // decision, so it falls back to the agent's own permission flow. Marking a
  // foreign session busy would strand that state forever (its Stop never routes).
  const reg = readSessions();
  const route = resolveSessionForHook(reg, statesView(), payload);
  if (!route) return undefined;
  const entry = reg.sessions[route.name];
  const sess = getStateFor(route.name, entry);
  backfillPaneId(reg, route.name, payload);
  const kind = sessionKind(entry);

  sess.busy = true;
  cancelPending(sess);

  if (!AUTO_APPROVE) return undefined;

  const toolName  = payload.tool_name || '?';
  const toolInput = payload.tool_input || {};
  let desc = `${toolName}`;
  if (toolName === 'Bash' && toolInput.command) desc = `bash: \`${toolInput.command.slice(0, 120)}\``;
  else if (toolInput.file_path) desc = `${toolName}(${toolInput.file_path})`;

  // Track tool activity for the live status message (only our in-flight turn).
  if (sess.lastInjectedText) {
    sess.turnToolCount++;
    sess.turnLastTool = toolName;
    bumpTurnStatus(sess);
  }

  // ── Quiz support: forward AskUserQuestion to the IM ──
  // Only intercept quizzes triggered by an IM-injected message (lastInjectedText is set).
  // Terminal-initiated quizzes are left to the terminal user.
  // AskUserQuestion is a Claude Code TUI; Codex uses a different approval UX, so
  // quiz interception is Claude-only.
  if (kind === 'claude' && toolName === 'AskUserQuestion' && sess.lastInjectedText) {
    const questions = toolInput.questions || [];
    if (questions.length > 0) {
      const quizTarget = sess.injectedTarget || lastTarget;
      sess.pendingQuiz = {
        questions,
        questionIndex: 0,
        expires: Date.now() + 5 * 60 * 1000, // 5 min timeout
        target: quizTarget,
        selected: new Set(),
      };
      sendQuiz(sess, questions[0], quizTarget, 0);
      logger.info('Quiz forwarded', { session: sess.name, numQuestions: questions.length, q: questions[0].question.slice(0, 80) });
    }
  }

  appendHistory({ type: 'auto_approve', session: sess.name, tool: toolName, desc });

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
  const reg = readSessions();
  const route = resolveSessionForHook(reg, statesView(), payload);
  if (!route) return; // untracked session
  const sess = getStateFor(route.name, reg.sessions[route.name]);
  backfillPaneId(reg, route.name, payload);
  sess.busy = true;
  cancelPending(sess);
}

async function onNotification(payload) {
  const msg = payload.message || '';
  const reg = readSessions();
  const route = resolveSessionForHook(reg, statesView(), payload);

  if (msg.includes('waiting for your input')) {
    if (!route) { logger.debug('Notification from untracked session, ignoring'); return; }
    const entry = reg.sessions[route.name];
    const sess = getStateFor(route.name, entry);
    backfillPaneId(reg, route.name, payload);
    // The session is idle. Three cases:
    // 1. Quiz pending → already forwarded to the IM, just wait for user reply
    // 2. Compaction prompt → auto-confirm so CC can continue
    // 3. lastInjectedText still set → CC stopped without triggering Stop
    //    (shouldn't happen, but clean up to avoid stuck state)
    if (sess.pendingQuiz) {
      logger.info('Notification: CC waiting for quiz input', { session: sess.name });
      return;
    }
    const target = tmuxTargetFor(sess);
    if (target && tryAutoConfirmCompaction(sess, target)) {
      logger.info('Auto-confirmed compaction via Notification', { session: sess.name });
      return;
    }
    if (sess.lastInjectedText) {
      // Fallback-routed Notification from a DIFFERENT transcript than the one we
      // injected into says nothing about our in-flight turn — reaping here would
      // orphan the eventual Stop. Skip. (Pane-routed events are authoritative.)
      const ntpath = payload.transcript_path || '';
      if (route.via !== 'pane' && sess.lastInjectedTranscript && ntpath && ntpath !== sess.lastInjectedTranscript) {
        logger.info('Notification transcript mismatch while turn in flight, ignoring', {
          notif: ntpath.slice(-40), injected: sess.lastInjectedTranscript.slice(-40),
        });
        return;
      }
      // Last-chance: the end_turn Stop hook may have been missed (e.g. CC
      // fired Stop for tool_use, then the end_turn Stop wasn't delivered).
      // Try reading the transcript one more time to find the response.
      // Also try other transcripts in the same project dir in case the scanner
      // assigned the wrong one at injection time.
      const readPath = sess.lastInjectedTranscript || entry.transcriptPath;
      let result = null;
      if (readPath) {
        const entries = parseTranscript(readPath, TRANSCRIPT_TAIL_BYTES);
        result = findResponseToInjected(entries, sess.lastInjectedText);
        // If not found, the scanner may have assigned the wrong .jsonl at injection.
        // Resolve the transcript the pane's agent ACTUALLY holds open (fd/lsof
        // scan) rather than guessing "newest by mtime" — the latter could pick a
        // DIFFERENT same-cwd session's transcript and forward its reply to our chat
        // (wrong-session). Confirm it contains our injected message before accepting.
        if (!result) {
          try {
            const panePid = panePidFor(entry.tmux);
            const fdPath = panePid ? findTranscriptByPid(panePid) : null;
            if (fdPath && fdPath !== readPath && transcriptHasInjectedUser(fdPath, sess.lastInjectedText)) {
              result = findResponseToInjected(parseTranscript(fdPath, TRANSCRIPT_TAIL_BYTES), sess.lastInjectedText);
              if (result?.text) {
                logger.info('Found response in fd-open transcript during idle cleanup', { fdPath: fdPath.slice(-40) });
                sess.lastInjectedTranscript = fdPath;
              }
            }
          } catch {}
        }
      }
      if (result?.text) {
          pushResponse(sess, result.text);
          logger.info('Pushed response via idle cleanup', { chars: result.text.length, complete: result.complete });
          scheduleInject(sess);
          return;
      }
      logger.warn('CC idle but lastInjectedText still set, cleaning up', {
        session: sess.name, lastInjected: sess.lastInjectedText.slice(0, 60),
      });
      sess.orphanPollText = null;
      abandonTurn(sess, '会话已空闲但未捕获到回复，请回终端查看');
    } else {
      logger.info('Notification (logged, not pushed): ' + msg);
    }
    return;
  }
  appendHistory({ type: 'notification', session: route?.name, text: msg });
  logger.info('Notification: ' + msg);
}

// ── Single-instance guard ────────────────────────────────────────────
// The AF_UNIX hook socket is the PRIMARY singleton token (only one process can
// bind it). This is a belt-and-suspenders guard for the one race the socket can't
// cover: the socket file was removed by hand (e.g. during troubleshooting) while a
// previous daemon is still alive and long-polling. Two live pollers make Telegram
// return 409 "terminated by other getUpdates request" loops. So before binding,
// refuse to start if bridge.pid names a LIVE wrc daemon.
// IMPORTANT: never `rm` the hook socket manually — let the daemon manage it.
function procArgs(pid) {
  try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim(); } catch {}
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'args='], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {}
  return '';
}

function anotherDaemonAlive() {
  let pid;
  try { pid = parseInt(readFileSync(join(CC_WECHAT, 'bridge.pid'), 'utf8').trim(), 10); } catch { return false; }
  if (!pid || pid === process.pid) return false;
  try { process.kill(pid, 0); } catch { return false; } // ESRCH → not alive
  // Alive — but make sure it's actually a wrc bridge, not a recycled PID.
  const args = procArgs(pid);
  return /\bnode\b/.test(args) && args.includes('src/index.js');
}

// ── Hook server (Unix socket) ────────────────────────────────────────
// Generous cap on a single hook payload (PreToolUse tool_input can carry a large
// file write, so don't be stingy) — purely a guard so a stalled/oversized local
// client can't pin unbounded memory.
const MAX_HOOK_BYTES = 16 * 1024 * 1024;
const HOOK_CONN_TIMEOUT_MS = 15_000;

function startHookServer() {
  const server = net.createServer(conn => {
    conn.on('error', () => {});
    // The response is gated on the 'end' event, so a client that connects and then
    // idles without half-closing (a hung/buggy local process) would otherwise pin
    // this connection and its buffered chunks forever. Drop idle connections and
    // oversized payloads defensively. The sole real client (hook.py) half-closes
    // immediately, so this never affects normal operation.
    conn.setTimeout(HOOK_CONN_TIMEOUT_MS, () => conn.destroy());
    const chunks = [];
    let total = 0;
    conn.on('data', d => {
      total += d.length;
      if (total > MAX_HOOK_BYTES) { conn.destroy(); return; }
      chunks.push(d);
    });
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
  // Secondary guard: if the socket was removed by hand but a daemon is still alive,
  // refuse to start so we never double-poll (Telegram 409).
  if (anotherDaemonAlive()) {
    logger.info('Another wrc daemon is alive (bridge.pid); exiting to avoid double-poll');
    console.log('[wrc-bridge] another bridge daemon already running (pid file), exiting');
    process.exit(0);
  }

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
  const label = kind ? agentLabel(kind) : '远程控制';
  const header = reconnect
    ? `👋 ${label} 已重连！\n\n默认 session: ${activeName || '(unknown)'}\n\n`
    : `👋 ${label} 已连接！\n\n`;
  const topicsHint = transport?.caps.topics
    ? '🧵 话题模式已开启：每个 tmux 会话有自己的话题，进话题即可并行对话。\n\n'
    : (transport?.topics
      ? '💡 提示：建一个开启「话题」的超级群，把 bot 加为管理员后发 /bind，每个会话就有独立频道，可同时开工。\n\n'
      : '');
  return header + topicsHint +
    '可用指令：\n' +
    '  /ls — 列出 tmux 会话' + (transport?.caps.topics ? '（点按切换聚焦）' : '') + '\n' +
    '  /sw <名字/序号> — 切换默认路由\n' +
    '  /fc <名字/序号> — 聚焦一个 tmux 会话（其余话题收起，切回重建）\n' +
    '  /rename <新名字> — 重命名会话（TG 里直接改话题名也会同步）\n' +
    '  /model — 切换模型（文字菜单，无需终端交互）\n' +
    '  /esc — 中断当前回合\n\n' +
    '直接发消息即注入对应 session，回复将自动转发；各会话互不阻塞。';
}

// ── Inbound message handler (transport-agnostic) ─────────────────────
// Operates on the normalised InboundMessage from any transport. The reply
// destination is the opaque `inbound.target`; the core never inspects it.
function onInboundMessage(inbound) {
  // Topic renamed in the Telegram UI — a service event, not a conversation:
  // handle before the lastTarget bookkeeping so it can't become a reply target.
  if (inbound.kind === 'topic_edited') {
    handleTopicRename(inbound).catch(err => logger.error('Topic rename handler error', { error: err.message }));
    return;
  }

  lastTarget  = inbound.target;
  lastUserKey = inbound.userKey;
  // Persist the reply destination so a restarted daemon can send its reconnect
  // welcome / recovered responses somewhere sensible (per-turn state lives in
  // sessions_state.json; this file only carries the last-known conversation).
  if (inbound.target !== persistedTarget) {
    persistedTarget = inbound.target;
    try { saveSession({ target: lastTarget, userKey: lastUserKey }); } catch {}
  }
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

  // Resolve the context session: a topic target routes to its bound session;
  // private chat / General topic / WeChat route to the active session. When
  // the registry is empty, fall back to a session synthesized from legacy
  // state.json (parity with the old getActiveState() fallback — covers panes
  // the scanner cannot classify and hand-wiped registries).
  const reg = readSessions();
  let routed = resolveSessionForInbound(reg, replyTarget);
  if (!routed && Object.keys(reg.sessions).length === 0) routed = synthesizeLegacySession(reg);
  const sess = routed ? getStateFor(routed.name, reg.sessions[routed.name]) : null;

  // Welcome first-time users (once per bridge process run).
  if (!welcomedUsers.has(inbound.userKey)) {
    welcomedUsers.add(inbound.userKey);
    const kind = routed ? sessionKind(reg.sessions[routed.name]) : '';
    transport.sendText(replyTarget, buildWelcome({ reconnect: false, kind }))
      .catch(err => logger.error('Welcome message failed', { error: err.message }));
  }

  // Consume a pending /model text selection (button taps go through handleCallback).
  if (sess?.pendingSelect) {
    if (Date.now() > sess.pendingSelect.expires) {
      logger.info('pendingSelect expired, clearing');
      sess.pendingSelect = null;
      transport.sendText(replyTarget, '⏰ 模型菜单已超时取消，本条按普通消息处理').catch(() => {});
    } else if (sess.pendingSelect.type === 'model') {
      const entry = reg.sessions[sess.name];
      const resolved = resolveModelFor(entry ? sessionKind(entry) : 'claude', text.trim());
      if (resolved) {
        sess.pendingSelect = null;
        const reply = (m) => transport.sendText(replyTarget, m)
          .catch(err => logger.error('Model select reply failed', { error: err.message }));
        const tmux = tmuxTargetFor(sess);
        if (tmux && paneExists(tmux)) injectSlashAndCapture(sess, tmux, `/model ${resolved.id}`, reply);
        else reply('❌ tmux 不可用');
        return;
      }
      // Unrecognised input — cancel selection, fall through to normal injection.
      sess.pendingSelect = null;
      logger.info('pendingSelect: unrecognised input, cancelled');
    }
  }

  // Consume a pending quiz (typed answer) for the context session.
  if (sess?.pendingQuiz) {
    if (Date.now() > sess.pendingQuiz.expires) {
      logger.info('pendingQuiz expired, clearing');
      sess.pendingQuiz = null;
      transport.sendText(replyTarget, '⏰ 问卷已超时取消，本条按普通消息处理').catch(() => {});
    } else {
      handleQuizResponse(sess, text, replyTarget);
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
  else if (/^\/fc(\s|$)/i.test(cmdText)) cmdText = '#fc' + cmdText.slice(3);
  else if (/^\/rename(\s|$)/i.test(cmdText)) cmdText = '#rename' + cmdText.slice(7);
  else if (/^\/mv(\s|$)/i.test(cmdText)) cmdText = '#rename' + cmdText.slice(3);
  else if (/^\/model(\s|$)/i.test(cmdText)) cmdText = '#model' + cmdText.slice(6);
  else if (/^\/bind\b/i.test(cmdText)) cmdText = '#bind';
  else if (/^\/esc\b/i.test(cmdText)) cmdText = '#esc';
  else if (/^\/start\b/i.test(cmdText)) {
    // Telegram /start (BotFather flow) → welcome/usage text. /help stays a
    // remotable CC builtin (inject + capture), as before.
    const kind = routed ? sessionKind(reg.sessions[routed.name]) : '';
    transport.sendText(replyTarget, buildWelcome({ reconnect: false, kind })).catch(() => {});
    return;
  }

  if (cmdText.startsWith('#')) {
    handleBridgeCommand(cmdText, replyTarget, sess);
    return;
  }

  // Everything past this point needs a session to talk to.
  if (!sess) {
    transport.sendText(replyTarget, '暂无已发现的会话（等待自动扫描，约 30 秒；或在终端里运行 attach）').catch(() => {});
    return;
  }
  const ctxEntry = reg.sessions[sess.name];

  const slashMatch = cmdText.match(/^\/([a-z][\w-]*)/i);
  if (slashMatch) {
    const slashName = slashMatch[1].toLowerCase();
    const ctxKind = ctxEntry ? sessionKind(ctxEntry) : 'claude';
    const builtin = ctxKind === 'codex' ? getAgent('codex').builtinSlash : CC_BUILTIN_SLASH;
    const tuiOnly = ctxKind === 'codex' ? getAgent('codex').tuiOnly : CC_TUI_ONLY;

    if (builtin.has(slashName)) {
      const sendReply = (m) => transport.sendText(replyTarget, m)
        .catch(err => logger.error('Slash reply failed', { error: err.message }));
      const tmux = tmuxTargetFor(sess);
      if (!tmux || !paneExists(tmux)) { sendReply('❌ tmux 不可用'); return; }

      if (tuiOnly.has(slashName)) {
        const remotable = ctxKind === 'codex'
          ? '/status /diff /mcp /ps /compact /clear /new /model /review'
          : '/cost /usage /compact /clear /fast /effort /help /doctor /status /model';
        sendReply(`⚠️ /${slashName} 需要终端交互（方向键选择），无法远程操作。\n\n可远程使用的命令:\n  ${remotable}`);
        return;
      }
      injectSlashAndCapture(sess, tmux, cmdText, sendReply);
      return;
    }
    // Not a known built-in → probably a skill → inject normally (produces transcript)
  }

  // Regular message or skill — enqueue for injection into the CONTEXT session.
  // Capture the reply target NOW so a later message can't steal this turn's
  // response (H2/H3). Bound the queue: a stalled turn could otherwise let it
  // grow without limit.
  if (sess.pendingQueue.length >= MAX_PENDING_QUEUE) {
    sess.pendingQueue.shift(); // drop oldest
    logger.warn('pendingQueue full, dropping oldest queued message', { session: sess.name, max: MAX_PENDING_QUEUE });
    transport.sendText(replyTarget, '⚠️ 排队消息过多，已丢弃最早的一条').catch(() => {});
  }
  sess.pendingQueue.push({ text, target: replyTarget, messageId: inbound.messageId });

  // Show a typing indicator immediately (fire-and-forget).
  if (transport.caps.typingIndicator) transport.sendTyping(replyTarget, true).catch(() => {});

  if (!sess.busy) scheduleInject(sess);
  else logger.info('Session busy, message queued for injection after Stop', { session: sess.name, queued: sess.pendingQueue.length });
}

// ── Main ─────────────────────────────────────────────────────────────
// Native command menu (Telegram setMyCommands). Each entry, when tapped, sends
// the "/<command>" text which the slash-alias router maps to a bridge command.
const MENU_COMMANDS = [
  { command: 'ls',     description: '列出 tmux 会话（点按切换聚焦）' },
  { command: 'sw',     description: '切换默认路由会话' },
  { command: 'fc',     description: '聚焦一个 tmux 会话（其余话题收起，切回重建）' },
  { command: 'model',  description: '切换模型' },
  { command: 'rename', description: '重命名当前会话' },
  { command: 'esc',    description: '中断当前回合' },
  { command: 'bind',   description: '在话题群里绑定（每会话一个话题）' },
  { command: 'start',  description: '使用说明' },
];

async function main() {
  mkdirSync(CC_WECHAT, { recursive: true });

  const transportName = resolveTransportName();
  transport = await createTransport(transportName);

  const session = loadSession();
  lastTarget  = session.target || '';
  lastUserKey = session.userKey || '';
  persistedTarget = lastTarget;

  // Restore per-session in-flight turns for crash recovery. A legacy
  // ilink_session.json that still carries turn fields is migrated once onto the
  // active session's key; afterwards ilink_session.json holds only target/userKey.
  const persisted = readJson(SESS_STATE_FILE, {});
  const legacy = migrateLegacyIlink(session, readSessions());
  for (const [key, turn] of Object.entries({ ...legacy, ...persisted })) {
    if (!turn?.lastInjectedText) continue;
    const sess = newSessionState(key, turn.name || key);
    sess.lastInjectedText       = turn.lastInjectedText;
    sess.lastInjectedTranscript = turn.lastInjectedTranscript || null;
    sess.injectedTarget         = turn.injectedTarget || '';
    sess.injectedMessageId      = turn.injectedMessageId || '';
    sessionStates.set(key, sess);
    sidToState.set(sess.sid, sess);
    logger.warn('Startup: restored in-flight turn', { session: sess.name, text: turn.lastInjectedText.slice(0, 40) });
  }
  if (session.lastInjectedText) {
    saveSession({ target: lastTarget, userKey: lastUserKey }); // strip migrated legacy fields
  }

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

  let startupReconciled = false;
  function reconcileRestoredTurn() {
    if (startupReconciled) return;       // ready may fire more than once
    startupReconciled = true;
    for (const sess of sessionStates.values()) {
      if (!sess.lastInjectedText) continue;
      // injectedTarget may be missing on legacy restores — fall back to the last
      // known reply target so a recovered response still reaches the user.
      if (!sess.injectedTarget) sess.injectedTarget = lastTarget || '';
      logger.info('Reconciling in-flight turn restored from previous run', {
        session: sess.name, lastInjected: sess.lastInjectedText.slice(0, 60), transcript: sess.lastInjectedTranscript?.slice(-40),
      });
      if (sess.lastInjectedTranscript) {
        const r = findResponseToInjected(parseTranscript(sess.lastInjectedTranscript, TRANSCRIPT_TAIL_BYTES), sess.lastInjectedText);
        if (r?.text && r.complete) {
          pushResponse(sess, r.text);
          logger.info('Restored turn already complete; pushed on startup', { chars: r.text.length });
          scheduleInject(sess);
          continue;
        }
      }
      // Not yet complete (or no transcript): arm a bounded poll so the turn either
      // resolves when the agent finishes or is abandoned at the deadline — never
      // wedging lastInjectedText forever. (Claude transcript matching; for Codex the
      // deadline cleanup still un-wedges it.)
      armOrphanPoll(sess, sess.lastInjectedText, claudeProbe(sess.lastInjectedTranscript, sess.lastInjectedText));
    }
  }

  function onEvent(ev) {
    if (ev.type === 'ready') {
      logger.info('Transport ready', { transport: transportName, self: ev.selfName });
      console.log(`[wrc-bridge] transport ready (${transportName}${ev.selfName ? ' @' + ev.selfName : ''})`);

      // Register the native command menu where supported (Telegram).
      if (transport.caps.commandMenu && transport.setCommandMenu) {
        transport.setCommandMenu(MENU_COMMANDS).catch(() => {});
      }

      // Topics become available only once the transport has loaded its account
      // (caps.topics computed in start()) — sync immediately rather than waiting
      // for the next 30s scan tick.
      syncSessionTopics().catch(() => {});

      // Proactive reconnect welcome if we know the user from a previous session.
      // Prefer the transport's "home" destination (bound group's General topic /
      // locked private chat) over the raw last inbound target, which may be a
      // topic that no longer maps to a session.
      const welcomeTarget = transport.homeTarget?.() || lastTarget;
      if (welcomeTarget) {
        if (lastUserKey) welcomedUsers.add(lastUserKey); // suppress duplicate on first inbound
        const activeName = readSessions().active || '(unknown)';
        transport.sendText(welcomeTarget, buildWelcome({ reconnect: true, activeName, kind: getActiveState().kind }))
          .catch(err => logger.error('Startup welcome failed', { error: err.message }));
        logger.info('Sent startup welcome', { target: welcomeTarget });
      }

      // Reconcile any in-flight turn restored from a previous run. Run here (not
      // earlier) because the transport's sender/api is only initialised by now, so
      // pushResponse can actually deliver. Without this, a daemon that died mid-turn
      // would restore lastInjectedText, never receive the (already-fired) Stop, and
      // wedge — scheduleInject() no-ops forever and every future message is dropped.
      reconcileRestoredTurn();
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
    for (const sess of sessionStates.values()) {
      cancelPending(sess);
      if (sess.statusEditTimer) clearTimeout(sess.statusEditTimer);
      if (sess.heartbeatTimer) clearInterval(sess.heartbeatTimer);
    }
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
