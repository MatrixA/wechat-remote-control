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
  findInterimTexts,
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
  renameTmuxGroupInRegistry,
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

// Forward meaningful interim assistant text (prose between tool calls) to the
// IM as it appears, instead of only the final end_turn response. Claude-only.
// WRC_FORWARD_INTERIM=0|false disables; WRC_INTERIM_MIN_LEN tunes the noise
// threshold (chars — shorter blocks like "让我看看…" status chatter are skipped).
const FORWARD_INTERIM = !(process.env.WRC_FORWARD_INTERIM === '0' || process.env.WRC_FORWARD_INTERIM === 'false');
const _rawInterimMin = parseInt(process.env.WRC_INTERIM_MIN_LEN ?? '', 10);
const INTERIM_MIN_LEN = Number.isFinite(_rawInterimMin) && _rawInterimMin >= 0 ? _rawInterimMin : 200;
const INTERIM_SCAN_GAP_MS = 2000;  // min gap between PreToolUse-triggered scans

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
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  // Hours matter now that a wedged turn's age is user-facing: "133m13s" is a
  // number you have to decode, "2h13m" is one you read.
  if (m < 60) return `${m}m${s % 60 ? `${s % 60}s` : ''}`;
  return `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ''}`;
}

function statusBody(sess) {
  if (sess.interruptRequestedAt) {
    // No "send /esc again if it didn't work" hint: that is what used to walk the
    // pane into Codex's rewind overlay. /esc is still safe to send — it now
    // inspects the pane first — but nothing should actively invite a repeat.
    return `⏹ 已请求中断 · ${fmtDur(Date.now() - sess.interruptRequestedAt)} · 等待回收`;
  }
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
  // Once an interrupt was requested the ⏹ button comes off (undefined buttons →
  // keyboard removed). The interruptRequestedAt gate in the intr: handler is the
  // real double-Esc protection — this edit can fail silently.
  const buttons = sess.interruptRequestedAt ? undefined : statusButtons(sess);
  transport.editText(target, sess.statusMsgId, statusBody(sess), buttons).catch(() => {});
}

function startTurnStatus(sess) {
  stopTurnStatus(sess);
  sess.turnStartedAt        = Date.now();
  sess.turnToolCount        = 0;
  sess.turnLastTool         = '';
  sess.statusMsgId          = null;
  sess.heartbeatSentOnce    = false;
  sess.interruptRequestedAt = 0;
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
  // Single clearing point for the interrupt-requested freeze: every turn ending
  // (pushResponse / abandonTurn / stopTurnStatus / destroyState) funnels here.
  sess.interruptRequestedAt = 0;
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

/** Block for `ms` without forking a `bash -c sleep` (same synchronous timing,
 *  no fork/exec cost). Sync-only call sites. */
function syncWait(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Deliver one message to an agent pane and submit it.
 *
 * ALWAYS through a tmux paste buffer with bracketed paste (-p) — never
 * `send-keys -l`, not even for single-line text. Verified against codex-cli
 * 0.145.0 sources and reproduced in a live pane on 2026-07-27:
 *
 *   `send-keys -l` writes the whole string to the pty at once, so crossterm
 *   emits the Char events ~0ms apart. That trips Codex's paste-burst detector
 *   (PASTE_BURST_CHAR_INTERVAL = 8ms, paste_burst.rs:158), which opens a 120ms
 *   "Enter inserts a newline instead of submitting" window
 *   (PASTE_ENTER_SUPPRESS_WINDOW, paste_burst.rs:155). Our Enter lands inside
 *   it, so chat_composer.rs:3457-3460 appends '\n' and returns
 *   InputResult::None: the message sits UNSENT in the composer with a stray
 *   blank line under it. No turn starts, so no Stop ever arrives and
 *   lastInjectedText never clears — the session then reads busy forever and
 *   scheduleInject refuses every later message.
 *   A UI tick flushes the burst after ~9ms, so this was a RACE — it worked
 *   whenever tmux client startup happened to outlast the window, which is
 *   exactly why the symptom looked intermittent.
 *
 *   An explicit bracketed paste takes the other branch: handle_paste()
 *   (chat_composer.rs:1082-1101) ends with an unconditional
 *   clear_after_explicit_paste(), documented there as "so a real paste cannot
 *   affect the next user Enter key". The suppression window does not merely get
 *   wide enough to beat — it ceases to exist. Structural, not a tuned timeout,
 *   and it removes a code path instead of adding one.
 *
 * `-p` only brackets when the pane's app has bracketed-paste mode on. Both
 * TUIs do, but a pane sitting in some other modality may not, and then the
 * paste degrades back into the raw-keystroke path above. That residual case is
 * what the verification below is for. `-d` drops the temp buffer afterwards.
 *
 * Returns { submitted, retried, reason }:
 *   true  — the composer provably no longer holds our text
 *   false — our text provably still sits in the composer even after a second
 *           Enter; the caller must NOT mark the turn in-flight
 *   null  — undeterminable; the caller proceeds as if submitted and leaves it
 *           to the existing orphan-poll safety net
 */
const SUBMIT_VERIFY_WAIT_MS = 120;   // one TUI redraw + slack, per verify round
const SUBMIT_VERIFY_ROUNDS  = 2;

function sendKeys(target, text, bufKey = '', opts = {}) {
  const { verify = true, kind = null } = opts;
  // Strip control chars but KEEP newlines (\x0a) — a multi-line IM message must
  // reach the agent as one prompt, not be fragmented per line.
  const safe = text.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '');
  // Buffer name is namespaced per session: two sessions pasting concurrently
  // must not race one shared buffer.
  const buf = `wrc-inject-${(bufKey || 'default').replace(/[^%\w.-]/g, '_')}`;
  // `--` before the payload, or tmux parses a message that happens to start with
  // a dash as its own flags and exits 1: `set-buffer -b b '- 修复这个'` →
  // "invalid flag -". Verified on tmux 3.7.
  execFileSync('tmux', ['set-buffer', '-b', buf, '--', safe]);
  execFileSync('tmux', ['paste-buffer', '-d', '-p', '-b', buf, '-t', target]);
  execFileSync('tmux', ['send-keys', '-t', target, 'Enter']);
  if (!verify) return { submitted: null, retried: false, reason: 'verify-off' };

  let cls = verdict(target, safe, kind);
  if (cls !== 'stuck') {
    return { submitted: cls === 'submitted' ? true : null, retried: false, reason: cls };
  }
  // Provably unsent: bracketed paste did not apply and the Enter was swallowed
  // as a newline. The burst window has long since lapsed, so one more Enter
  // submits it (the stray '\n' rides along harmlessly at the end of the text).
  logger.warn('Injected text still in composer after Enter, re-keying', { target, chars: safe.length });
  execFileSync('tmux', ['send-keys', '-t', target, 'Enter']);
  cls = verdict(target, safe, kind);
  return { submitted: cls === 'stuck' ? false : (cls === 'submitted' ? true : null), retried: true, reason: cls };
}

/**
 * 'stuck' only when the text is in the composer AND the pane is not mid-turn.
 *
 * The pane check is a VETO, never the primary signal — a pane can legitimately
 * be working for reasons unrelated to us. As a veto it is right in every branch:
 *   - genuinely stuck, pane idle          → 'stuck', we re-key. ✓
 *   - submitted, turn now running         → the match was the transcript echo
 *                                           mid-redraw; veto avoids a duplicate
 *                                           send. ✓
 *   - pane was ALREADY mid-turn when we injected → Codex parks our text in the
 *     composer and auto-submits it when the turn ends. Re-keying or re-queueing
 *     would double-send; the un-wedge poll in onStopCodex owns this case. ✓
 */
function verdict(target, injected, kind) {
  const cls = awaitComposerSettled(target, injected, kind, SUBMIT_VERIFY_ROUNDS);
  if (cls === 'stuck' && paneShowsWorking(target)) {
    logger.info('Composer still holds text but pane is mid-turn, not re-keying', { target });
    return 'working';
  }
  return cls;
}

/** Poll classifyComposer up to `rounds` times, `SUBMIT_VERIFY_WAIT_MS` apart.
 *  Returns on the first non-'stuck' verdict — 'submitted' and 'unknown' both
 *  mean "do not press Enter again", so there is nothing to gain by waiting. */
function awaitComposerSettled(target, injected, kind, rounds) {
  let cls = 'unknown';
  for (let i = 0; i < rounds; i++) {
    syncWait(SUBMIT_VERIFY_WAIT_MS);
    cls = classifyComposer(capturePaneContent(target, 0), injected, kind);
    if (cls !== 'stuck') return cls;
  }
  return cls;
}

// ── Composer inspection ──────────────────────────────────────────────
/**
 * First line of each TUI's input box. Verbatim captures, 2026-07-27, from
 * codex-cli 0.145.0 and Claude Code v2.1.196:
 *
 *   codex                            Claude Code
 *   ─────────────────────────        ──────────────────────────────
 *   › line one alpha                 ──────────────────────────────
 *     line two beta                  ❯ line one alpha
 *                                    ──────────────────────────────
 *     gpt-5.6-sol · /tmp/x             ⏸ plan mode on (shift+tab …)
 *
 * Continuation lines are plain 2-space indents in both, so the region is taken
 * as "composer-start line through end of viewport" rather than by modelling
 * each TUI's footer — that absorbs wrapping, status rows and hint lines for
 * free.
 *
 * The LAST match is the composer, and that detail is the whole ballgame: after
 * a successful submit codex echoes the user message into the transcript with
 * the SAME `› ` prefix. Anchoring on the first match, or just scanning the
 * bottom N lines, reports every successful send as stuck and re-keys a stray
 * Enter into an idle pane.
 *
 * NOTE (CC): current builds draw the box with plain `────` rules, not the
 * `╭─╮ │ ╰─╯` glyphs older code elsewhere in this file still matches on.
 */
/**
 * `\s`, NOT `[ \t]`: an EMPTY Claude Code composer renders as `❯` + U+00A0
 * (no-break space), while its transcript echo of a submitted message uses a
 * plain U+0020. Matching only ASCII space therefore skipped the real composer
 * and anchored on the echo instead — which reports every successful send as
 * stuck. Verified by codepoint dump of a live pane, 2026-07-27.
 */
const COMPOSER_START = {
  codex:  /^›(?:\s|$)/,   // ›
  claude: /^❯(?:\s|$)/,   // ❯
};

/** Composer text as rendered, or null when no input box is on screen. */
function composerRegion(paneText, kind) {
  const lines = stripAnsi(paneText || '').split('\n');
  const pats = (kind && COMPOSER_START[kind]) ? [COMPOSER_START[kind]] : Object.values(COMPOSER_START);
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (pats.some(re => re.test(lines[i]))) { start = i; break; }
  }
  if (start < 0) return null;
  // Stop at the first blank line or horizontal rule below the prompt. Both TUIs
  // fence the composer off from their footer exactly that way — codex with a
  // blank line before "  <model> · <cwd>", CC with a "────" rule before the mode
  // hints — and the footer must NOT be part of the region: it carries the cwd and
  // mode text, so a message merely MENTIONING its own working directory would
  // match the footer, be declared stuck on an empty composer, and get re-sent.
  // Cost of stopping early: a message containing a blank line has only its first
  // paragraph in the region, so a genuine wedge may read 'submitted' instead —
  // the harmless direction, and the orphan poll still covers it.
  const end = lines.findIndex((l, i) => i > start && (l.trim() === '' || /^\s*─{20,}/.test(l)));
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

/** Shortest normalized needle we trust as a composer anchor. Below this a
 *  message like "y" or "好" would match some incidental glyph in a status row
 *  and re-key Enter into a pane we do not actually understand. */
const MIN_COMPOSER_ANCHOR = 8;

/**
 * Did our injected text leave the composer? → 'submitted' | 'stuck' | 'unknown'.
 *
 * Deliberately biased toward under-detection: only 'stuck' causes us to press
 * Enter again, and pressing Enter into an unrecognised modality is far worse
 * than missing a wedge (the orphan poll still catches that). Every branch we
 * cannot prove returns 'unknown', which the caller treats as "leave it alone".
 */
function classifyComposer(paneText, injectedText, kind) {
  const region = composerRegion(paneText, kind);
  if (region === null) return 'unknown';           // no input box on screen
  // Large pastes never render verbatim — both TUIs collapse them to a
  // placeholder the needle below could never match, so test it first:
  //   codex : [Pasted Content 1234 chars]     (>1000 chars, chat_composer.rs:316)
  //   CC    : [Pasted text #1 +5 lines]
  // Trade-off: text the user themselves had pending in the composer reads as
  // ours. Harmless — our paste appended to it, so both submit together.
  if (/\[pasted\s+(content|text)/i.test(region)) return 'stuck';
  const needle = quizNorm(injectedText || '').slice(0, 40);
  if (needle.length < MIN_COMPOSER_ANCHOR) return 'unknown';
  // Known blind spot, observed live: while a turn is running with messages
  // queued behind it, Claude Code replaces the composer body with
  // "Press up to edit queued messages", hiding whatever text is in there. Our
  // needle cannot match, so this falls through to 'submitted'. That is the right
  // answer in the common case (CC accepted and queued the message) and the safe
  // answer in the rare one (Enter was swallowed) — the orphan poll still covers
  // it. Recorded so nobody "fixes" it into a stuck verdict and re-sends
  // everything a busy pane queues.
  // quizNorm drops everything but letters+digits, absorbing the TUI's hard
  // wrapping, indent and punctuation drift between what we sent and what is
  // drawn.
  return quizNorm(region).includes(needle) ? 'stuck' : 'submitted';
}

/**
 * Is the agent in this pane visibly mid-turn? Both TUIs render "esc to
 * interrupt" in their status row ONLY while a turn is running (Claude:
 * "(esc to interrupt · …)", Codex: "Esc to interrupt"). Visible viewport only
 * (scrollback = 0) so a historical frame can never read as "still working".
 * Conservative failure mode: if a future TUI drops the string this returns
 * false, which at worst abandons a turn early — never wedges one.
 *
 * Known over-report: Codex also prints "esc to interrupt" on its MCP-server
 * startup spinner, when no turn is running (observed 2026-07-27). Every caller
 * treats a true here as "hands off", so an extra second of caution at startup
 * is the harmless direction.
 */
function paneShowsWorking(target) {
  if (!target || !paneExists(target)) return false;
  return stripAnsi(capturePaneContent(target, 0)).toLowerCase().includes('esc to interrupt');
}

/**
 * What is this pane showing? → 'overlay' | 'primed' | 'working' | 'idle' | 'unknown'
 *
 * Exists because Escape is not idempotent. On an idle Codex pane the first Esc
 * primes "edit previous message" and the SECOND opens a full-screen transcript
 * overlay whose Enter forks the session. Our own UI used to invite exactly that
 * ("如未生效可发送 /esc"), so the escape hatch could strand the pane in a
 * modality where every pane-reading heuristic we have goes blind.
 *
 * Verbatim from a live codex-cli 0.145.0 pane, 2026-07-27:
 *   idle    footer: "  gpt-5.6-sol high · /private/tmp/wrc-probe"
 *   Esc ×1  footer: "  esc again to edit previous message"          (alternate_on=0)
 *   Esc ×2  footer: " q to quit   esc/← to edit prev   → to edit next   enter to edit message"
 *                                                                   (alternate_on=1)
 *
 * Deliberately NOT modelled: a Claude Code rewind dialog. Double-Esc on an idle
 * CC v2.1.196 pane was verified to be a no-op, so there is nothing to detect and
 * a speculative text matcher would be untestable. A future CC full-screen dialog
 * still lands in the generic altScreenOn branch below, which refuses to inject
 * and refuses to type — the safe default.
 */
function classifyModality(paneText, kind, altScreenOn) {
  const norm = quizNorm(paneText || '');
  // Alt-screen is checked FIRST and is the structural signal. Inside a pager the
  // viewport is scrolled history, which can easily contain an older turn's
  // "esc to interrupt" and would otherwise be misread as 'working'.
  if (altScreenOn) {
    // The agent's own transcript overlay — the one two Escs land you in — is the
    // only alt-screen we know how to leave (q). Anything else the user opened
    // themselves (less, vim, a man page) is 'unknown': hands off entirely,
    // because there a bare `q` is just a letter typed into their buffer.
    return (norm.includes('qtoquit') && norm.includes('toeditprev')) ? 'overlay' : 'unknown';
  }
  if (norm.includes('escagaintoeditpreviousmessage')) return 'primed';
  if (norm.includes('esctointerrupt')) return 'working';
  return 'idle';
}

/** classifyModality against a live pane. `#{alternate_on}` is a real tmux
 *  format (3.x), so the primary signal is structural rather than scraped. */
function paneModality(target, kind) {
  if (!target || !paneExists(target)) return 'unknown';
  let alt;
  try {
    alt = execFileSync('tmux', ['display-message', '-p', '-t', target, '#{alternate_on}'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === '1';
  } catch { return 'unknown'; }
  return classifyModality(stripAnsi(capturePaneContent(target, 0)), kind, alt);
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
 * `quiz:<sid>:<gen>:<qIdx>:<optIdx>`, plus a "完成" button for multi-select);
 * otherwise a numbered text menu (WeChat). A typed custom answer also works.
 */
function sendQuiz(sess, question, replyTarget, qIdx) {
  const pq = sess.pendingQuiz;
  if (transport.caps.inlineKeyboards) {
    const gen = pq?.gen ?? '0';
    const rows = question.options.map((opt, i) => [{ label: `${i + 1}. ${opt.label}`, data: `quiz:${sess.sid}:${gen}:${qIdx}:${i}` }]);
    let text;
    if (question.multiSelect) {
      rows.push([{ label: '✅ 完成', data: `quiz:${sess.sid}:${gen}:${qIdx}:done` }]);
      text = `❓ ${question.question}\n\n（多选：点选切换，选好后按"完成"，或直接输入自定义回答）`;
    } else {
      text = `❓ ${question.question}\n\n（点选项，或直接输入自定义回答）`;
    }
    transport.sendButtons(replyTarget, text, rows)
      .then(sent => {
        // Identity guard: the quiz may have been cancelled/replaced before the ack.
        if (sent?.messageId && pq && sess.pendingQuiz === pq) {
          pq.msgIds[qIdx] = { messageId: sent.messageId, target: replyTarget, text };
        }
      })
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
 * CC renders the options as a numbered select list with a free-text row
 * immediately after the last option ("Type something." on current builds,
 * "Other" on older ones; a trailing "Chat about this" row sits further down
 * and is never navigated to). First option is pre-selected. Down to navigate,
 * Enter to select. For free text: navigate past all options, Enter, type,
 * Enter. For multiSelect: Space to toggle, Enter to confirm.
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
  syncWait(500);
  // Via sendKeys for its bracketed paste, which is what stops Codex's
  // paste-burst detector from turning our Enter into a newline (see sendKeys).
  // Verification is off here on purpose: the free-text row is a quiz widget,
  // not the normal composer, so a 'stuck' verdict would be guesswork — and a
  // stray Enter inside a select list confirms a selection. A quiz answer that
  // fails to submit does not set lastInjectedText, so it cannot wedge the
  // session the way an injected message can; it just doesn't land.
  sendKeys(target, trimmed, target, { verify: false });
  return `Other: "${trimmed}"`;
}

/** Normalize for screen matching: keep only letters+digits, lowercase.
 *  Collapsing everything else absorbs TUI line wraps, box borders, bullets,
 *  numbering and punctuation drift between the tool input and what CC renders. */
function quizNorm(s) {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * Is `question` the quiz currently rendered in the pane? Answers are injected
 * as blind keystrokes, so this screen check is the safety gate (it replaced the
 * old 5-min TTL — the screen is the truth, not the clock).
 *
 * Visible pane ONLY, no scrollback: the dismissed-quiz echoes repeat our own
 * text — the answered echo shows "question → chosen label" and the Esc echo
 * shows the question plus ALL labels in order ("(Red / Green / Blue)",
 * verified empirically) — so question/label needles alone cannot tell a dead
 * quiz from a live one. Match rule:
 *   - quiz-specific live chrome must be on screen: the "Type something." /
 *     "Chat about this" rows (current CC), or a line-anchored "Other" row
 *     (older CC; line-anchored so prose like "otherwise" can't fake it).
 *     Deliberately NOT the generic "Enter to select" hint — permission
 *     dialogs share that chrome and must never pass;
 *   - plus EITHER all option-label prefixes IN ORDER (how the live list
 *     renders; keeps short panes working when a long question is clipped
 *     above the options) OR the question TAIL + ≥ min(2, n) label prefixes
 *     (tail, not head: small panes clip the top first).
 *
 * Retries once after a 500ms blocking wait: a tap can land while the TUI is
 * still redrawing the next question. Callers are sync, so the wait is sync too
 * (same Atomics.wait pattern as injectQuizAnswer) — paid only on mismatch.
 */
function quizOnScreen(target, question, attempt = 0) {
  const raw = stripAnsi(capturePaneContent(target, 0));
  const hay = quizNorm(raw);
  const qTail = quizNorm(question.question).slice(-24);
  const labels = question.options.map(o => quizNorm(o.label).slice(0, 12)).filter(Boolean);
  const hits = labels.filter(l => hay.includes(l)).length;
  let pos = 0;
  let orderedList = labels.length > 0;
  for (const l of labels) {
    const at = hay.indexOf(l, pos);
    if (at < 0) { orderedList = false; break; }
    pos = at + l.length;
  }
  const liveChrome = hay.includes('typesomething') || hay.includes('chataboutthis')
    || /^\s*(?:❯\s*)?\d*\.?\s*(?:\[[ x]\]\s*)?Other\.?\s*$/im.test(raw);
  const ok = liveChrome
    && (orderedList
      || ((!qTail || hay.includes(qTail)) && hits >= Math.min(2, labels.length)));
  if (ok) return true;
  if (attempt === 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    return quizOnScreen(target, question, 1);
  }
  // debug level: the pane may contain sensitive terminal content.
  logger.debug('quizOnScreen mismatch', { snippet: hay.slice(-300) });
  return false;
}

/** Strip the inline keyboard from a sent quiz question so dead buttons don't
 *  linger in chat (no-op on transports without editable messages/keyboards). */
function stripQuizButtons(quiz, qIdx, note) {
  if (!transport?.caps.editMessages || !transport.caps.inlineKeyboards) return;
  const rec = quiz.msgIds?.[qIdx];
  if (!rec) return;
  transport.editText(rec.target, rec.messageId, rec.text + (note ? `\n\n${note}` : ''))
    .catch(err => logger.debug('Quiz button strip skipped', { error: err.message }));
}

/** Cancel the pending quiz and strip the current question's dead buttons. */
function cancelQuiz(sess, note) {
  const quiz = sess.pendingQuiz;
  sess.pendingQuiz = null;
  if (quiz) stripQuizButtons(quiz, quiz.questionIndex, note);
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
    cancelQuiz(sess, '（已失效）');
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

/**
 * After the last question, CC's AskUserQuestion TUI auto-advances to a final
 * "Review your answers" screen with "❯ Submit answers" already focused — one
 * Enter submits.  The per-question answers each sent an Enter that advanced the
 * tab, but nothing ever presses that final Submit, so CC hangs.  Send it here.
 *
 * Guarded on the pane so we NEVER inject a stray Enter: we match only the
 * review-screen text ("Submit answers" / "Review your answers"), not the tab
 * bar's bare "✔ Submit" that shows on every question screen.  Retries a few
 * times because the review screen takes a moment to render after the last Enter.
 */
function submitQuizForm(target, attempt = 0) {
  if (!target || !paneExists(target)) return;
  const content = stripAnsi(capturePaneContent(target, 20));
  if (/submit (your )?answers|review your answers/i.test(content)) {
    sendTmuxKey(target, 'Enter');
    return;
  }
  if (attempt < 4) setTimeout(() => submitQuizForm(target, attempt + 1), 500);
}

/** Advance to the next quiz question (or clear state). Shared by text + callback paths. */
function advanceQuiz(sess, replyTarget) {
  const quiz = sess.pendingQuiz;
  stripQuizButtons(quiz, quiz.questionIndex, '（已回答 ✅）');
  quiz.questionIndex++;
  if (quiz.questionIndex >= quiz.questions.length) {
    const target = tmuxTargetFor(sess);
    sess.pendingQuiz = null;
    setTimeout(() => submitQuizForm(target), 500);
  } else {
    setTimeout(() => {
      // Identity, not truthiness: a cancel + NEW quiz within the delay must not
      // get the old quiz's next question sent on top of it.
      if (sess.pendingQuiz !== quiz) return;
      quiz.selected = new Set();
      sendQuiz(sess, quiz.questions[quiz.questionIndex], replyTarget, quiz.questionIndex);
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

// Telegram errors that all mean "this forum topic no longer exists" — which
// one comes back varies by method (sendMessage → "message thread not found",
// deleteForumTopic → TOPIC_ID_INVALID, reopen/edit → TOPIC_DELETED). Every
// dead-topic check must use this, or the unmatched spelling loops forever
// (e.g. a remove op re-failing with TOPIC_ID_INVALID every 30s sync).
const DEAD_TOPIC_RE = /thread not found|TOPIC_DELETED|TOPIC_ID_INVALID/i;

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
            if (!DEAD_TOPIC_RE.test(m)) throw err;
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
 *  - dead topic (DEAD_TOPIC_RE): the topic is gone (user deletion, or an
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
  if (!DEAD_TOPIC_RE.test(m)) return null;
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

  let res;
  try {
    // Slash commands go through the same bracketed paste as everything else.
    // Verified in a live codex pane (2026-07-27): pasting `/status` still opens
    // the command popup and Enter still dispatches the command — identical to
    // the old literal-keystroke path, minus the swallowed-Enter race.
    const slashEntry = readSessions().sessions[sess.name];
    res = sendKeys(target, command, sess.key, { kind: slashEntry ? sessionKind(slashEntry) : null });
  } catch (err) {
    await send(`❌ 注入失败: ${err.message}`);
    return;
  }
  if (res.submitted === false) {
    // Provably still sitting in the composer — waiting 2.5s to scrape output
    // that cannot exist would just report a confusing empty result.
    await send(`❌ 命令未能提交到终端（文本仍留在输入框），请回终端查看`);
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
let fcMenu = null; // { names, expires, target, messageId } — snapshot behind fc:<idx> callbacks; target/messageId let a focus switch re-render the menu in place
const FC_MENU_TTL = 15 * 60 * 1000;

// ── tmux-session (group) rename ──────────────────────────────────────
// Renaming a GROUP (`tmux rename-session`) is distinct from renameSession()'s
// window rename: the /ls //fc menu's ✏️ flow sends a ForceReply prompt and the
// user's REPLY to that prompt carries the new name. In-memory only (like
// fcMenu): a daemon restart invalidates the prompt — a reply to a pre-restart
// prompt is unrecognizable and routes to the agent as normal text.
let pendingTmuxRename = null; // { groupName, promptMessageId, target, expires }
// Prompt ids no longer active (superseded / expired / consumed). A reply to a
// retired prompt was clearly meant as a rename, so it gets an "expired" notice
// instead of being injected into the agent. Bounded: cleared when it grows.
const retiredRenamePrompts = new Set();
const TMUX_RENAME_TTL = 5 * 60 * 1000;

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
// A turn that has been in flight this long is far more likely wedged than slow.
// 10 min is 2× armOrphanPoll's default 5-minute grace, so an ordinary long turn
// plus one extension never trips it; 30 min is past any plausible extension.
const STUCK_WARN_MS  = 10 * 60 * 1000;
const STUCK_ALARM_MS = 30 * 60 * 1000;

/**
 * Suffix for the "（N 忙碌）" tag once a busy session looks stuck rather than
 * slow. Returns '' while things look healthy — a normal list stays quiet.
 *
 * This exists because "（1 忙碌）" is indistinguishable between "working hard"
 * and "wedged since yesterday", which is exactly how a stuck session used to go
 * unnoticed for days.
 */
function stuckSuffix(busyStates, now = Date.now()) {
  const waiting = busyStates.filter(s => s && s.lastInjectedText);
  if (waiting.length === 0) return '';   // busy via a terminal-initiated turn — not ours to age
  // A turn restored from a state file written before injectedAt existed has no
  // age to report, yet it is precisely the shape of the classic wedge. Say so
  // rather than render it as an ordinary busy session.
  if (waiting.some(s => !s.injectedAt)) return ' · ⚠️ 已挂起，时长未知，可 /reset';
  const age = now - Math.min(...waiting.map(s => s.injectedAt));
  if (age < STUCK_WARN_MS) return '';
  return `${age >= STUCK_ALARM_MS ? ' · 🔴' : ' · ⚠️'} 已等 ${fmtDur(age)} 无回应，可 /reset`;
}

function formatTmuxList(reg) {
  const groups = tmuxGroups(reg);
  if (groups.size === 0) return '暂无发现活跃的会话（等待自动扫描，约30秒）';
  const topics = !!transport?.caps.topics;
  const focus = topics ? effectiveFocus(reg) : null;
  const lines = ['📋 tmux 会话:'];
  let i = 0;
  for (const [g, members] of groups) {
    i++;
    const busy = members
      .map(n => sessionStates.get(sessionKeyFor(reg.sessions[n])))
      .filter(st => st && (st.busy || st.lastInjectedText));
    // sendButtons never splits the message — cap the inline member list.
    const shown = members.length > 6 ? [...members.slice(0, 5), `…+${members.length - 5}`] : members;
    const mark = topics ? (g === focus ? '🎯 ' : '○ ') : '';
    const busyTag = busy.length ? `（${busy.length} 忙碌${stuckSuffix(busy)}）` : '';
    lines.push(`${mark}${i}. ${g} — ${shown.join(', ')}${busyTag}`);
  }
  lines.push('', `默认路由: ${reg.active || '无'}` + (focus ? ` · 🎯 聚焦: ${focus}` : ''));
  return lines.join('\n');
}

function tmuxButtons(names, focus) {
  const rows = names.map((g, i) => [{ label: `${g === focus ? '🎯 ' : ''}${i + 1}. ${g}`, data: `fc:${i}` }]);
  // Rename lives behind one extra tap (rnm flips the menu into rename mode) so
  // the frequent action — focus — keeps full-width rows.
  rows.push([{ label: '✏️ 重命名', data: 'rnm' }]);
  return rows;
}

// Rename mode: same menu message edited in place, each row picks a group to
// rename (rn:<idx> against the fcMenu snapshot), ↩︎ flips back to focus mode.
function tmuxRenameButtons(names) {
  const rows = names.map((g, i) => [{ label: `✏️ ${i + 1}. ${g}`, data: `rn:${i}` }]);
  rows.push([{ label: '↩︎ 返回', data: 'rnb' }]);
  return rows;
}

/**
 * Probe every existing topic in the focused group and unbind any the user
 * deleted in Telegram (there is no "topic deleted" update, so a stale imTarget
 * otherwise lingers and planTopicSync never recreates the tab). reopen() is the
 * probe: it fails with a dead-topic error (DEAD_TOPIC_RE) for a dead thread, and
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
      if (!DEAD_TOPIC_RE.test(m)) continue; // live topic / transient
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
 * Re-render the /ls //fc menu message in place after a focus change, so its 🎯
 * marker and「聚焦」footer track reality instead of going stale. Edits the
 * tapped message when the callback names one (menuMessageId), else the menu
 * recorded at send time; fcMenu.names is refreshed so fc:<idx> payloads keep
 * matching the keyboard the edited message now shows. Best-effort — a deleted
 * or too-old message must never break the focus switch itself.
 */
async function refreshFcMenu(menuMessageId) {
  const messageId = menuMessageId ?? fcMenu?.messageId;
  if (!transport?.caps.editMessages || !fcMenu?.target || !messageId) return;
  const reg = readSessions();
  const groupNames = [...tmuxGroups(reg).keys()];
  if (groupNames.length === 0) return;
  fcMenu.names = groupNames;
  await transport.editText(fcMenu.target, messageId, formatTmuxList(reg), tmuxButtons(groupNames, effectiveFocus(reg)))
    .catch(err => logger.debug('fc menu edit skipped', { error: err.message }));
}

/**
 * Switch the focused tmux session and kick a topic sync. Shared by the #fc
 * command and the fc:<idx> button callback. Focus is sticky — groupName is
 * always a real group (there is no unfocus). `reply` is the caller's feedback
 * channel (a chat message for #fc, the callback toast for button taps); it goes
 * out before the sync — deleting/recreating many topics can take a while and
 * busy sessions defer their deletion to a later sync anyway.
 */
async function performFocus(groupName, reply, { menuMessageId } = {}) {
  const reg = readSessions();
  reg.focusedTmuxSession = groupName;
  writeSessions(reg);
  const members = new Set(tmuxGroups(reg).get(groupName) || []);
  // Count only topics that actually exist and will be deleted.
  const toRemove = Object.entries(reg.sessions)
    .filter(([n, s]) => !members.has(n) && s.imTarget).length;
  await reply(
    (toRemove > 0
      ? `🎯 已聚焦 ${groupName}：保留 ${members.size} 个会话话题，收起（删除）其余 ${toRemove} 个，切回时重建并回放上下文。`
      : `🎯 已聚焦 ${groupName}（${members.size} 个会话）。`)
    + `\n默认路由不变: ${reg.active || '无'}`);
  await refreshFcMenu(menuMessageId);
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
 * Resolve a user-typed group reference — /ls number, exact name, then
 * substring — against the current group list. Shared by #fc and #rnt so both
 * commands accept the same references the /ls menu displays.
 */
function resolveGroupArg(groupNames, arg) {
  const num = parseInt(arg, 10);
  if (!isNaN(num) && num >= 1 && num <= groupNames.length) return groupNames[num - 1];
  return groupNames.find(g => g.toLowerCase() === arg.toLowerCase())
    ?? groupNames.find(g => g.toLowerCase().includes(arg.toLowerCase()))
    ?? null;
}

/** Error string when newName can't be a tmux-session name, else null. */
function validateGroupRename(reg, newName) {
  if (!newName) return '名字不能为空';
  // tmux targets use ':' and '.' as separators — same rule as #rename.
  if (/[:.\n\t]/.test(newName)) return '名字不能包含 : . 制表符或换行';
  if (tmuxGroups(reg).has(newName)) return `已存在同名 tmux 会话: ${newName}`;
  return null;
}

/**
 * Rename a tmux SESSION (the /ls group). tmux first, registry second: the
 * scanner rewrites entry.tmux from live tmux every pass, so a registry-only
 * rename would be reverted within 30s — tmux failure therefore ABORTS with no
 * registry write (the opposite of renameSession's non-fatal window rename).
 * On success one writeSessions rewrites every member's coordinates AND
 * focusedTmuxSession (otherwise the scanner's focus-vanished check clears the
 * focus for a scan interval), then migrates the runtime-state keys of
 * paneId-less members (their sessionKeyFor embeds the coordinates).
 */
function performTmuxGroupRename(reg, oldName, newName) {
  const members = tmuxGroups(reg).get(oldName) || [];
  if (members.length === 0) return { ok: false, error: `tmux 会话「${oldName}」已不存在` };
  // A member pane id resolves to its session and survives window moves; '='
  // forces an exact name match for pre-paneId entries.
  const anchor = members.map(n => reg.sessions[n].paneId).find(Boolean) || ('=' + oldName);
  try {
    execFileSync('tmux', ['rename-session', '-t', anchor, newName],
      { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
  } catch (err) {
    // stderr carries tmux's own reason (e.g. "duplicate session: x" for a
    // session outside the registry that the collision pre-check can't see).
    const detail = String(err.stderr || err.message || '').trim();
    logger.error('tmux rename-session failed', { oldName, newName, error: detail });
    return { ok: false, error: detail || 'tmux rename-session 失败' };
  }
  const { keyMigrations } = renameTmuxGroupInRegistry(reg, oldName, newName);
  writeSessions(reg);
  // Same key-migration pattern as reconcileStates; sidToState references the
  // same state object, so it needs no touch-up.
  for (const { from, to } of keyMigrations) {
    const st = sessionStates.get(from);
    if (!st || sessionStates.has(to)) continue;
    sessionStates.delete(from);
    st.key = to;
    sessionStates.set(to, st);
  }
  if (keyMigrations.length > 0) persistStates();
  logger.info('tmux session renamed', { oldName, newName });
  return { ok: true };
}

/**
 * Consume the user's reply to a ✏️ ForceReply prompt (the caller already
 * matched replyToMessageId === promptMessageId). Validation failures KEEP the
 * pending so the user just replies again; terminal outcomes (success, group
 * gone, tmux failure, expiry) retire the prompt — a later reply to it gets
 * the "expired" notice instead of reaching the agent.
 */
async function handleTmuxRenameReply(inbound) {
  const pending = pendingTmuxRename;
  const send = (m) => transport.sendText(inbound.target, m).catch(() => {});
  const retire = () => { retiredRenamePrompts.add(pending.promptMessageId); pendingTmuxRename = null; };
  if (Date.now() > pending.expires) {
    retire();
    await send('⏰ 已过期，请重新点击 ✏️');
    return;
  }
  const reg = readSessions();
  // The registry may have moved since the prompt (scanner rename, session gone).
  if (!tmuxGroups(reg).has(pending.groupName)) {
    retire();
    await send(`❌ tmux 会话「${pending.groupName}」已不存在，可能已被关闭或重命名`);
    return;
  }
  const newName = inbound.text.trim();
  if (newName === pending.groupName) {
    retire();
    await send(`已经叫 ${newName} 了，无需修改`);
    return;
  }
  const invalid = validateGroupRename(reg, newName);
  if (invalid) { await send(`${invalid}，请重新回复新名字`); return; }
  const r = performTmuxGroupRename(reg, pending.groupName, newName);
  retire();
  if (!r.ok) { await send(`❌ tmux 重命名失败: ${r.error}`); return; }
  // Fold the receipt into the prompt message instead of growing the chat; a
  // fresh send is the fallback for a deleted prompt.
  const receipt = `✅ 已重命名 tmux 会话: ${pending.groupName} → ${newName}（话题与聚焦不受影响）`;
  if (transport.caps.editMessages) {
    await transport.editText(pending.target, pending.promptMessageId, receipt)
      .catch(() => send(receipt));
  } else {
    await send(receipt);
  }
  await refreshFcMenu(); // the /ls menu tracks the new name in place
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

/**
 * The single place that decides whether to send Escape to a pane.
 *
 * Escape is not idempotent — see classifyModality. The rule is simple because
 * both agents gate their rewind/backtrack UI on "no turn is running": if the
 * pane IS working, Escape is safe and does what the user asked; if it is NOT
 * working, Escape does nothing useful and can only make things worse. So the
 * screen decides, not a counter.
 *
 * This replaces the old approach on both callers: #esc had NO gate at all
 * ("the explicit, repeatable escape hatch"), and the ⏹ button gated on the
 * bookkeeping flag interruptRequestedAt — which knows whether we asked, not
 * what the terminal is actually showing.
 *
 * Returns { modality, message } for the caller to deliver; every tmux op here
 * is synchronous.
 */
function requestEscape(sess, reg = null) {
  const target = tmuxTargetFor(sess);
  const entry = (reg || readSessions()).sessions[sess.name];
  const kind = entry ? sessionKind(entry) : null;
  const mod = paneModality(target, kind);
  logger.info('Escape requested', { session: sess.name, modality: mod });

  if (mod === 'working') {
    sendTmuxKey(target, 'Escape');
    onInterruptRequested(sess);
    return { modality: mod, message: `⏹ 已向 ${sess.name} 发送中断${sess.lastInjectedText ? '，正在等待回收当前回合…' : ''}` };
  }

  if (mod === 'overlay') {
    // NEVER Escape here (it pages further back) and NEVER Enter (that confirms
    // the rewind and forks the session). `q` quits — verified to leave the
    // composer untouched, no stray character.
    for (let i = 0; i < 2; i++) {
      sendTmuxKey(target, 'q');
      syncWait(500);
      if (paneModality(target, kind) !== 'overlay') {
        return { modality: mod, message: `🪟 ${sess.name} 的终端卡在历史浏览界面（多按了一次 Esc 进入的），已退出。请重新发送你的消息。` };
      }
    }
    return { modality: mod, message: `🪟 ${sess.name} 的终端卡在历史浏览界面，自动退出失败。请回终端按 q 退出。` };
  }

  if (mod === 'primed' || mod === 'idle') {
    let note = '';
    if (mod === 'primed') {
      // One Esc already landed. A second would open the overlay above — the exact
      // trap our own "如未生效可发送 /esc" hint used to walk users into. Any
      // non-Esc key cancels the primed state; Left is the only one that leaves the
      // composer byte-identical (Space+BSpace nets out but pollutes it in between,
      // and would eat a real leading space if one were pasted mid-race).
      sendTmuxKey(target, 'Left');
      note = '（上一次 Esc 已生效；再按会打开历史回退界面，已为你拦下）';
    }
    // The pane is idle, so there is nothing to interrupt — but /esc has always
    // doubled as a recovery nudge, and dropping that would be a regression. This
    // arms the short poll WITHOUT claiming an interrupt happened: an unresolved
    // turn on an idle pane either yields its partial text now or is abandoned,
    // and a stuck `busy` from a terminal turn gets cleared. No-op when the
    // session is healthy.
    const recovering = !!(sess.lastInjectedText || sess.busy);
    if (recovering) onInterruptRequested(sess, { markRequested: false });
    return {
      modality: mod,
      message: `ℹ️ ${sess.name} 的终端当前空闲，没有正在运行的回合可以中断${note}。`
        + (recovering ? '\n🔄 但仍有未收尾的回合，已启动回收；若约 20 秒后依旧不动，发送 /reset。' : ''),
    };
  }

  return { modality: mod, message: `❌ 读不到 ${sess.name} 的终端状态（tmux 可能已关闭，或终端停在其它全屏程序里），未发送任何按键。` };
}

/**
 * Human-readable account of what a reset actually did. Detailed on purpose:
 * a silent "✅ 已重置" leaves the user unsure whether anything was wrong, and
 * the pane line makes /reset double as a diagnostic.
 */
function resetReceipt(sess, had, reg) {
  const lines = [`🧹 已重置会话 ${sess.name}`];
  lines.push(`  忙碌标记: ${had.busy ? '已清除' : '本来就没有'}`);
  if (had.injected) {
    const age = had.injectedAt ? `已挂起 ${fmtDur(Date.now() - had.injectedAt)}` : '挂起时长未知';
    const preview = had.injected.length > 30 ? `${had.injected.slice(0, 30)}…` : had.injected;
    lines.push(`  等待回收的消息: 「${preview}」（${age}）`);
  } else {
    lines.push('  等待回收的消息: 无');
  }
  lines.push(had.queued
    ? `  队列中的消息: ${had.queued} 条（已保留，正在重新注入）`
    : '  队列中的消息: 无');
  if (had.quiz) lines.push('  待答问卷: 已取消');
  const entry = reg.sessions[sess.name];
  const target = entry ? (entry.paneId || entry.tmux) : null;
  const kind = entry ? sessionKind(entry) : '?';
  const pane = !target || !paneExists(target) ? '❌ pane 已不存在'
    : paneShowsWorking(target) ? '正在运行一个回合' : '空闲';
  lines.push(`  终端状态: ${kind} · ${pane}`);
  return lines.join('\n');
}

// `viaTopic` — whether ctxSess was routed through its own forum topic (vs the
// General/private-chat active fallback); only #rnt's context resolution cares.
async function handleBridgeCommand(text, replyTarget, ctxSess, viaTopic = false) {
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

  // #esc — interrupt the context session's current turn, if there is one.
  // Repeat-safe by inspection rather than by counter: requestEscape reads the
  // pane and only sends Escape when a turn is actually running, so hammering
  // /esc can no longer walk the pane into Codex's rewind overlay.
  if (cmd === '#esc' || cmd === '#stop') {
    if (!ctxSess) { await send('当前没有会话'); return; }
    try {
      await send(requestEscape(ctxSess).message);
    } catch (err) {
      await send(`❌ 中断失败: ${err.message}`);
    }
    return;
  }

  // #reset [all] — un-wedge a session that reads busy but will never resolve.
  // No confirmation prompt on purpose: this is what someone reaches for when
  // they are already stuck, and it cannot lose anything (queued messages are
  // kept, the registry and credentials are untouched).
  if (cmd === '#reset' || cmd === '#unstick') {
    const all = (parts[1] || '').toLowerCase() === 'all';
    const targets = all ? [...sessionStates.values()] : (ctxSess ? [ctxSess] : []);
    if (targets.length === 0) { await send(all ? '暂无会话可重置' : '当前没有会话'); return; }
    const reg = readSessions();
    const blocks = targets.map(s => resetReceipt(s, resetSessionState(s, all ? 'im-reset-all' : 'im-reset'), reg));
    await send(blocks.join('\n\n'));
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
      const sent = await transport.sendButtons(replyTarget, list, tmuxButtons(groupNames, effectiveFocus(reg)))
        .catch(err => { logger.error('Session list push failed', { error: err.message }); return null; });
      fcMenu = { names: groupNames, expires: Date.now() + FC_MENU_TTL, target: replyTarget, messageId: sent?.messageId };
    } else {
      // No focus buttons on this transport — leave a /sw pointer so the
      // numbered list isn't a dead end (its numbers are /fc's, not /sw's).
      const hint = !transport.caps.topics && groupNames.length > 0
        ? '\n切换默认: /sw <名字/序号> · 重命名 tmux 会话: /rnt <新名>' : '';
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
      const list = formatTmuxList(reg);
      if (transport.caps.inlineKeyboards && groupNames.length > 0) {
        const sent = await transport.sendButtons(replyTarget, list, tmuxButtons(groupNames, effectiveFocus(reg)))
          .catch(err => { logger.error('Focus menu push failed', { error: err.message }); return null; });
        fcMenu = { names: groupNames, expires: Date.now() + FC_MENU_TTL, target: replyTarget, messageId: sent?.messageId };
      } else {
        await send(`${list}\n\n用法: /fc <名字/序号>`);
      }
      return;
    }
    const groupName = resolveGroupArg(groupNames, arg);
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

  // #rnt [<序号|旧名>] <新名> — rename a tmux SESSION (the /ls group), not a
  // window. Argument rule: with ≥2 tokens, IF the first resolves to an
  // existing group (number → exact → substring, same as #fc) it names the
  // group and the rest is the new name; otherwise ALL tokens are the new name
  // for the context group (topic → that session's group; General / private /
  // WeChat → the focused group, else the active session's group).
  if (cmd === '#rnt') {
    const args = parts.slice(1);
    if (args.length === 0) {
      await send('用法: /rnt <新名>（重命名当前 tmux 会话）\n或: /rnt <序号|旧名> <新名>');
      return;
    }
    const reg = readSessions();
    const groups = tmuxGroups(reg);
    const groupNames = [...groups.keys()];
    let oldName = null, newName = null;
    if (args.length >= 2) {
      const explicit = resolveGroupArg(groupNames, args[0]);
      if (explicit) { oldName = explicit; newName = args.slice(1).join(' ').trim(); }
    }
    if (!oldName) {
      newName = args.join(' ').trim();
      if (viaTopic && ctxSess?.name && reg.sessions[ctxSess.name]) {
        oldName = tmuxSessionOf(reg.sessions[ctxSess.name]);
      } else {
        oldName = effectiveFocus(reg)
          ?? (reg.active && reg.sessions[reg.active] ? tmuxSessionOf(reg.sessions[reg.active]) : null);
      }
    }
    if (!oldName || !groups.has(oldName)) { await send('当前没有活动 tmux 会话'); return; }
    if (newName === oldName) { await send(`已经叫 ${newName} 了`); return; }
    const invalid = validateGroupRename(reg, newName);
    if (invalid) { await send(invalid); return; }
    const r = performTmuxGroupRename(reg, oldName, newName);
    if (!r.ok) { await send(`❌ tmux 重命名失败: ${r.error}`); return; }
    await send(`✅ 已重命名 tmux 会话: ${oldName} → ${newName}（话题与聚焦不受影响）`);
    await refreshFcMenu();
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

  await send(`未知指令: ${text}\n可用:\n  /ls — 列出 tmux 会话\n  /sw <名字/序号> — 切换默认路由\n  /fc <名字/序号> — 聚焦 tmux 会话（其余话题收起，切回重建）\n  /rename <新名字> — 重命名\n  /rnt <新名> — 重命名 tmux 会话（组）\n  /model — 切换模型\n  /esc — 中断当前回合\n  /reset — 卡在忙碌时重置回合状态（/reset all 全部）\n  /bind — 在话题群里绑定`);
}

/**
 * Handle an inline-keyboard button tap (Telegram). Decodes the index-encoded
 * callback data (`model:<i>` / `sw:<i>` / `quiz:<gen>:<qIdx>:<optIdx|done>`) and routes
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
    // Stale tap: the turn this button belonged to is over. Interrupting an
    // unrelated terminal turn from a leftover button would be surprising —
    // /esc is the explicit command for that.
    if (!sess.lastInjectedText) { ack('该回合已结束'); return; }
    // No interruptRequestedAt gate any more: requestEscape reads the pane, so a
    // repeat tap on a no-longer-working pane simply reports that instead of
    // firing a second Escape. The screen is a better guard than our bookkeeping.
    try {
      ack(requestEscape(sess).message);
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
    // The summary rides the toast and the tapped menu is edited in place (🎯
    // moves) — a tap must not grow the chat with one more confirmation message.
    await performFocus(groupName, ack, { menuMessageId: inbound.messageId });
    return;
  }

  // ── rnm — flip the /ls //fc menu into rename mode (edit in place) ──
  if (verb === 'rnm') {
    if (!fcMenu || Date.now() > fcMenu.expires) { ack('菜单已过期'); return; }
    const reg = readSessions();
    const groupNames = [...tmuxGroups(reg).keys()];
    if (groupNames.length === 0) { ack('暂无会话'); return; }
    fcMenu.names = groupNames; // rn:<idx> resolves against what this keyboard shows
    await transport.editText(inbound.target, inbound.messageId,
      formatTmuxList(reg) + '\n\n✏️ 点选要重命名的 tmux 会话',
      tmuxRenameButtons(groupNames))
      .catch(err => logger.debug('rename-mode edit skipped', { error: err.message }));
    ack();
    return;
  }

  // ── rnb — rename mode → back to the normal focus menu ──
  if (verb === 'rnb') {
    if (!fcMenu || Date.now() > fcMenu.expires) { ack('菜单已过期'); return; }
    await refreshFcMenu(inbound.messageId);
    ack();
    return;
  }

  // ── rn:<idx> — pick a group to rename → ForceReply prompt ──
  if (verb === 'rn') {
    if (!fcMenu || Date.now() > fcMenu.expires) { ack('菜单已过期'); return; }
    const groupName = fcMenu.names[parseInt(segs[1], 10)];
    const reg = readSessions();
    if (!groupName || !tmuxGroups(reg).has(groupName)) {
      ack('该 tmux 会话已不存在');
      await refreshFcMenu(inbound.messageId);
      return;
    }
    const sent = await transport.sendText(inbound.target,
      `✏️ 重命名 tmux 会话「${groupName}」\n回复本条消息，输入新名字（5 分钟内有效）`,
      { forceReply: true })
      .catch(err => { logger.error('Rename prompt send failed', { error: err.message }); return null; });
    if (!sent?.messageId) { ack('发送提示失败'); return; }
    if (pendingTmuxRename) retiredRenamePrompts.add(pendingTmuxRename.promptMessageId);
    if (retiredRenamePrompts.size > 50) retiredRenamePrompts.clear();
    pendingTmuxRename = {
      groupName,
      promptMessageId: sent.messageId,
      target: inbound.target,
      expires: Date.now() + TMUX_RENAME_TTL,
    };
    await refreshFcMenu(inbound.messageId); // flip the menu back to focus mode
    ack(`回复提示消息，输入「${groupName}」的新名字`);
    return;
  }

  // ── quiz:<sid>:<gen>:<qIdx>:<optIdx|done> ──
  if (verb === 'quiz') {
    if (!sess || !sess.pendingQuiz) { ack('该问卷已失效'); return; }
    const quiz = sess.pendingQuiz;
    const gen  = segs[2];
    const qIdx = parseInt(segs[3], 10);
    const rest = segs[4];
    // gen mismatch = buttons from an earlier quiz. The screen check below can't
    // catch this (the CURRENT quiz is legitimately on screen) — without it the
    // old optIdx would be injected into the new question's options.
    if (gen !== quiz.gen) { ack('该问卷已失效'); return; }
    if (qIdx !== quiz.questionIndex) { ack('该问题已回答'); return; }
    const q = quiz.questions[quiz.questionIndex];
    const tmux = tmuxTargetFor(sess);
    if (!tmux || !paneExists(tmux)) { ack('tmux 不可用'); send('❌ tmux 不可用'); cancelQuiz(sess, '（已失效）'); return; }
    if (!quizOnScreen(tmux, q)) {
      cancelQuiz(sess, '（已失效）');
      ack('终端已离开问卷界面');
      send('⚠️ 终端已离开问卷界面（可能已在终端作答或已取消），问卷已关闭');
      return;
    }

    if (q.multiSelect) {
      if (rest === 'done') {
        const sel = [...(quiz.selected || new Set())].sort((a, b) => a - b);
        if (sel.length === 0) { ack('请至少选择一项'); return; }
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

// A paste the pane provably did not accept is retried with a backoff rather
// than reported as in-flight — see the submitted===false branch below.
const INJECT_RETRY_DELAY = 3_000;
const INJECT_MAX_FAILS   = 3;

function scheduleInject(sess, delayMs = INJECT_DELAY) {
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
    const kind = sessionKind(entry);
    // Do not paste into a full-screen overlay. In Codex's rewind overlay the
    // keystrokes are navigation, not text — and Enter there forks the session.
    // 'primed' and 'working' deliberately DO pass: priming is harmless to an
    // injection (the first pasted character cancels it, and a non-empty composer
    // disables backtrack outright) and a working pane simply queues our text.
    // Only Escape cares about 'primed'; only injection cares about 'overlay'.
    const mod = paneModality(target, kind);
    if (mod === 'overlay' || mod === 'unknown') {
      sess.injectFailCount = (sess.injectFailCount || 0) + 1;
      logger.warn('Deferring inject: pane is not accepting text', {
        session: sess.name, modality: mod, attempt: sess.injectFailCount,
      });
      if (sess.injectFailCount < INJECT_MAX_FAILS) { scheduleInject(sess, INJECT_RETRY_DELAY); return; }
      sess.injectFailCount = 0;
      const notify = sess.pendingQueue[0]?.target || lastTarget;
      if (notify && transport) {
        transport.sendText(notify, mod === 'overlay'
          ? `🪟 「${sess.name}」的终端停在历史浏览界面，消息暂时发不进去（已保留在队列）。发送 /esc 可自动退出该界面。`
          : `❓ 读不到「${sess.name}」的终端状态，消息暂时发不进去（已保留在队列）。请回终端看一眼。`).catch(() => {});
      }
      return;
    }
    const item = sess.pendingQueue.shift();
    let res;
    try {
      res = sendKeys(target, item.text, sess.key, { kind });
    } catch (err) {
      // Re-queue at the head so the message is not lost on a transient tmux error.
      sess.pendingQueue.unshift(item);
      logger.error('tmux inject failed', { session: sess.name, error: err.message });
      return;
    }
    if (res.submitted === false) {
      // The text is provably still sitting in the composer. Marking the turn
      // in-flight here is EXACTLY how a session used to wedge into permanent
      // "busy": no turn means no Stop, and lastInjectedText then blocks every
      // later message forever. So re-queue at the head and back off instead —
      // the session never enters a state it cannot leave.
      sess.pendingQueue.unshift(item);
      sess.injectFailCount = (sess.injectFailCount || 0) + 1;
      logger.error('Inject not submitted, text stayed in composer', {
        session: sess.name, attempt: sess.injectFailCount, chars: item.text.length,
      });
      if (sess.injectFailCount < INJECT_MAX_FAILS) { scheduleInject(sess, INJECT_RETRY_DELAY); return; }
      sess.injectFailCount = 0;   // a later drain (Stop, /reset) gets a fresh budget
      const notify = item.target || sess.injectedTarget || lastTarget;
      if (notify && transport) {
        transport.sendText(notify,
          `❌ 消息无法提交到「${sess.name}」的终端输入框（已重试 ${INJECT_MAX_FAILS} 次）。\n`
          + `消息仍在队列中未丢失。请回终端看一眼输入框，或发送 /reset 重置该会话。`).catch(() => {});
      }
      return;
    }
    try {
      sess.injectFailCount        = 0;
      sess.lastInjectedText       = item.text;
      sess.lastInjectedTranscript = entry.transcriptPath || null;
      sess.injectedTarget         = item.target;
      sess.injectedMessageId      = item.messageId || '';
      sess.injectedAt             = Date.now();
      sess.interimLastScanAt      = 0;
      // Reset interim dedup state ON the chain, not synchronously: a previous
      // turn's still-queued scan or end-of-turn flush must keep seeing its own
      // turn's sent-uuids (else it re-sends everything), while the new turn's
      // scans — always chained later — start from a clean slate.
      const interimReset = () => { sess.interimSentUuids = []; sess.interimLastText = null; };
      sess.interimChain = (sess.interimChain || Promise.resolve()).then(interimReset, interimReset);
      persistStates();
      appendHistory({ type: 'user_wechat', session: sess.name, text: item.text });
      reactTo(item.target, item.messageId, '👀');
      startTurnStatus(sess);  // live status / progress pings until this turn resolves
      logger.info('Injected message', { session: sess.name, chars: item.text.length, queued: sess.pendingQueue.length, transcript: sess.lastInjectedTranscript?.slice(-40) });
    } catch (err) {
      // The text is already in the agent by this point, so re-queuing would
      // double-send it. Bookkeeping (history, reactions, status message) is
      // best-effort: log and let the turn run.
      logger.error('Post-inject bookkeeping failed', { session: sess.name, error: err.message });
    }
  }, delayMs);
}

/**
 * Clear one session's in-flight turn state so a wedged session takes messages
 * again. Runtime turn state ONLY: the registry, IM credentials, bound topics and
 * the daemon itself are untouched, which makes this idempotent and lossless —
 * safe to run on a healthy session.
 *
 * pendingQueue is deliberately KEPT and re-drained. The point of a reset is to
 * get stuck messages moving, not to discard them.
 *
 * persistStates() at the end is what makes this stick: lastInjectedText is
 * persisted, so before this existed a wedged turn survived even `wrc restart`
 * and there was no way at all to clear it from the IM side.
 *
 * Returns what was cleared, for the receipt.
 */
function resetSessionState(sess, reason = 'manual') {
  const had = {
    injected:   sess.lastInjectedText,
    injectedAt: sess.injectedAt,
    busy:       sess.busy,
    queued:     sess.pendingQueue.length,
    quiz:       !!sess.pendingQuiz,
  };
  cancelQuiz(sess, '（会话已重置）');
  cancelPending(sess);
  stopTurnStatus(sess);
  sess.lastInjectedText       = null;
  sess.lastInjectedTranscript = null;
  sess.injectedTarget         = '';
  sess.injectedMessageId      = '';
  sess.injectedAt             = 0;
  sess.busy                   = false;
  // Frees the per-turn dedup slot; any orphan-poll chain still running sees
  // lastInjectedText change and retires itself on its next tick.
  sess.orphanPollText         = null;
  sess.interruptRequestedAt   = 0;
  sess.injectFailCount        = 0;
  sess.pendingSelect          = null;
  persistStates();
  logger.warn('Session turn state reset', {
    session: sess.name, reason, busy: had.busy, queued: had.queued,
    injected: had.injected?.slice(0, 60) || null,
  });
  scheduleInject(sess);   // drain anything that was queued behind the wedge
  return had;
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
 * Private-chat / WeChat fallback: several sessions share one conversation, so
 * tag a reply with its origin session. Topic-routed replies need no tag.
 */
function tagForTarget(reg, sess, target, text) {
  const entry = reg.sessions[sess.name];
  const viaTopic = !!(entry?.imTarget && entry.imTarget === target);
  return (!viaTopic && Object.keys(reg.sessions).length > 1) ? `【${sess.name}】\n${text}` : text;
}

/**
 * Scan the turn's transcript for unsent interim text blocks (prose emitted
 * before tool calls — the pieces findResponseToInjected drops) and forward the
 * meaningful ones in order. Every scan is chained on sess.interimChain, so
 * overlapping scans, the end-of-turn flush, and the final forward can never
 * interleave or reorder. `anchor` is the lastInjectedText captured when the
 * scan was scheduled; live scans abort once the turn resolves or changes,
 * while the end-of-turn flush passes live=false because it runs on the
 * captured anchor AFTER pushResponse cleared the session state.
 * Returns the chained promise so callers can order work after it.
 */
function runInterimScan(sess, anchor, readPath, { live = true } = {}) {
  const job = async () => {
    if (!FORWARD_INTERIM || !transport || !anchor || !readPath) return;
    if (live && sess.lastInjectedText !== anchor) return;   // turn resolved/changed
    const entries = parseTranscript(readPath, TRANSCRIPT_TAIL_BYTES);
    const blocks = findInterimTexts(entries, anchor);
    const target = sess.injectedTarget || lastTarget;
    if (!target) return;
    const reg = readSessions();
    for (const b of blocks) {
      if (b.text.length < INTERIM_MIN_LEN) continue;
      // ANY overlap with the sent set counts as sent: if a message's text lines
      // flushed across two scans, re-sending the merged block would duplicate
      // the part that already went out — losing a rare tail fragment is the
      // lesser evil.
      if (b.uuids.some(u => sess.interimSentUuids.includes(u))) continue;
      if (live && sess.lastInjectedText !== anchor) return;  // re-check before each send
      // forwardResponse handles its own retries and never throws — a send
      // failure cannot wedge the chain.
      await forwardResponse(target, tagForTarget(reg, sess, target, b.text),
                            { filename: docFilename(sess.name) });
      sess.interimSentUuids.push(...b.uuids);
      if (sess.interimSentUuids.length > 400) sess.interimSentUuids = sess.interimSentUuids.slice(-200);
      sess.interimLastText = b.text;
      persistStates();  // restart mid-turn must not resend these blocks
      appendHistory({ type: 'assistant_interim', session: sess.name, text: b.text.slice(0, 500) });
      logger.info('Forwarded interim block', { session: sess.name, chars: b.text.length });
    }
  };
  const chained = (sess.interimChain || Promise.resolve()).then(job, job);
  sess.interimChain = chained.catch(err => logger.warn('Interim scan failed', { error: err.message }));
  return sess.interimChain;
}

/**
 * Forward a complete assistant response to the IM and clear injection state.
 * Uses the reply target captured at injection time (injectedTarget) — NOT the
 * live "latest" target — so a newer incoming message can't redirect this reply
 * to the wrong conversation. Shared by every Claude/Codex forward path.
 * opts.dedupeInterim: the caller pushed an INCOMPLETE text (idle cleanup) —
 * that is really the last interim block, so skip the final forward when the
 * flush (or an earlier scan) already delivered it. Decided AFTER the flush
 * runs, because the flush itself may be the one that sends it.
 */
function pushResponse(sess, responseText, opts = {}) {
  const target = sess.injectedTarget || lastTarget;
  const messageId = sess.injectedMessageId;
  // Snapshot the turn BEFORE clearing it: the end-of-turn interim flush below
  // runs on the captured anchor after lastInjectedText is gone.
  const flushAnchor   = sess.lastInjectedText;
  const flushReadPath = sess.lastInjectedTranscript;
  // Final status-message edit: turn summary replaces the live progress line.
  finishTurnStatus(sess, `✅ 完成 · ${sess.turnToolCount} 个工具 · ${fmtDur(Date.now() - sess.turnStartedAt)}`);
  if (transport && target) transport.sendTyping(target, false).catch(() => {});
  reactTo(target, messageId, '👍');
  sess.lastPushedText         = responseText;
  sess.lastInjectedText       = null;
  sess.lastInjectedTranscript = null;
  sess.injectedTarget         = '';
  sess.injectedMessageId      = '';
  sess.injectedAt             = 0;
  // Deliberately NOT clearing sess.busy here: orphan polls / deferred retries /
  // restart reconciliation can reach this long after our turn ended, while a
  // NEW terminal-initiated turn legitimately holds busy — clearing would let
  // the inbound gate inject mid-turn. busy ownership: set by PreToolUse /
  // UserPromptSubmit; cleared by Stop, abandonTurn, the pane-routed idle
  // Notification, and the interrupt busy-clear poll.
  persistStates();
  appendHistory({ type: 'assistant', session: sess.name, text: responseText.slice(0, 500) });
  // target is always set in the normal flow (every queued message carries one),
  // but guard defensively so we never call forwardResponse with an empty target.
  if (!target) {
    logger.error('pushResponse: no reply target, dropping forward', { chars: responseText.length });
    return;
  }
  const reg = readSessions();
  const out = tagForTarget(reg, sess, target, responseText);
  // Backstop: interim blocks the PreToolUse ticks missed go out BEFORE the
  // final response. Chained on interimChain, so an in-flight scheduled scan
  // finishes first, then this flush, then the final — never out of order.
  const flush = (FORWARD_INTERIM && sessionKind(reg.sessions[sess.name]) === 'claude')
    ? runInterimScan(sess, flushAnchor, flushReadPath, { live: false })
    : Promise.resolve();
  const finalJob = async () => {
    // interimLastText is read AFTER the flush: it reflects everything delivered
    // as interim, including a block the flush itself just sent. endsWith covers
    // a merged multi-line block whose tail line is the pseudo-final text.
    if (opts.dedupeInterim && sess.interimLastText
        && (sess.interimLastText === responseText || sess.interimLastText.endsWith(responseText))) {
      logger.info('Final text already delivered as interim, skipping forward', { session: sess.name, chars: responseText.length });
      return;
    }
    await forwardResponse(target, out, { filename: docFilename(sess.name) });
  };
  // The final forward joins the chain too, so the NEXT turn's first interim
  // scan (chained later) cannot land between this turn's response chunks.
  sess.interimChain = flush.then(finalJob, finalJob)
    .catch(err => logger.warn('Final forward failed', { error: err.message }));
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
  // The turn died — flush any captured interim text first; it is all the user
  // will ever get from this turn.
  if (FORWARD_INTERIM && sess.lastInjectedText) {
    runInterimScan(sess, sess.lastInjectedText, sess.lastInjectedTranscript, { live: false });
  }
  finishTurnStatus(sess, `⚠️ ${reason || '未捕获到回复'}`);
  if (transport && target) transport.sendTyping(target, false).catch(() => {});
  reactTo(target, sess.injectedMessageId, '💔');
  sess.lastInjectedText       = null;
  sess.lastInjectedTranscript = null;
  sess.injectedTarget         = '';
  sess.injectedMessageId      = '';
  sess.injectedAt             = 0;
  // Abandoning = we have declared the agent idle (deadline + pane-idle / idle
  // notification). A busy flag outliving the turn it belongs to recreates the
  // wedge: the inbound busy-gate would queue every later message with nothing
  // left to drain it (an interrupted turn fires no Stop to clear busy).
  // Accepted tradeoff: if the extension cap expired while a turn genuinely
  // still runs, the next message lands in the agent's composer — a degradation,
  // versus today's permanent wedge.
  sess.busy = false;
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
    // The pane just went idle without our injected turn having run. Either Codex
    // queued our composer text and auto-submits it now (rollout's latest user
    // message becomes ours; the turn's own Stop — or this poll finding a COMPLETE
    // answer — resolves it), or the user deleted the composer text and our turn
    // will never exist: abandon at the deadline so the session un-wedges instead
    // of refusing injections forever (Codex has no Notification/idle event to
    // clean this up later). The probe deliberately (1) has NO
    // payload.last_assistant_message fallback — that text belongs to the terminal
    // turn that just stopped (wrong-reply hazard), and (2) requires complete ===
    // true — our turn may be RUNNING right now, and pushing streamed partial text
    // would clear the turn state and orphan the real final answer. Deduping vs
    // the post-Stop poll below is lossless: that one is only armed after the
    // payload fallback came up empty.
    armOrphanPoll(
      sess, injected,
      () => {
        const r = agent.responseToInjected(agent.parseRollout(readPath), injected);
        return (r?.text && r.complete) ? r.text : null;
      },
      120_000, 5_000,
      // busy first: UserPromptSubmit marks the auto-submitted turn before the
      // rollout necessarily flushes our user_message (turn-start lag).
      () => sess.busy || agent.latestUserMessage(agent.parseRollout(readPath)) === injected,
    );
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
  // (Codex has no Notification event to act as a later safety net). Supersede
  // any strict terminal-ignore poll still holding the dedup slot: this Stop
  // proves OUR turn is over, so accepting incomplete (flush-lag) text is now
  // safe where the strict poll would only ever abandon. A briefly-overlapping
  // stale chain is harmless — every exit re-checks lastInjectedText first and
  // abandonTurn runs at most once behind that same guard.
  sess.orphanPollText = null;
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
 * Optional `stillInFlight` is consulted only at the deadline: while it returns
 * true the deadline extends by another graceMs, so a genuinely running turn is
 * not abandoned mid-flight.
 */
const ORPHAN_MAX_EXTENSIONS = 10; // cap: worst-case wedge ≈ 10×grace, not forever

function armOrphanPoll(sess, savedInjectedText, probe, graceMs = 5 * 60 * 1000, pollMs = 5_000, stillInFlight = null,
                       abandonReason = '未在时限内捕获到回复，请回终端查看') {
  if (!savedInjectedText) return;
  if (sess.orphanPollText === savedInjectedText) return; // already polling this turn
  sess.orphanPollText = savedInjectedText;
  let deadline = Date.now() + graceMs;
  let extensions = 0;
  const poll = () => {
    if (sess.lastInjectedText !== savedInjectedText) { sess.orphanPollText = null; return; } // resolved elsewhere
    // A probe may return a plain string, or { text, opts } when the forward
    // needs pushResponse options (the interrupt probe passes dedupeInterim so
    // partial text already delivered as interim isn't re-sent).
    const hit = probe();
    if (hit) {
      const { text, opts } = typeof hit === 'string' ? { text: hit, opts: undefined } : hit;
      sess.orphanPollText = null;
      pushResponse(sess, text, opts);
      logger.info('Pushed response via orphan poll', { session: sess.name, chars: text.length });
      scheduleInject(sess);
      return;
    }
    if (Date.now() >= deadline) {
      // The turn may genuinely still be running (e.g. Codex auto-submitted our
      // queued composer text). Extend rather than abandon — but CAP extensions:
      // latestUserMessage stays == injected forever after the turn ends, and
      // busy can stick true on a missed Stop, so an uncapped extension would
      // recreate the permanent wedge this poll exists to prevent.
      if (stillInFlight && extensions < ORPHAN_MAX_EXTENSIONS && stillInFlight()) {
        extensions++;
        deadline = Date.now() + graceMs;
        logger.info('Orphan poll extended, turn still in flight', { session: sess.name, extensions });
        setTimeout(poll, pollMs);
        return;
      }
      logger.warn('Orphan poll grace expired, cleaning up', { session: sess.name, lastInjected: savedInjectedText.slice(0, 60) });
      sess.orphanPollText = null;
      if (sess.lastInjectedText === savedInjectedText) abandonTurn(sess, abandonReason);
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

// Short: the deadline only matters when the interrupted turn produced NO text
// at all (the probe accepts partial text as soon as the pane goes idle), and
// stillInFlight extends it when the Escape didn't actually take.
const INTERRUPT_GRACE_MS = 20_000;

/**
 * Recovery after an Escape was sent on this session's pane. Claude fires NO
 * Stop hook on user interrupt (its idle-Notification net takes 60s+ and never
 * clears `busy`); Codex may fire nothing at all. Without this, an interrupted
 * IM turn wedges the session: lastInjectedText and/or busy stay set forever
 * and the inbound busy-gate queues every later message with nothing to drain
 * it. Recovery here depends only on the transcript + pane content — no hooks.
 */
// `markRequested: false` — no Escape was actually sent (the pane was already
// idle) and we want only the recovery half: arm the short poll so a turn whose
// Stop never arrived resolves from partial text or is abandoned. Marking would
// stamp "⏹ 已请求中断" onto a status message for an interrupt that never
// happened, and would cancel a quiz that nothing dismissed.
function onInterruptRequested(sess, { markRequested = true } = {}) {
  const tmux = tmuxTargetFor(sess);
  if (sess.lastInjectedText) {
    if (markRequested) {
      // The Esc lands on an open AskUserQuestion dialog first — the quiz is gone
      // either way, and clearing it also unblocks editStatus's pendingQuiz skip.
      if (sess.pendingQuiz) cancelQuiz(sess, '（已中断）');
      sess.interruptRequestedAt = Date.now();
      editStatus(sess);  // immediate re-render: interrupt body, ⏹ removed
    }
    const injected = sess.lastInjectedText;
    const entry = readSessions().sessions[sess.name];
    const kind = entry ? sessionKind(entry) : 'claude';
    const readPath = sess.lastInjectedTranscript || entry?.transcriptPath || null;
    const probe = () => {
      if (!readPath) return null;
      const r = kind === 'codex'
        ? getAgent('codex').responseToInjected(getAgent('codex').parseRollout(readPath), injected)
        : findResponseToInjected(parseTranscript(readPath, TRANSCRIPT_TAIL_BYTES), injected);
      if (r?.text && r.complete) return r.text;             // finished before the Esc landed
      // An interrupted turn never reaches end_turn: once the pane is visibly
      // idle, the partial text is all this turn will ever produce — deliver it
      // (deduped against already-sent interim blocks) instead of waiting out
      // the deadline and dropping it (parity with the Notification idle path).
      if (r?.text && !paneShowsWorking(tmux)) return { text: r.text, opts: { dedupeInterim: true } };
      return null;
    };
    // Supersede any longer-grace poll holding the dedup slot (e.g. the 5-min
    // Path C poll or Codex's strict 120s terminal-ignore poll) — interrupt
    // wants the short deadline. Overlap is harmless: every chain exit re-checks
    // lastInjectedText, and abandonTurn runs at most once behind that guard.
    sess.orphanPollText = null;
    armOrphanPoll(sess, injected, probe, INTERRUPT_GRACE_MS, 5_000,
      // Esc didn't take (turn still visibly running) → extend, don't kill a
      // live turn. NOT `() => sess.busy`: busy is exactly the flag that sticks.
      () => paneShowsWorking(tmux),
      '已中断，未捕获到最终回复');
    return;
  }
  // Terminal-initiated turn interrupted remotely (/esc): there is no IM turn to
  // recover, but `busy` may now be stuck true — Codex fires no idle event ever,
  // Claude's takes 60s — gating the inbound queue. Bounded pane check clears it.
  if (sess.busy) armBusyClearAfterInterrupt(sess, tmux);
}

/**
 * Clear a stuck busy flag once the pane visibly stops working. Bounded (≤6
 * checks × 5s). Idempotent — a Stop/Notification landing first makes every
 * tick a no-op, and a new IM turn (lastInjectedText set) aborts it.
 */
function armBusyClearAfterInterrupt(sess, tmux) {
  let checks = 0;
  const tick = () => {
    if (!sess.busy || sess.lastInjectedText) return;   // resolved elsewhere
    if (paneShowsWorking(tmux)) {
      if (++checks < 6) { setTimeout(tick, 5_000); return; }
      logger.info('Interrupt busy-clear: pane still working at give-up, leaving busy to hooks', { session: sess.name });
      return;
    }
    sess.busy = false;
    logger.info('Interrupt: pane idle, cleared stuck busy flag', { session: sess.name });
    scheduleInject(sess);
  };
  setTimeout(tick, 5_000);
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
    if (sess.pendingQuiz) {
      // A complete response means AskUserQuestion has returned — the quiz was
      // answered (or dismissed) at the terminal without the bridge seeing it.
      logger.info('Quiz resolved in terminal, clearing', { session: sess.name });
      cancelQuiz(sess, '（已在终端处理）');
    }
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

  // Interim forwarding: check for meaningful mid-turn text at every tool-call
  // gap. Deferred to a later tick so the synchronous approval reply below is
  // never delayed; debounced so a rapid tool loop doesn't stack scans. Placed
  // before the AUTO_APPROVE opt-out so the feature works either way.
  if (FORWARD_INTERIM && kind === 'claude' && sess.lastInjectedText
      && Date.now() - sess.interimLastScanAt >= INTERIM_SCAN_GAP_MS) {
    sess.interimLastScanAt = Date.now();
    const anchor = sess.lastInjectedText;
    // Pane-routed payloads report their own transcript — trust it over the
    // scanner's inject-time guess (same trust model as onStop). A wrong path
    // is harmless either way: no anchor match → nothing sent.
    const readPath = (route.via === 'pane' && payload.transcript_path)
      ? payload.transcript_path
      : (sess.lastInjectedTranscript || payload.transcript_path || null);
    setTimeout(() => { runInterimScan(sess, anchor, readPath); }, 0);
  }

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
        // Taps on a PREVIOUS quiz's leftover buttons must not answer this one.
        // Timestamp, not a counter: counters (and sids) reset deterministically
        // on daemon restart, so a pre-restart button could collide with a fresh
        // quiz. Chat buttons outlive the process; the guard must too.
        gen: Date.now().toString(36),
        target: quizTarget,
        selected: new Set(),
        msgIds: {},      // qIdx → {messageId, target, text}, for stripping dead buttons
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
      const quizTmux = tmuxTargetFor(sess);
      const q = sess.pendingQuiz.questions[sess.pendingQuiz.questionIndex];
      if (quizTmux && paneExists(quizTmux) && quizOnScreen(quizTmux, q)) {
        logger.info('Notification: CC waiting for quiz input', { session: sess.name });
        return;
      }
      // A stale quiz would suppress the compaction/orphan handling below (and
      // the status heartbeat) indefinitely now that there is no TTL — this
      // Notification is the sweeper that keeps staleness bounded.
      logger.info('Notification: pendingQuiz no longer on screen, clearing', { session: sess.name });
      cancelQuiz(sess, '（已失效）');
    }
    const target = tmuxTargetFor(sess);
    if (target && tryAutoConfirmCompaction(sess, target)) {
      logger.info('Auto-confirmed compaction via Notification', { session: sess.name });
      return;
    }
    // idle_prompt is the pane's own "I'm idle" statement. Pane-routed events are
    // authoritative for THIS session: whatever turn was running (IM or terminal,
    // interrupted or missed-Stop) is over — the busy interlock must not outlive
    // it, or the inbound busy-gate queues messages forever. Fallback-routed
    // events may belong to a same-cwd sibling whose idle says nothing about OUR
    // pane; clearing busy on those could unblock injection into a genuinely
    // mid-turn pane, so leave them alone.
    if (route.via === 'pane' && sess.busy) {
      logger.info('Notification: pane idle, clearing busy flag', { session: sess.name });
      sess.busy = false;
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
          // An incomplete result here is really the LAST interim text, not a
          // final — let pushResponse skip the forward if interim delivery
          // (including its own end-of-turn flush) already sent it.
          pushResponse(sess, result.text, { dedupeInterim: !result.complete });
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
      // Drain messages queued behind a now-cleared busy interlock (a terminal-
      // side interrupt fires no Stop; this idle event is the only signal left).
      if (!sess.busy) scheduleInject(sess);
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
    '  /rnt <新名> — 重命名 tmux 会话（组）' + (transport?.caps.topics ? '，/ls 菜单里也可点 ✏️' : '') + '\n' +
    '  /model — 切换模型（文字菜单，无需终端交互）\n' +
    '  /esc — 中断当前回合\n' +
    '  /reset — 会话卡在「忙碌」不动时，清掉回合状态（消息不丢；/reset all 全部）\n\n' +
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

  // ── Pending tmux-session rename (reply to a ✏️ ForceReply prompt) ──
  // Only an EXACT prompt-id match intercepts: forum-topic messages carry
  // reply_to_message pointing at the topic's root service message even when
  // the user didn't reply, so mere presence must never trigger this. Non-reply
  // text always falls through to normal routing/injection.
  if (inbound.replyToMessageId) {
    if (retiredRenamePrompts.has(inbound.replyToMessageId)) {
      // A name meant for a superseded/expired prompt — never inject it.
      transport.sendText(replyTarget, '⏰ 已过期，请重新点击 ✏️').catch(() => {});
      return;
    }
    if (pendingTmuxRename && inbound.replyToMessageId === pendingTmuxRename.promptMessageId) {
      handleTmuxRenameReply(inbound)
        .catch(err => logger.error('tmux rename reply failed', { error: err.message }));
      return;
    }
  }

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

  // Consume a pending quiz (typed answer) for the context session — but only
  // while the quiz is really still on the terminal screen (see quizOnScreen).
  if (sess?.pendingQuiz) {
    const quiz = sess.pendingQuiz;
    const q = quiz.questions[quiz.questionIndex];
    const quizTmux = tmuxTargetFor(sess);
    if (!quizTmux || !paneExists(quizTmux)) {
      cancelQuiz(sess, '（已失效）');
      transport.sendText(replyTarget, '❌ tmux 不可用，问卷已取消').catch(() => {});
      return;
    }
    if (quizOnScreen(quizTmux, q)) {
      handleQuizResponse(sess, text, replyTarget);
      return;
    }
    logger.info('pendingQuiz no longer on screen, clearing');
    cancelQuiz(sess, '（已失效）');
    transport.sendText(replyTarget, '💤 终端已离开问卷界面（可能已在终端作答或已取消），问卷已取消，本条按普通消息处理').catch(() => {});
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
  else if (/^\/rnt(\s|$)/i.test(cmdText)) cmdText = '#rnt' + cmdText.slice(4);
  else if (/^\/model(\s|$)/i.test(cmdText)) cmdText = '#model' + cmdText.slice(6);
  else if (/^\/bind\b/i.test(cmdText)) cmdText = '#bind';
  else if (/^\/esc\b/i.test(cmdText)) cmdText = '#esc';
  // /reset MUST be intercepted here. `reset` is a live, remotable Claude Code
  // builtin that clears the conversation, so falling through would wipe the
  // history of the very session we are trying to un-wedge. Deliberately shadows
  // it: someone typing /reset from the IM wants the session un-stuck, and the
  // receipt says plainly what it did. The agent's own /reset stays available in
  // the terminal.
  //
  // `\b` not `(\s|$)`, matching /ls and /esc: Telegram group members send
  // `/reset@botname`, which `(\s|$)` rejected — straight into the fall-through
  // above. `all` is then read from anywhere in the text so the @suffix cannot
  // land in the argument.
  else if (/^\/(reset|unstick)\b/i.test(cmdText)) cmdText = /\ball\b/i.test(cmdText) ? '#reset all' : '#reset';
  else if (/^\/start\b/i.test(cmdText)) {
    // Telegram /start (BotFather flow) → welcome/usage text. /help stays a
    // remotable CC builtin (inject + capture), as before.
    const kind = routed ? sessionKind(reg.sessions[routed.name]) : '';
    transport.sendText(replyTarget, buildWelcome({ reconnect: false, kind })).catch(() => {});
    return;
  }

  if (cmdText.startsWith('#')) {
    handleBridgeCommand(cmdText, replyTarget, sess, !!routed?.viaTopic);
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
  { command: 'rnt',    description: '重命名 tmux 会话（组）' },
  { command: 'esc',    description: '中断当前回合' },
  { command: 'reset',  description: '会话卡在忙碌不动时，重置回合状态（消息不丢）' },
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
    // 0 for state files written before injectedAt existed — /ls then reports the
    // age as unknown rather than pretending the turn started in 1970.
    sess.injectedAt             = turn.injectedAt || 0;
    sess.interimSentUuids       = turn.interimSentUuids || [];
    sess.interimLastText        = turn.interimLastText || null;
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

  /**
   * 'none' → 'armed' (timeouts armed, pushes deferred) → 'full' (pushes allowed).
   *
   * Splitting these fixes a specific permanent ghost. This used to run ONLY from
   * the transport 'ready' branch, so when the transport never became ready
   * (expired credentials, a Telegram 409, no network) a restored
   * lastInjectedText was never reconciled, NO orphan poll was ever armed, and
   * persistStates kept writing it back to disk. That session then read busy
   * forever — across days and across restarts — with nothing able to clear it.
   *
   * Arming a timeout needs no transport at all; only pushing a reply does. So
   * the armed pass runs unconditionally and guarantees every restored turn
   * eventually resolves or is abandoned, while the full pass still takes the
   * fast path when the transport does come up.
   */
  let reconciledStage = 'none';
  function reconcileRestoredTurn({ canPush = true } = {}) {
    if (reconciledStage === 'full') return;                // ready may fire more than once
    if (reconciledStage === 'armed' && !canPush) return;   // already armed; nothing new
    const upgrading = reconciledStage === 'armed';
    reconciledStage = canPush ? 'full' : 'armed';
    logger.info('Reconciling restored turns', { canPush, upgrading });
    const regNow = readSessions();
    for (const sess of sessionStates.values()) {
      if (!sess.lastInjectedText) continue;
      // The armed pass already claimed this turn's dedup slot; release it so the
      // full pass can re-arm and take the push fast path. Same idiom as
      // onStopCodex / onInterruptRequested superseding a live poll.
      if (upgrading) sess.orphanPollText = null;
      // injectedTarget may be missing on legacy restores — fall back to the last
      // known reply target so a recovered response still reaches the user.
      if (!sess.injectedTarget) sess.injectedTarget = lastTarget || '';
      logger.info('Reconciling in-flight turn restored from previous run', {
        session: sess.name, lastInjected: sess.lastInjectedText.slice(0, 60), transcript: sess.lastInjectedTranscript?.slice(-40),
      });
      // Probe with the parser matching the session's agent — the Claude parser
      // never matches a Codex rollout, which used to mean restored Codex turns
      // could only ever be abandoned at the deadline, never recovered. Registry
      // entry can be missing right after restart (pruned/renamed before ready) —
      // the rollout path prefix is then the kind signal; defaulting to claude
      // would silently repeat that bug.
      const entry = regNow.sessions[sess.name];
      const kind = entry ? sessionKind(entry)
        : (sess.lastInjectedTranscript?.startsWith(CODEX_SESSIONS) ? 'codex' : 'claude');
      if (kind === 'codex') {
        const agent = getAgent('codex');
        const tpath = sess.lastInjectedTranscript;
        const injected = sess.lastInjectedText;
        const probe = () => {
          if (!tpath) return null;
          const r = agent.responseToInjected(agent.parseRollout(tpath), injected);
          return (r?.text && r.complete) ? r.text : null;
        };
        // canPush gates only the fast path. Without a live transport the send
        // would fail its retries and the reply would be lost, so leave the turn
        // to the poll below: it re-probes every 5s and pushes the moment the
        // transport is usable, and abandons the turn if it never is.
        const done = canPush ? probe() : null;
        if (done) {
          pushResponse(sess, done);
          logger.info('Restored codex turn already complete; pushed on startup', { chars: done.length });
          scheduleInject(sess);
          continue;
        }
        // After restart sess.busy starts false and only PreToolUse re-sets it,
        // so the latest === injected leg carries pure-text turns.
        armOrphanPoll(sess, injected, probe, undefined, undefined,
          () => sess.busy || (!!tpath && agent.latestUserMessage(agent.parseRollout(tpath)) === injected));
        continue;
      }
      if (canPush && sess.lastInjectedTranscript) {
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
      // wedging lastInjectedText forever.
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

      // Reconcile any in-flight turn restored from a previous run. The fast path
      // lives here because the transport's sender/api is only initialised by now,
      // so pushResponse can actually deliver. The armed fallback below covers the
      // case where this branch never runs at all.
      reconcileRestoredTurn({ canPush: true });
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
      // 'ready' is never coming, so stop waiting for it: arm the recovery
      // timeouts now rather than leaving restored turns wedged until someone
      // re-logs in.
      reconcileRestoredTurn({ canPush: false });
    }
  }

  // Last-resort arming. If 'ready' has not fired a full minute after startup,
  // something is wrong with the transport (bad credentials, a 409, no network)
  // and it may never fire — but restored turns must still resolve or expire.
  // The delay is deliberate: firing immediately would beat a healthy transport's
  // 1-2s handshake and needlessly downgrade a reply we could have pushed at once.
  const RECONCILE_FALLBACK_MS = 60_000;
  setTimeout(() => reconcileRestoredTurn({ canPush: false }), RECONCILE_FALLBACK_MS).unref?.();

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
