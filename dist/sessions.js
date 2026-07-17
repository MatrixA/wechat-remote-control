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
/** Stable runtime key for a registry entry. */
export function sessionKeyFor(entry) {
    return entry.paneId || `tmux:${entry.tmux}`;
}
let nextSid = 1;
/** Reset the sid counter (tests only). */
export function resetSidCounter() {
    nextSid = 1;
}
export function newSessionState(key, name) {
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
/**
 * Decide which registered session a hook event belongs to.
 *
 * Chain: pane id (authoritative) → exact transcript match → in-flight injected
 * transcript match → same-project in-flight turn (Claude only; covers
 * compaction/new-transcript) → active session when the payload carries no
 * signal at all. Returns null for genuinely foreign sessions (e.g. a Claude
 * running outside any registered tmux pane).
 */
export function resolveSessionForHook(reg, states, payload) {
    const entries = Object.entries(reg.sessions ?? {});
    if (entries.length === 0)
        return null;
    // Callers pass Map.values() — a one-shot iterator, but the chain below scans
    // the states twice. Materialize once.
    const stateList = [...states];
    // 1. Pane id — reported by hook.py from the agent process's own env.
    const pane = (payload._tmuxPane || '').trim();
    if (pane) {
        const hit = entries.find(([, s]) => s.paneId === pane);
        if (hit)
            return { name: hit[0], via: 'pane' };
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
        const projectHits = [];
        for (const st of stateList) {
            const entry = reg.sessions[st.name];
            if (!entry || (entry.kind ?? 'claude') !== 'claude')
                continue;
            if (!st.lastInjectedText)
                continue;
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
    if (reg.active && reg.sessions[reg.active])
        return { name: reg.active, via: 'active' };
    return null;
}
/**
 * Decide which session an inbound IM message addresses: a session-bound topic
 * target routes to that session; anything else (private chat, the group's
 * General topic, WeChat) routes to the active session.
 */
export function resolveSessionForInbound(reg, target) {
    for (const [name, s] of Object.entries(reg.sessions ?? {})) {
        if (s.imTarget && s.imTarget === target)
            return { name, viaTopic: true };
    }
    if (reg.active && reg.sessions[reg.active])
        return { name: reg.active, viaTopic: false };
    return null;
}
export function persistableState(s) {
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
export function migrateLegacyIlink(ilink, reg) {
    if (!ilink?.lastInjectedText)
        return {};
    const activeName = reg.active;
    const entry = activeName ? reg.sessions?.[activeName] : null;
    if (!activeName || !entry)
        return {};
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
/**
 * Compute the topic operations needed to make the transport's forum topics
 * mirror the registry: every session gets a topic (reopening its tombstone if
 * one exists), renamed entries get their topic renamed. Pure — the caller
 * executes the ops and persists results.
 */
export function planTopicSync(reg) {
    const ops = [];
    for (const [name, s] of Object.entries(reg.sessions ?? {})) {
        if (!s.imTarget) {
            const tomb = reg.closedTopics?.[name];
            ops.push(tomb ? { op: 'reopen', name, imTarget: tomb } : { op: 'create', name });
        }
        else if (s.topicName && s.topicName !== name) {
            ops.push({ op: 'rename', name, imTarget: s.imTarget });
        }
    }
    return ops;
}
