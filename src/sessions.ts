/**
 * Multi-session core: registry/session-state types plus the pure resolution
 * helpers that decide which tmux session a hook event or an inbound IM message
 * belongs to. All functions here are side-effect free so they can be unit
 * tested; the daemon (src/index.js) owns the actual Map of live SessionStates
 * and all I/O.
 *
 * Identity model:
 *  - sessions.json stays keyed by display name (attach writer, #rename and the
 *    list UI all speak names), but every entry carries `paneId` — tmux's
 *    #{pane_id} (e.g. "%5") — which is stable across window renames/moves and
 *    is what hook.py can self-report via the TMUX_PANE env var.
 *  - The runtime SessionState map is keyed by sessionKeyFor(entry): the paneId
 *    when known, else the tmux coordinates (pre-migration fallback; the next
 *    scan pass backfills paneId and reconciles).
 */
import { isSameProjectDir } from './constants.js';
import type { AgentKind } from './constants.js';

export interface RegistryEntry {
  tmux: string;
  cwd: string;
  transcriptPath?: string | null;
  kind?: AgentKind;
  lastSeen?: number;
  pinnedName?: string;
  /** tmux #{pane_id} (e.g. "%5") — authoritative routing key for hook events. */
  paneId?: string;
  /** Opaque transport target bound to this session (a Telegram forum topic). */
  imTarget?: string;
  /** Name the imTarget (topic) currently displays; drift from the registry key means "rename the topic". */
  topicName?: string;
  /**
   * The session's topic was deleted (focus switch or user deletion). When a
   * topic is created for it again, replay recent conversation context — the
   * old thread's history is gone.
   */
  topicPurged?: boolean;
}

export interface Registry {
  active: string | null;
  sessions: Record<string, RegistryEntry>;
  /**
   * Tombstones for pruned sessions that owned a topic: name → imTarget. A
   * session reappearing under the same name reopens its old topic instead of
   * creating a duplicate.
   */
  closedTopics?: Record<string, string>;
  /**
   * When set, only sessions living in this tmux session keep forum topics;
   * every other session's topic is deleted (recreated with a context replay on
   * refocus). Unset/null = no filter, every session gets a topic.
   */
  focusedTmuxSession?: string | null;
}

/** Stable runtime key for a registry entry. */
export function sessionKeyFor(entry: Pick<RegistryEntry, 'paneId' | 'tmux'>): string {
  return entry.paneId || `tmux:${entry.tmux}`;
}

/**
 * The tmux session an entry lives in, from its "session:window.pane"
 * coordinates. tmux forbids ':' in session names, so the first segment is
 * always the session; the scanner refreshes coordinates every pass, so this
 * self-heals when a window moves between sessions.
 */
export function tmuxSessionOf(entry: Pick<RegistryEntry, 'tmux'>): string {
  return entry.tmux.split(':')[0];
}

/**
 * The focus filter to actually apply: a focusedTmuxSession that no longer has
 * any live registry entry degrades to null (no filter) so the user is never
 * left staring at an empty topic list.
 */
export function effectiveFocus(reg: Registry): string | null {
  const focus = reg.focusedTmuxSession;
  if (!focus) return null;
  for (const s of Object.values(reg.sessions ?? {})) {
    if (tmuxSessionOf(s) === focus) return focus;
  }
  return null;
}

/**
 * Registry names grouped by tmux session — the focused group first, groups and
 * members otherwise in registry order. The single source of display order for
 * the session list, its buttons and `#sw <n>` numeric resolution, so the
 * numbers the user sees always resolve to the sessions they name.
 */
export function orderedSessionNames(reg: Registry): string[] {
  const focus = effectiveFocus(reg);
  const groups = new Map<string, string[]>();
  for (const [name, s] of Object.entries(reg.sessions ?? {})) {
    const group = tmuxSessionOf(s);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push(name);
  }
  const ordered = [...groups.keys()].sort((a, b) => (a === focus ? -1 : 0) - (b === focus ? -1 : 0));
  return ordered.flatMap((g) => groups.get(g)!);
}

/**
 * Make a Telegram-typed name safe as a bridge session name: tmux window
 * targets use ':' and '.' as separators and injection is line-based, so those
 * become '-'. Returns '' when nothing usable survives.
 */
export function sanitizeSessionName(raw: string): string {
  return raw.trim().replace(/[:.\n\t]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '').trim();
}

export interface QueuedMessage {
  text: string;
  /** Opaque reply target captured at receive time. */
  target: string;
  /** IM message id of the user's message (reactions), when the transport provides one. */
  messageId?: string;
}

export interface PendingQuiz {
  questions: Array<{ question: string; options: Array<{ label: string; description?: string }>; multiSelect?: boolean }>;
  questionIndex: number;
  expires: number;
  target: string;
  selected: Set<number>;
}

export interface PendingSelect {
  type: 'model';
  expires: number;
}

/**
 * Per-session runtime state. One instance per discovered tmux session; every
 * field that used to be a module-level global in index.js lives here so
 * sessions run fully independent turns.
 */
export interface SessionState {
  /** sessionKeyFor(entry) at creation time. */
  key: string;
  /** Short numeric id for inline-keyboard callback_data (stable within one daemon run). */
  sid: number;
  /** Registry display name; refreshed by the scanner on rename. */
  name: string;

  pendingQueue: QueuedMessage[];
  injectTimer: ReturnType<typeof setTimeout> | null;

  lastInjectedText: string | null;
  lastInjectedTranscript: string | null;
  /** Opaque reply target of the in-flight turn. */
  injectedTarget: string;
  /** IM message id of the in-flight turn's user message (for reactions). */
  injectedMessageId: string;

  busy: boolean;
  slashCaptureBusy: boolean;

  // Live turn-status message (edit-capable transports) / heartbeat (others).
  statusMsgId: string | null;
  turnStartedAt: number;
  turnToolCount: number;
  turnLastTool: string;
  statusEditTimer: ReturnType<typeof setTimeout> | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  heartbeatSentOnce: boolean;

  pendingQuiz: PendingQuiz | null;
  pendingSelect: PendingSelect | null;

  orphanPollText: string | null;
  compactionGraceUntil: number;
  compactionGraceTranscript: string | null;
  lastPushedText: string | null;
}

let nextSid = 1;

/** Reset the sid counter (tests only). */
export function resetSidCounter(): void {
  nextSid = 1;
}

export function newSessionState(key: string, name: string): SessionState {
  return {
    key,
    sid: nextSid++,
    name,
    pendingQueue: [],
    injectTimer: null,
    lastInjectedText: null,
    lastInjectedTranscript: null,
    injectedTarget: '',
    injectedMessageId: '',
    busy: false,
    slashCaptureBusy: false,
    statusMsgId: null,
    turnStartedAt: 0,
    turnToolCount: 0,
    turnLastTool: '',
    statusEditTimer: null,
    heartbeatTimer: null,
    heartbeatSentOnce: false,
    pendingQuiz: null,
    pendingSelect: null,
    orphanPollText: null,
    compactionGraceUntil: 0,
    compactionGraceTranscript: null,
    lastPushedText: null,
  };
}

// ── Hook event routing ───────────────────────────────────────────────

export interface HookPayloadLike {
  _tmuxPane?: string;
  transcript_path?: string;
}

export type HookRouteVia = 'pane' | 'transcript' | 'inflight' | 'project' | 'active';

export interface HookRoute {
  name: string;
  /**
   * How the session was identified. 'pane' is authoritative (the hook
   * self-reported its TMUX_PANE): the payload's transcript_path can then be
   * trusted over the scanner's guess. Everything else is a fallback for old
   * hook.py copies that don't send _tmuxPane.
   */
  via: HookRouteVia;
}

type StatesView = Iterable<Pick<SessionState, 'name' | 'lastInjectedText' | 'lastInjectedTranscript'>>;

/**
 * Decide which registered session a hook event belongs to.
 *
 * Chain: pane id (authoritative) → exact transcript match → in-flight injected
 * transcript match → same-project in-flight turn (Claude only; covers
 * compaction/new-transcript) → active session when the payload carries no
 * signal at all. Returns null for genuinely foreign sessions (e.g. a Claude
 * running outside any registered tmux pane).
 */
export function resolveSessionForHook(
  reg: Registry,
  states: StatesView,
  payload: HookPayloadLike,
): HookRoute | null {
  const entries = Object.entries(reg.sessions ?? {});
  if (entries.length === 0) return null;
  // Callers pass Map.values() — a one-shot iterator, but the chain below scans
  // the states twice. Materialize once.
  const stateList = [...states];

  // 1. Pane id — reported by hook.py from the agent process's own env.
  const pane = (payload._tmuxPane || '').trim();
  if (pane) {
    const hit = entries.find(([, s]) => s.paneId === pane);
    if (hit) return { name: hit[0], via: 'pane' };
    // No paneId match: either a foreign pane, or a just-attached entry the
    // scanner hasn't stamped yet — fall through to the transcript chain.
  }

  const tpath = payload.transcript_path || '';
  if (tpath) {
    // 2a. Exact registry transcript match (prefer the active session if the
    // scanner ever assigned the same file to two entries).
    const byEntry = entries.filter(([, s]) => s.transcriptPath === tpath);
    if (byEntry.length > 0) {
      const active = byEntry.find(([n]) => n === reg.active);
      return { name: (active ?? byEntry[0])[0], via: 'transcript' };
    }
    // 2b. An in-flight turn whose injected transcript matches (scanner
    // flip-flopped the entry's transcriptPath between inject and Stop).
    for (const st of stateList) {
      if (st.lastInjectedTranscript && st.lastInjectedTranscript === tpath && reg.sessions[st.name]) {
        return { name: st.name, via: 'inflight' };
      }
    }
    // 3. Same-project fallback (Claude only): an in-flight turn whose
    // transcript lives in the same project dir — covers post-compaction
    // transcript swaps for old hook.py copies without _tmuxPane.
    const projectHits: string[] = [];
    for (const st of stateList) {
      const entry = reg.sessions[st.name];
      if (!entry || (entry.kind ?? 'claude') !== 'claude') continue;
      if (!st.lastInjectedText) continue;
      if (isSameProjectDir(tpath, st.lastInjectedTranscript || entry.transcriptPath)) {
        projectHits.push(st.name);
      }
    }
    if (projectHits.length > 0) {
      const active = projectHits.find((n) => n === reg.active);
      return { name: active ?? projectHits[0], via: 'project' };
    }
    // 3b. Same project as the ACTIVE entry without an in-flight turn (keeps
    // busy-marking working for terminal-initiated turns after a transcript swap).
    if (reg.active && reg.sessions[reg.active]) {
      const a = reg.sessions[reg.active];
      if ((a.kind ?? 'claude') === 'claude' && isSameProjectDir(tpath, a.transcriptPath)) {
        return { name: reg.active, via: 'project' };
      }
    }
    return null;
  }

  // 4. No pane, no transcript (legacy/minimal payload) → assume active.
  if (reg.active && reg.sessions[reg.active]) return { name: reg.active, via: 'active' };
  return null;
}

// ── Inbound IM routing ───────────────────────────────────────────────

export interface InboundRoute {
  name: string;
  /** True when the target matched a session-bound topic (vs the active-session fallback). */
  viaTopic: boolean;
}

/**
 * Decide which session an inbound IM message addresses: a session-bound topic
 * target routes to that session; anything else (private chat, the group's
 * General topic, WeChat) routes to the active session.
 */
export function resolveSessionForInbound(reg: Registry, target: string): InboundRoute | null {
  for (const [name, s] of Object.entries(reg.sessions ?? {})) {
    if (s.imTarget && s.imTarget === target) return { name, viaTopic: true };
  }
  if (reg.active && reg.sessions[reg.active]) return { name: reg.active, viaTopic: false };
  return null;
}

// ── Crash-recovery persistence ───────────────────────────────────────

/** The minimal per-session fields persisted for daemon-restart turn recovery. */
export interface PersistedTurn {
  name: string;
  lastInjectedText: string | null;
  lastInjectedTranscript: string | null;
  injectedTarget: string;
  injectedMessageId: string;
}

export function persistableState(s: SessionState): PersistedTurn {
  return {
    name: s.name,
    lastInjectedText: s.lastInjectedText,
    lastInjectedTranscript: s.lastInjectedTranscript,
    injectedTarget: s.injectedTarget,
    injectedMessageId: s.injectedMessageId,
  };
}

/**
 * One-time migration of a legacy ilink_session.json that still carries
 * in-flight turn fields: attach them to the active session's key so the
 * restored turn is recovered under the per-session model.
 */
export function migrateLegacyIlink(
  ilink: { lastInjectedText?: string | null; lastInjectedTranscript?: string | null; target?: string },
  reg: Registry,
): Record<string, PersistedTurn> {
  if (!ilink?.lastInjectedText) return {};
  const activeName = reg.active;
  const entry = activeName ? reg.sessions?.[activeName] : null;
  if (!activeName || !entry) return {};
  return {
    [sessionKeyFor(entry)]: {
      name: activeName,
      lastInjectedText: ilink.lastInjectedText,
      lastInjectedTranscript: ilink.lastInjectedTranscript ?? null,
      injectedTarget: ilink.target || '',
      injectedMessageId: '',
    },
  };
}

// ── Topic lifecycle planning ─────────────────────────────────────────

export type TopicOp =
  | { op: 'create'; name: string; replay: boolean }
  | { op: 'reopen'; name: string; imTarget: string }
  | { op: 'rename'; name: string; imTarget: string }
  | { op: 'remove'; name: string; imTarget: string };

/**
 * Compute the topic operations needed to make the transport's forum topics
 * mirror the registry: every session in focus gets a topic (reopening its
 * tombstone if one exists; `replay` marks a recreate after a purge, so the
 * executor replays recent context into the fresh thread), renamed entries get
 * their topic renamed, and — when a tmux-session focus is set — sessions
 * outside the focus get their topic deleted. `busy` names sessions with an
 * in-flight turn or queued messages: their removal is deferred to a later sync
 * so a reply is never aimed at a thread this pass just deleted. Pure — the
 * caller executes the ops and persists results.
 */
export function planTopicSync(reg: Registry, busy: ReadonlySet<string> = new Set()): TopicOp[] {
  const focus = effectiveFocus(reg);
  const ops: TopicOp[] = [];
  for (const [name, s] of Object.entries(reg.sessions ?? {})) {
    const inFocus = !focus || tmuxSessionOf(s) === focus;
    if (!s.imTarget) {
      if (!inFocus) continue;
      const tomb = reg.closedTopics?.[name];
      ops.push(tomb ? { op: 'reopen', name, imTarget: tomb } : { op: 'create', name, replay: !!s.topicPurged });
    } else if (!inFocus) {
      if (!busy.has(name)) ops.push({ op: 'remove', name, imTarget: s.imTarget });
    } else if (s.topicName && s.topicName !== name) {
      ops.push({ op: 'rename', name, imTarget: s.imTarget });
    }
  }
  return ops;
}
