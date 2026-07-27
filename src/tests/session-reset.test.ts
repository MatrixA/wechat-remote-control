import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { newSessionState, persistableState } from '../sessions.js';

// These live in the untyped index.js monolith, which starts the daemon on
// import — so extract each by marker and evaluate with stubbed collaborators.
// If the markers drift this throws loudly.
const src = readFileSync(new URL('../../src/index.js', import.meta.url), 'utf8');
const cut = (from: string, to: string) => {
  const a = src.indexOf(from), b = src.indexOf(to);
  assert.ok(a >= 0 && b > a, `extraction markers not found in src/index.js: ${from} .. ${to}`);
  return src.slice(a, b);
};

const fmtDurSrc = cut('function fmtDur', 'function statusBody');
const { fmtDur } = new Function(fmtDurSrc + '\nreturn { fmtDur };')() as {
  fmtDur: (ms: number) => string;
};

const { stuckSuffix } = new Function('fmtDur',
  cut('// A turn that has been in flight this long', 'function formatTmuxList')
  + '\nreturn { stuckSuffix };')(fmtDur) as {
  stuckSuffix: (states: unknown[], now?: number) => string;
};

// ── fmtDur ───────────────────────────────────────────────────────────

test('fmtDur renders hours once a wedge outlives an hour', () => {
  assert.strictEqual(fmtDur(5_000), '5s');
  assert.strictEqual(fmtDur(90_000), '1m30s');
  assert.strictEqual(fmtDur(600_000), '10m');
  // The case that motivated hours: 2h13m used to print as "133m13s".
  assert.strictEqual(fmtDur(8_000_000), '2h13m');
  assert.strictEqual(fmtDur(7_200_000), '2h');
});

// ── stuckSuffix ──────────────────────────────────────────────────────

const NOW = 1_800_000_000_000;
const waiting = (ageMs: number | null) => ({
  lastInjectedText: 'do the thing',
  injectedAt: ageMs === null ? 0 : NOW - ageMs,
});

test('stuckSuffix stays quiet while a turn is merely slow', () => {
  assert.strictEqual(stuckSuffix([waiting(1_000)], NOW), '');
  // 9m59s — just under the 10-minute threshold (2× the orphan-poll grace).
  assert.strictEqual(stuckSuffix([waiting(9 * 60_000 + 59_000)], NOW), '');
});

test('stuckSuffix warns past 10 minutes and escalates past 30', () => {
  const warn = stuckSuffix([waiting(11 * 60_000)], NOW);
  assert.match(warn, /⚠️/);
  assert.match(warn, /已等 11m 无回应/);
  assert.match(warn, /\/reset/);

  const alarm = stuckSuffix([waiting(8_000_000)], NOW);   // 2h13m
  assert.match(alarm, /🔴/);
  assert.match(alarm, /2h13m/);
});

test('stuckSuffix reports unknown age for turns restored from a pre-injectedAt state file', () => {
  // Back-compat: the field did not exist, but this is exactly the classic wedge
  // shape — surfacing it beats rendering it as a healthy busy session.
  const s = stuckSuffix([waiting(null)], NOW);
  assert.match(s, /时长未知/);
  assert.match(s, /\/reset/);
  assert.doesNotMatch(s, /1970|NaN/);
});

test('stuckSuffix ignores busy sessions with no in-flight injected turn', () => {
  // busy set by a terminal-initiated turn: not ours, so not ours to age.
  assert.strictEqual(stuckSuffix([{ busy: true, lastInjectedText: null, injectedAt: 0 }], NOW), '');
  assert.strictEqual(stuckSuffix([], NOW), '');
});

test('stuckSuffix reports the OLDEST waiting turn in a group', () => {
  const s = stuckSuffix([waiting(60_000), waiting(40 * 60_000), waiting(120_000)], NOW);
  assert.match(s, /🔴/);
  assert.match(s, /40m/);
});

// ── resetSessionState ────────────────────────────────────────────────

function makeReset() {
  const calls: string[] = [];
  const factory = new Function(
    'cancelQuiz', 'cancelPending', 'stopTurnStatus', 'persistStates', 'scheduleInject', 'logger',
    cut('function resetSessionState', '// ── Send with retry')
    + '\nreturn { resetSessionState };',
  );
  const { resetSessionState } = factory(
    () => calls.push('cancelQuiz'),
    () => calls.push('cancelPending'),
    () => calls.push('stopTurnStatus'),
    () => calls.push('persistStates'),
    () => calls.push('scheduleInject'),
    { warn: () => {}, info: () => {}, debug: () => {} },
  ) as { resetSessionState: (s: ReturnType<typeof newSessionState>, reason?: string) => Record<string, unknown> };
  return { resetSessionState, calls };
}

function wedged() {
  const s = newSessionState('%9', 'bbdebate');
  s.lastInjectedText = 'have a look at this bug';
  s.lastInjectedTranscript = '/t/p/a.jsonl';
  s.injectedTarget = '-100:7';
  s.injectedMessageId = '42';
  s.injectedAt = NOW - 8_000_000;
  s.busy = true;
  s.orphanPollText = 'have a look at this bug';
  s.interruptRequestedAt = NOW - 1000;
  s.injectFailCount = 2;
  s.pendingQueue = [
    { text: 'first queued', target: '-100:7', messageId: '43' },
    { text: 'second queued', target: '-100:7', messageId: '44' },
  ] as never;
  return s;
}

test('resetSessionState clears every field that can wedge a session', () => {
  const { resetSessionState } = makeReset();
  const s = wedged();
  resetSessionState(s, 'test');
  assert.strictEqual(s.lastInjectedText, null);
  assert.strictEqual(s.lastInjectedTranscript, null);
  assert.strictEqual(s.injectedTarget, '');
  assert.strictEqual(s.injectedMessageId, '');
  assert.strictEqual(s.injectedAt, 0);
  assert.strictEqual(s.busy, false);
  assert.strictEqual(s.orphanPollText, null);
  assert.strictEqual(s.interruptRequestedAt, 0);
  assert.strictEqual(s.injectFailCount, 0);
});

test('resetSessionState KEEPS the pending queue and re-drains it', () => {
  // The point of a reset is to get stuck messages moving, not to drop them.
  const { resetSessionState, calls } = makeReset();
  const s = wedged();
  resetSessionState(s, 'test');
  assert.strictEqual(s.pendingQueue.length, 2);
  assert.strictEqual(s.pendingQueue[0].text, 'first queued');
  assert.ok(calls.includes('scheduleInject'), 'must re-drain the queue');
  assert.ok(calls.includes('persistStates'), 'must wipe the on-disk ghost too');
});

test('resetSessionState reports what it cleared', () => {
  const { resetSessionState } = makeReset();
  const had = resetSessionState(wedged(), 'test');
  assert.strictEqual(had.injected, 'have a look at this bug');
  assert.strictEqual(had.busy, true);
  assert.strictEqual(had.queued, 2);
  assert.strictEqual(had.injectedAt, NOW - 8_000_000);
});

test('resetSessionState is idempotent on a healthy session', () => {
  const { resetSessionState } = makeReset();
  const s = newSessionState('%1', 'healthy');
  const had = resetSessionState(s, 'test');
  assert.strictEqual(had.injected, null);
  assert.strictEqual(had.busy, false);
  assert.strictEqual(had.queued, 0);
  assert.strictEqual(s.busy, false);
});

test('a reset session no longer persists a ghost turn', () => {
  // lastInjectedText is the persisted field, which is why a wedge used to
  // survive `wrc restart` with no way to clear it from the IM side.
  const { resetSessionState } = makeReset();
  const s = wedged();
  assert.strictEqual(persistableState(s).lastInjectedText, 'have a look at this bug');
  resetSessionState(s, 'test');
  assert.strictEqual(persistableState(s).lastInjectedText, null);
  assert.strictEqual(persistableState(s).injectedAt, 0);
});
