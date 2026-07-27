import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
// The interrupt-recovery pieces live in the untyped index.js monolith, which
// starts the daemon on import — so extract each function's source by marker and
// evaluate it with stubbed collaborators (same pattern as quiz-screen.test.ts).
// If the markers drift, this throws loudly: update them with the extraction.
const src = readFileSync(new URL('../../src/index.js', import.meta.url), 'utf8');
function extract(startMarker, endMarker) {
    const start = src.indexOf(startMarker);
    const end = src.indexOf(endMarker, start);
    assert.ok(start >= 0 && end > start, `extraction markers not found: ${startMarker} … ${endMarker}`);
    return src.slice(start, end);
}
// ── paneShowsWorking ─────────────────────────────────────────────────
let paneText = '';
let paneAlive = true;
const paneFactory = new Function('paneExists', 'stripAnsi', 'capturePaneContent', extract('function paneShowsWorking', 'function tryAutoConfirmCompaction')
    .replace(/\/\*\*[\s\S]*$/, '') + '\nreturn { paneShowsWorking };');
const { paneShowsWorking } = paneFactory(() => paneAlive, (s) => s, () => paneText);
const onPane = (screen, alive = true) => {
    paneText = screen;
    paneAlive = alive;
    return paneShowsWorking('stub');
};
// Verbatim shapes of the working status rows (2026-07 CC / Codex builds).
const CC_WORKING = `
⏺ Bash(npm test)
  ⎿  Running…

✻ Cerebrating… (esc to interrupt · 32s · ⚒ 214 tokens)
`;
const CODEX_WORKING = `
• Working (2m 03s • Esc to interrupt)
`;
const CC_IDLE = `
⏺ 已完成，共修改 3 个文件。

──────────────────────────────────────────────────────────────────
❯
──────────────────────────────────────────────────────────────────
  ← for agents                                        ● high · /effort
`;
test('paneShowsWorking detects the Claude working status row', () => {
    assert.strictEqual(onPane(CC_WORKING), true);
});
test('paneShowsWorking detects the Codex working indicator (case-insensitive)', () => {
    assert.strictEqual(onPane(CODEX_WORKING), true);
});
test('paneShowsWorking is false on an idle prompt', () => {
    assert.strictEqual(onPane(CC_IDLE), false);
});
test('paneShowsWorking is false on a dead pane even with working text', () => {
    assert.strictEqual(onPane(CC_WORKING, false), false);
});
test('paneShowsWorking is false for a missing target', () => {
    assert.strictEqual(paneShowsWorking(''), false);
});
// ── statusBody: interrupt-requested variant ──────────────────────────
const bodyFactory = new Function(extract('function fmtDur', 'function statusButtons') + '\nreturn { statusBody };');
const { statusBody } = bodyFactory();
test('statusBody switches to the interrupt-requested form and back', () => {
    const sess = { turnStartedAt: Date.now() - 5000, turnToolCount: 3, turnLastTool: 'Bash', interruptRequestedAt: 0 };
    assert.match(statusBody(sess), /已调用 3 个工具/);
    sess.interruptRequestedAt = Date.now() - 2000;
    const body = statusBody(sess);
    assert.match(body, /已请求中断/);
    assert.match(body, /\/esc/); // tells the user how to re-interrupt
    assert.doesNotMatch(body, /已调用/);
});
function makePoll() {
    const calls = { pushed: [], abandoned: [], scheduled: 0 };
    const sess = { name: 't', lastInjectedText: 'MSG', orphanPollText: null };
    const factory = new Function('pushResponse', 'scheduleInject', 'abandonTurn', 'logger', extract('const ORPHAN_MAX_EXTENSIONS', '/** Standard Claude transcript probe')
        + '\nreturn { armOrphanPoll, ORPHAN_MAX_EXTENSIONS };');
    const api = factory((s, text, opts) => { calls.pushed.push({ text, opts }); s.lastInjectedText = null; }, () => { calls.scheduled++; }, (s, reason) => { calls.abandoned.push(reason); s.lastInjectedText = null; }, { info: () => { }, warn: () => { } });
    return { calls, sess, ...api };
}
test('armOrphanPoll forwards a string probe hit as-is', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { calls, sess, armOrphanPoll } = makePoll();
    armOrphanPoll(sess, 'MSG', () => 'final text', 20_000, 5_000);
    t.mock.timers.tick(5_000);
    assert.deepStrictEqual(calls.pushed, [{ text: 'final text', opts: undefined }]);
    assert.strictEqual(calls.scheduled, 1);
    assert.strictEqual(sess.orphanPollText, null);
});
test('armOrphanPoll forwards an object probe hit with its pushResponse opts', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { calls, sess, armOrphanPoll } = makePoll();
    armOrphanPoll(sess, 'MSG', () => ({ text: 'partial', opts: { dedupeInterim: true } }), 20_000, 5_000);
    t.mock.timers.tick(5_000);
    assert.deepStrictEqual(calls.pushed, [{ text: 'partial', opts: { dedupeInterim: true } }]);
});
test('armOrphanPoll abandons with the custom reason at the deadline', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { calls, sess, armOrphanPoll } = makePoll();
    armOrphanPoll(sess, 'MSG', () => null, 20_000, 5_000, null, '已中断，未捕获到最终回复');
    t.mock.timers.tick(20_000);
    assert.deepStrictEqual(calls.abandoned, ['已中断，未捕获到最终回复']);
    assert.deepStrictEqual(calls.pushed, []);
});
test('armOrphanPoll keeps the default abandon reason when none is given', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { calls, sess, armOrphanPoll } = makePoll();
    armOrphanPoll(sess, 'MSG', () => null, 20_000, 5_000);
    t.mock.timers.tick(20_000);
    assert.deepStrictEqual(calls.abandoned, ['未在时限内捕获到回复，请回终端查看']);
});
test('armOrphanPoll dies silently when the turn resolved elsewhere', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { calls, sess, armOrphanPoll } = makePoll();
    armOrphanPoll(sess, 'MSG', () => 'late text', 20_000, 5_000);
    sess.lastInjectedText = 'NEWER MSG'; // Stop handler won the race
    t.mock.timers.tick(60_000);
    assert.deepStrictEqual(calls.pushed, []);
    assert.deepStrictEqual(calls.abandoned, []);
    assert.strictEqual(sess.orphanPollText, null);
});
test('armOrphanPoll extends while stillInFlight, then caps and abandons', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { calls, sess, armOrphanPoll, ORPHAN_MAX_EXTENSIONS } = makePoll();
    let inFlight = true;
    armOrphanPoll(sess, 'MSG', () => null, 10_000, 5_000, () => inFlight, '已中断，未捕获到最终回复');
    // Chained setTimeouts only cascade at their own scheduled times when the
    // clock advances in poll-sized steps (a single big tick jumps Date past
    // every intermediate deadline). Extensions land at t = 10s,20s,…,100s; the
    // capped chain abandons at t = 110s.
    const step = (upToMs) => {
        while (Date.now() < upToMs)
            t.mock.timers.tick(5_000);
    };
    step(10_000 * (1 + ORPHAN_MAX_EXTENSIONS) - 5_000); // t=105s: cap reached, not yet expired
    assert.deepStrictEqual(calls.abandoned, []);
    step(10_000 * (1 + ORPHAN_MAX_EXTENSIONS) + 10_000); // t=120s: past the final deadline
    assert.deepStrictEqual(calls.abandoned, ['已中断，未捕获到最终回复']);
});
test('armOrphanPoll stops extending as soon as stillInFlight turns false', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { calls, sess, armOrphanPoll } = makePoll();
    let inFlight = true;
    armOrphanPoll(sess, 'MSG', () => null, 10_000, 5_000, () => inFlight);
    t.mock.timers.tick(10_000); // first deadline: extended
    assert.deepStrictEqual(calls.abandoned, []);
    inFlight = false; // pane went idle (Esc took effect)
    t.mock.timers.tick(10_000); // next deadline: abandon
    assert.strictEqual(calls.abandoned.length, 1);
});
