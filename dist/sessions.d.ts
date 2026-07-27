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
export declare function sessionKeyFor(entry: Pick<RegistryEntry, 'paneId' | 'tmux'>): string;
/**
 * The tmux session an entry lives in, from its "session:window.pane"
 * coordinates. tmux forbids ':' in session names, so the first segment is
 * always the session; the scanner refreshes coordinates every pass, so this
 * self-heals when a window moves between sessions.
 */
export declare function tmuxSessionOf(entry: Pick<RegistryEntry, 'tmux'>): string;
/**
 * The focus filter to actually apply: a focusedTmuxSession that no longer has
 * any live registry entry degrades to null (no filter) so the user is never
 * left staring at an empty topic list.
 */
export declare function effectiveFocus(reg: Registry): string | null;
/**
 * Registry names grouped by tmux session — the focused group first, groups and
 * members otherwise in registry order. The single source of display order for
 * the session list, its buttons and `#sw <n>` numeric resolution, so the
 * numbers the user sees always resolve to the sessions they name.
 */
export declare function orderedSessionNames(reg: Registry): string[];
/**
 * Make a Telegram-typed name safe as a bridge session name: tmux window
 * targets use ':' and '.' as separators and injection is line-based, so those
 * become '-'. Returns '' when nothing usable survives.
 */
export declare function sanitizeSessionName(raw: string): string;
export interface GroupRenameResult {
    /** Registry entry names whose tmux coordinates were rewritten. */
    renamed: string[];
    /**
     * Runtime-state key migrations for entries WITHOUT a paneId: their
     * sessionKeyFor() is `tmux:<coords>` and changes with the rewrite, so the
     * caller must re-key any live state maps. paneId-bearing entries keep their
     * key and produce no migration.
     */
    keyMigrations: Array<{
        from: string;
        to: string;
    }>;
}
/**
 * Rewrite every registry trace of a tmux-session (group) rename: each member
 * entry's coordinates get the new session prefix, and focusedTmuxSession
 * follows when it named the old group. Membership is decided by tmuxSessionOf
 * EQUALITY, never a string prefix — renaming "alpha" must not capture
 * "alpha2:1.0". Mutates reg in place; the caller runs `tmux rename-session`
 * FIRST and only calls this on success — the scanner rewrites coords from
 * live tmux every pass, so a registry-only rename would be reverted within
 * one scan interval.
 */
export declare function renameTmuxGroupInRegistry(reg: Registry, oldName: string, newName: string): GroupRenameResult;
export interface QueuedMessage {
    text: string;
    /** Opaque reply target captured at receive time. */
    target: string;
    /** IM message id of the user's message (reactions), when the transport provides one. */
    messageId?: string;
}
export interface PendingQuiz {
    questions: Array<{
        question: string;
        options: Array<{
            label: string;
            description?: string;
        }>;
        multiSelect?: boolean;
    }>;
    questionIndex: number;
    /** Per-quiz nonce (timestamp) — a tap on a previous quiz's leftover buttons, even from before a daemon restart, must not answer this one. */
    gen: string;
    target: string;
    selected: Set<number>;
    /** qIdx → sent IM message, so answered/cancelled questions can drop their inline keyboard. */
    msgIds: Record<number, {
        messageId: string;
        target: string;
        text: string;
    }>;
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
    /**
     * When an IM-side interrupt (⏹ / #esc) was sent for the in-flight turn, else
     * 0. Freezes the status message into its "已请求中断" form and gates a repeat
     * Escape from the button (a second Esc on an already-idle pane opens CC's
     * rewind dialog). Not persisted: a daemon restart re-arms turn recovery via
     * reconcileRestoredTurn anyway.
     */
    interruptRequestedAt: number;
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
    /** uuids of interim blocks already forwarded this turn (dedup; capped). */
    interimSentUuids: string[];
    /** Debounce stamp for PreToolUse-triggered interim scans. */
    interimLastScanAt: number;
    /** Per-session serialization chain: scans / end-of-turn flush / final forward run in order. */
    interimChain: Promise<void> | null;
    /** Text of the last interim block forwarded (guards the idle-cleanup duplicate push). */
    interimLastText: string | null;
}
/** Reset the sid counter (tests only). */
export declare function resetSidCounter(): void;
export declare function newSessionState(key: string, name: string): SessionState;
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
export declare function resolveSessionForHook(reg: Registry, states: StatesView, payload: HookPayloadLike): HookRoute | null;
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
export declare function resolveSessionForInbound(reg: Registry, target: string): InboundRoute | null;
/** The minimal per-session fields persisted for daemon-restart turn recovery. */
export interface PersistedTurn {
    name: string;
    lastInjectedText: string | null;
    lastInjectedTranscript: string | null;
    injectedTarget: string;
    injectedMessageId: string;
    /** Interim blocks already forwarded this turn — a restart must not resend them. */
    interimSentUuids: string[];
    /** Last interim text forwarded — the idle-cleanup dup guard must survive a restart too. */
    interimLastText: string | null;
}
export declare function persistableState(s: SessionState): PersistedTurn;
/**
 * One-time migration of a legacy ilink_session.json that still carries
 * in-flight turn fields: attach them to the active session's key so the
 * restored turn is recovered under the per-session model.
 */
export declare function migrateLegacyIlink(ilink: {
    lastInjectedText?: string | null;
    lastInjectedTranscript?: string | null;
    target?: string;
}, reg: Registry): Record<string, PersistedTurn>;
export type TopicOp = {
    op: 'create';
    name: string;
    replay: boolean;
} | {
    op: 'reopen';
    name: string;
    imTarget: string;
} | {
    op: 'rename';
    name: string;
    imTarget: string;
} | {
    op: 'remove';
    name: string;
    imTarget: string;
};
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
export declare function planTopicSync(reg: Registry, busy?: ReadonlySet<string>): TopicOp[];
export {};
