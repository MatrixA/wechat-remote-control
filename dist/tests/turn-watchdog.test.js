import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { codexResponseToInjected } from '../codex.js';
// completionProbe lives in the untyped index.js monolith, which starts the daemon
// on import — so extract its source by marker and evaluate it with stubbed
// collaborators (same pattern as interrupt-recovery.test.ts). If the markers
// drift this throws loudly: update them together with the extraction.
const src = readFileSync(new URL('../../src/index.js', import.meta.url), 'utf8');
function cut(from, to) {
    const a = src.indexOf(from), b = src.indexOf(to, a);
    assert.ok(a >= 0 && b > a, `extraction markers not found in src/index.js: ${from} .. ${to}`);
    return src.slice(a, b);
}
/**
 * Build completionProbe over a fake pane + rollout. The codex branch runs the
 * REAL codexResponseToInjected so the complete/incomplete decision under test is
 * the shipped one, not a restatement of it.
 */
function makeProbe(paneWorking, entries) {
    const calls = { paneChecks: 0, rolloutReads: 0, claudeProbes: 0 };
    const factory = new Function('paneShowsWorking', 'getAgent', 'claudeProbe', cut('function completionProbe', '// ── Inject-time turn watchdog')
        .replace(/\/\*\*[\s\S]*?\*\/\s*$/, '') + '\nreturn { completionProbe };');
    const { completionProbe } = factory(() => { calls.paneChecks++; return paneWorking; }, () => ({
        parseRollout: () => { calls.rolloutReads++; return entries; },
        responseToInjected: codexResponseToInjected,
    }), () => () => { calls.claudeProbes++; return 'claude answer'; });
    return { calls, completionProbe };
}
const userMsg = (message) => ({ type: 'event_msg', payload: { type: 'user_message', message } });
const agentMsg = (message, phase) => ({ type: 'event_msg', payload: { type: 'agent_message', message, phase } });
const taskComplete = (last_agent_message) => ({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message } });
const FINISHED = [userMsg('MSG'), agentMsg('the answer'), taskComplete('the answer')];
// Mid-turn: prose streamed, but nothing has marked the turn final yet.
const MID_TURN = [userMsg('MSG'), agentMsg('thinking out loud so far')];
test('completionProbe delivers a codex answer the agent marked final', () => {
    const { completionProbe } = makeProbe(false, FINISHED);
    assert.strictEqual(completionProbe('codex', '/r.jsonl', 'MSG', '%1')(), 'the answer');
});
test('completionProbe accepts phase:final_answer as the final marker', () => {
    const { completionProbe } = makeProbe(false, [userMsg('MSG'), agentMsg('done', 'final_answer')]);
    assert.strictEqual(completionProbe('codex', '/r.jsonl', 'MSG', '%1')(), 'done');
});
// The load-bearing one. Codex stops rendering "esc to interrupt" while a tool
// approval prompt is up, so a pane can read idle in the MIDDLE of a turn. The
// interrupt probe may take partial text (an interrupted turn never reaches a
// final marker); this probe must not, or a half-answer ships as the final one.
test('completionProbe refuses partial text even when the pane looks idle', () => {
    const { calls, completionProbe } = makeProbe(false, MID_TURN);
    assert.strictEqual(completionProbe('codex', '/r.jsonl', 'MSG', '%1')(), null);
    assert.strictEqual(calls.rolloutReads, 1, 'it must have actually looked');
});
test('completionProbe skips the transcript entirely while the pane is working', () => {
    const { calls, completionProbe } = makeProbe(true, FINISHED);
    assert.strictEqual(completionProbe('codex', '/r.jsonl', 'MSG', '%1')(), null);
    // parseRollout reads the WHOLE rollout, and this runs every tick of every
    // turn — the cheap pane gate is what keeps that affordable.
    assert.strictEqual(calls.rolloutReads, 0);
    assert.strictEqual(calls.paneChecks, 1);
});
test('completionProbe ignores an answer belonging to a different user message', () => {
    const { completionProbe } = makeProbe(false, FINISHED);
    assert.strictEqual(completionProbe('codex', '/r.jsonl', 'SOMETHING ELSE', '%1')(), null);
});
test('completionProbe stops at a newer user message', () => {
    const entries = [...FINISHED, userMsg('NEXT'), agentMsg('next answer'), taskComplete('next answer')];
    // Our turn's own final marker still wins; the later turn is not misattributed.
    const { completionProbe } = makeProbe(false, entries);
    assert.strictEqual(completionProbe('codex', '/r.jsonl', 'MSG', '%1')(), 'the answer');
});
test('completionProbe delegates to claudeProbe for claude sessions', () => {
    const { calls, completionProbe } = makeProbe(false, []);
    assert.strictEqual(completionProbe('claude', '/t.jsonl', 'MSG', '%1')(), 'claude answer');
    assert.strictEqual(calls.claudeProbes, 1);
    assert.strictEqual(calls.rolloutReads, 0);
});
test('completionProbe is a no-op without a transcript path', () => {
    const { calls, completionProbe } = makeProbe(false, FINISHED);
    assert.strictEqual(completionProbe('codex', null, 'MSG', '%1')(), null);
    assert.strictEqual(calls.paneChecks, 0, 'nothing to read, so do not even touch tmux');
});
function makeWatchdog(opts) {
    const calls = { pushed: [], sentText: [], warned: [], abandoned: [] };
    const paneShowsWorking = () => opts.paneWorking();
    const probeFactory = new Function('paneShowsWorking', 'getAgent', 'claudeProbe', cut('function completionProbe', '// ── Inject-time turn watchdog')
        .replace(/\/\*\*[\s\S]*?\*\/\s*$/, '') + '\nreturn { completionProbe };');
    const { completionProbe } = probeFactory(paneShowsWorking, () => ({ parseRollout: () => opts.entries, responseToInjected: codexResponseToInjected }), () => () => null);
    const pollFactory = new Function('pushResponse', 'scheduleInject', 'abandonTurn', 'logger', cut('const ORPHAN_MAX_EXTENSIONS', '/** Standard Claude transcript probe')
        + '\nreturn { armOrphanPoll };');
    const { armOrphanPoll } = pollFactory((s, text) => { calls.pushed.push(text); s.lastInjectedText = null; }, () => { }, (s, reason) => { calls.abandoned.push(reason); s.lastInjectedText = null; }, { info: () => { }, warn: (m) => { calls.warned.push(m); }, debug: () => { } });
    const wdFactory = new Function('transport', 'lastTarget', 'tmuxTargetFor', 'sessionKind', 'completionProbe', 'armOrphanPoll', 'paneShowsWorking', 'logger', cut('const WATCHDOG_GRACE_MS', '// Short: the deadline only matters')
        + '\nreturn { armTurnWatchdog, WATCHDOG_GRACE_MS };');
    const api = wdFactory({ sendText: (_t, text) => { calls.sentText.push(text); return Promise.resolve(); } }, 'fallback-target', () => '%1', () => 'codex', completionProbe, armOrphanPoll, paneShowsWorking, { info: () => { }, warn: (m) => { calls.warned.push(m); }, debug: () => { } });
    return { calls, ...api };
}
const sess = (patch = {}) => ({
    name: 'proj', lastInjectedText: 'MSG', lastInjectedTranscript: '/r.jsonl',
    injectedTarget: 'tg-target', orphanPollText: null, ...patch,
});
test('watchdog delivers a finished turn with no Stop hook at all', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { calls, armTurnWatchdog } = makeWatchdog({ paneWorking: () => false, entries: FINISHED });
    const s = sess();
    armTurnWatchdog(s, { kind: 'codex' }, 'MSG');
    t.mock.timers.tick(5_000);
    assert.deepStrictEqual(calls.pushed, ['the answer']);
    assert.strictEqual(s.lastInjectedText, null, 'the turn must be released');
});
test('watchdog waits out a long working turn instead of abandoning it', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    let working = true;
    const { calls, armTurnWatchdog, WATCHDOG_GRACE_MS } = makeWatchdog({ paneWorking: () => working, entries: MID_TURN });
    armTurnWatchdog(sess(), { kind: 'codex' }, 'MSG');
    // Well past the first deadline: the pane predicate keeps extending, so a
    // genuinely slow turn is never killed and no half-answer is pushed.
    const step = (upTo) => { while (Date.now() < upTo)
        t.mock.timers.tick(5_000); };
    step(WATCHDOG_GRACE_MS * 3);
    assert.deepStrictEqual(calls.pushed, []);
    assert.deepStrictEqual(calls.abandoned, []);
    void working;
});
test('watchdog un-wedges a turn whose answer never reads as final', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { calls, armTurnWatchdog, WATCHDOG_GRACE_MS } = makeWatchdog({ paneWorking: () => false, entries: MID_TURN });
    const s = sess();
    armTurnWatchdog(s, { kind: 'codex' }, 'MSG');
    const step = (upTo) => { while (Date.now() < upTo)
        t.mock.timers.tick(5_000); };
    step(WATCHDOG_GRACE_MS + 10_000);
    // Idle pane + no final marker = the pathological case. Abandoning tells the
    // user to go look, which beats the silent forever-wedge this replaces.
    assert.strictEqual(calls.abandoned.length, 1);
    assert.match(calls.abandoned[0], /hook/);
    assert.strictEqual(s.lastInjectedText, null);
});
test('watchdog warns about the silent hook once per session, not once per turn', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { calls, armTurnWatchdog } = makeWatchdog({ paneWorking: () => false, entries: FINISHED });
    const s = sess();
    armTurnWatchdog(s, { kind: 'codex' }, 'MSG');
    t.mock.timers.tick(5_000);
    s.lastInjectedText = 'MSG'; // next turn, same session
    s.orphanPollText = null;
    armTurnWatchdog(s, { kind: 'codex' }, 'MSG');
    t.mock.timers.tick(5_000);
    assert.strictEqual(calls.pushed.length, 2, 'both turns delivered');
    assert.strictEqual(calls.sentText.length, 1, 'but only one nag');
    assert.match(calls.sentText[0], /hook/);
    assert.ok(calls.warned.some((m) => /watchdog/.test(m)), 'and it is in the log every time');
});
test('watchdog does not arm for a turn that already resolved', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { calls, armTurnWatchdog } = makeWatchdog({ paneWorking: () => false, entries: FINISHED });
    const s = sess({ lastInjectedText: null });
    armTurnWatchdog(s, { kind: 'codex' }, 'MSG');
    t.mock.timers.tick(60_000);
    assert.deepStrictEqual(calls.pushed, []);
    assert.strictEqual(s.orphanPollText, null);
});
