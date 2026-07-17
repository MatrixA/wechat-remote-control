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
}
/** Stable runtime key for a registry entry. */
export declare function sessionKeyFor(entry: Pick<RegistryEntry, 'paneId' | 'tmux'>): string;
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
} | {
    op: 'reopen';
    name: string;
    imTarget: string;
} | {
    op: 'rename';
    name: string;
    imTarget: string;
};
/**
 * Compute the topic operations needed to make the transport's forum topics
 * mirror the registry: every session gets a topic (reopening its tombstone if
 * one exists), renamed entries get their topic renamed. Pure — the caller
 * executes the ops and persists results.
 */
export declare function planTopicSync(reg: Registry): TopicOp[];
export {};
