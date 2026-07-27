import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

// classifyComposer / composerRegion live in the untyped index.js monolith, which
// starts the daemon on import — so extract the source by marker and evaluate it.
// If the markers drift this throws loudly: update them together with the slice.
const src = readFileSync(new URL('../../src/index.js', import.meta.url), 'utf8');
const cut = (from: string, to: string) => {
  const a = src.indexOf(from), b = src.indexOf(to);
  assert.ok(a >= 0 && b > a, `extraction markers not found in src/index.js: ${from} .. ${to}`);
  return src.slice(a, b);
};

const factory = new Function(
  'execFileSync', 'logger',
  cut('function paneExists', '// ── Quiz (AskUserQuestion) helpers')
  + '\n' + cut('function quizNorm', '/**\n * Is `question` the quiz')
  + '\nreturn { classifyComposer, composerRegion };',
);
const { classifyComposer, composerRegion } = factory(() => '', { warn: () => {}, info: () => {}, debug: () => {} }) as {
  classifyComposer: (pane: string, injected: string, kind: string | null) => string;
  composerRegion: (pane: string, kind: string | null) => string | null;
};

// ── Fixtures ─────────────────────────────────────────────────────────
// Verbatim `tmux capture-pane -p` output, collected 2026-07-27 from
// codex-cli 0.145.0 and Claude Code v2.1.196 in a 100x30 pane.
//
// The one detail you cannot see by eye: an EMPTY Claude Code composer is
// `❯` + U+00A0 (no-break space), while its transcript echo of a submitted
// message uses a plain U+0020. Written as an explicit escape below so a
// well-meaning editor cannot normalise the bug back into existence.
const NBSP = ' ';
const RULE = '─'.repeat(100);

const CODEX_IDLE = `
› Summarize recent commits

  gpt-5.6-sol high · /private/tmp/wrc-probe


`;

// The D1 signature: our text still in the composer, plus the extra blank line
// that the swallowed Enter turned into a newline instead of a submit.
const STUCK_MSG = 'please summarize the last three commits';
const CODEX_STUCK = `
• pong


› ${STUCK_MSG}


  gpt-5.6-sol high · /private/tmp/wrc-probe
`;

// THE critical negative case. Codex echoes the submitted user message into the
// transcript with the SAME `› ` prefix as the composer, so anything that scans
// "the bottom N lines" for our text calls every successful send a failure.
const CODEX_SUBMITTED = `
› ${STUCK_MSG}

⚠ Skill descriptions were shortened to fit the 2% skills context budget.

• pong


› Summarize recent commits

  gpt-5.6-sol high · /private/tmp/wrc-probe
`;

const CODEX_MULTILINE_STUCK = `
• pong


› line one alpha
  line two beta
  line three gamma

  gpt-5.6-sol high · /private/tmp/wrc-probe
`;

const CC_IDLE = `
${RULE}
❯${NBSP}
${RULE}
  ⏸ plan mode on (shift+tab to cycle) · ← for agents


`;

const CC_STUCK = `
${RULE}
❯ diagnostic needle alpha bravo charlie
${RULE}
  ⏸ plan mode on (shift+tab to cycle) · ← for agents
`;

// Second critical negative case: echo above (plain space), real composer below
// (no-break space), turn already finished.
const CC_SUBMITTED = `
❯ say only the word YANKEE and nothing else

⏺ YANKEE

✻ Cooked for 6s

${RULE}
❯${NBSP}
${RULE}
  ⏸ plan mode on (shift+tab to cycle) · ← for agents

`;

// A >800-char paste collapses to a placeholder, so the needle can never match
// the text itself. Captured live.
const CC_PLACEHOLDER = `
${RULE}
❯ [Pasted text #1 +1 lines]
${RULE}
  ⏸ plan mode on (shift+tab to cycle)
`;

// Codex's equivalent, from chat_composer.rs:1808 (>1000 chars). Shape taken
// from source rather than a live capture.
const CODEX_PLACEHOLDER = `
› [Pasted Content 1234 chars]

  gpt-5.6-sol high · /private/tmp/wrc-probe
`;

const LONG = 'reply with exactly the word ACK and nothing else';

// ── composerRegion ───────────────────────────────────────────────────

test('composerRegion anchors on the LAST prompt line, not the transcript echo', () => {
  // Codex: the echo of the submitted message sits above; the composer below.
  const region = composerRegion(CODEX_SUBMITTED, 'codex');
  assert.ok(region, 'expected a composer region');
  assert.match(region!.split('\n')[0], /^› Summarize recent commits$/);
  assert.ok(!region!.includes('ping'), 'region must not reach back into the transcript');
});

test('composerRegion finds the no-break-space empty CC composer', () => {
  // The regression that made every CC send look stuck: `[ \t]` misses U+00A0,
  // so the scan fell through to the echo line.
  const region = composerRegion(CC_SUBMITTED, 'claude');
  assert.ok(region, 'expected a composer region');
  assert.strictEqual(region!.split('\n')[0], `❯${NBSP}`);
});

test('composerRegion excludes the TUI footer', () => {
  // The footer carries the model name, the cwd and the mode hints. Including it
  // meant a message that merely MENTIONED its own working directory matched an
  // EMPTY composer, was declared stuck, and got re-sent 2-4 times.
  const region = composerRegion(CODEX_IDLE, 'codex');
  assert.ok(region);
  assert.ok(!region!.includes('/private/tmp/wrc-probe'), 'cwd footer must not be in the region');
  assert.ok(!region!.includes('gpt-5.6-sol'), 'model footer must not be in the region');

  const ccRegion = composerRegion(CC_IDLE, 'claude');
  assert.ok(ccRegion);
  assert.ok(!ccRegion!.includes('plan mode'), 'CC mode hint must not be in the region');
  assert.ok(!ccRegion!.includes('─'), 'CC rule must not be in the region');
});

test('classifyComposer: a message quoting the cwd is not "stuck" on an empty composer', () => {
  // Regression for the footer leak above, from both directions.
  const mentionsCwd = 'have a look at /private/tmp/wrc-probe and tell me what is in there';
  assert.strictEqual(classifyComposer(CODEX_IDLE, mentionsCwd, 'codex'), 'submitted');
  const mentionsMode = 'why is plan mode on (shift+tab to cycle) showing up in the footer';
  assert.strictEqual(classifyComposer(CC_IDLE, mentionsMode, 'claude'), 'submitted');
  // ...and it must still be detected when it really IS in the composer.
  const parked = `
${RULE}
❯ ${mentionsCwd}
${RULE}
  ⏸ plan mode on (shift+tab to cycle)
`;
  assert.strictEqual(classifyComposer(parked, mentionsCwd, 'claude'), 'stuck');
});

test('composerRegion keeps every line of a multi-line composer', () => {
  const region = composerRegion(CODEX_MULTILINE_STUCK, 'codex');
  assert.ok(region);
  assert.match(region!, /line one alpha/);
  assert.match(region!, /line two beta/);
  assert.match(region!, /line three gamma/);
  assert.ok(!region!.includes('gpt-5.6-sol'));
});

test('composerRegion returns null when no input box is on screen', () => {
  assert.strictEqual(composerRegion('just some scrollback\nand more\n', 'codex'), null);
  assert.strictEqual(composerRegion('', 'claude'), null);
});

test('composerRegion with an unknown kind tries both prompt glyphs', () => {
  assert.ok(composerRegion(CODEX_IDLE, null));
  assert.ok(composerRegion(CC_IDLE, null));
});

// ── classifyComposer: the stuck verdicts ─────────────────────────────

test('classifyComposer: codex text left in the composer reads stuck', () => {
  assert.strictEqual(classifyComposer(CODEX_STUCK, STUCK_MSG, 'codex'), 'stuck');
});

test('classifyComposer: multi-line text left in the composer reads stuck', () => {
  assert.strictEqual(
    classifyComposer(CODEX_MULTILINE_STUCK, 'line one alpha\nline two beta\nline three gamma', 'codex'),
    'stuck',
  );
});

test('classifyComposer: CC text left in the composer reads stuck', () => {
  assert.strictEqual(classifyComposer(CC_STUCK, 'diagnostic needle alpha bravo charlie', 'claude'), 'stuck');
});

test('classifyComposer: both large-paste placeholders read stuck', () => {
  // The needle cannot match a collapsed placeholder, so the placeholder itself
  // has to be the signal — otherwise every long message reports as submitted.
  const long = 'x'.repeat(1500);
  assert.strictEqual(classifyComposer(CC_PLACEHOLDER, long, 'claude'), 'stuck');
  assert.strictEqual(classifyComposer(CODEX_PLACEHOLDER, long, 'codex'), 'stuck');
});

// ── classifyComposer: the submitted verdicts (false positives are the danger) ──

test('classifyComposer: a submitted codex message is NOT reported stuck', () => {
  // Regressing this re-sends every message the agent already answered.
  assert.strictEqual(classifyComposer(CODEX_SUBMITTED, STUCK_MSG, 'codex'), 'submitted');
});

test('classifyComposer: a submitted CC message is NOT reported stuck', () => {
  assert.strictEqual(classifyComposer(CC_SUBMITTED, LONG, 'claude'), 'submitted');
});

test('classifyComposer: an idle composer reads submitted', () => {
  assert.strictEqual(classifyComposer(CODEX_IDLE, LONG, 'codex'), 'submitted');
  assert.strictEqual(classifyComposer(CC_IDLE, LONG, 'claude'), 'submitted');
});

test('classifyComposer: someone else\'s text in the composer is not ours', () => {
  const other = `
${RULE}
❯ the user was typing their own thing
${RULE}
  ⏸ plan mode on (shift+tab to cycle)
`;
  assert.strictEqual(classifyComposer(other, LONG, 'claude'), 'submitted');
});

test('classifyComposer: CC queued-message chrome degrades to submitted, not stuck', () => {
  // Observed live: with a turn running and messages queued behind it, CC hides
  // the composer body behind this hint. We cannot see our text, so we must NOT
  // guess "stuck" — CC has accepted it into the queue.
  const queued = `
✳ Burrowing… (esc to interrupt)

${RULE}
❯ Press up to edit queued messages
${RULE}
  ⏸ plan mode on (shift+tab to cycle)
`;
  assert.strictEqual(classifyComposer(queued, LONG, 'claude'), 'submitted');
});

// ── classifyComposer: the conservative 'unknown' branches ────────────

test('classifyComposer: no composer on screen yields unknown, never a re-key', () => {
  assert.strictEqual(classifyComposer('scrollback only, no prompt line', LONG, 'codex'), 'unknown');
  assert.strictEqual(classifyComposer('', LONG, 'claude'), 'unknown');
});

test('classifyComposer: short messages are too weak an anchor → unknown', () => {
  // "y" / "好" would match some incidental glyph in a status row, and the cost
  // of a false stuck (a stray Enter into an unknown modality) outweighs the
  // cost of skipping verification — bracketed paste already covers these.
  for (const short of ['y', 'ok', '好', '继续', '1']) {
    assert.strictEqual(classifyComposer(CODEX_IDLE, short, 'codex'), 'unknown', `short: ${short}`);
    assert.strictEqual(classifyComposer(CODEX_STUCK, short, 'codex'), 'unknown', `short: ${short}`);
  }
});

test('classifyComposer: empty injected text yields unknown', () => {
  assert.strictEqual(classifyComposer(CODEX_IDLE, '', 'codex'), 'unknown');
});

// ── normalization ────────────────────────────────────────────────────

test('classifyComposer: CJK survives quizNorm matching', () => {
  const msg = '帮我看一下这个报错是怎么回事';
  const stuck = `
› ${msg}

  gpt-5.6-sol high · /private/tmp/wrc-probe
`;
  assert.strictEqual(classifyComposer(stuck, msg, 'codex'), 'stuck');
  assert.strictEqual(classifyComposer(CODEX_IDLE, msg, 'codex'), 'submitted');
});

test('classifyComposer: TUI hard-wrapping and indent do not break the match', () => {
  // The composer wraps long text across lines with a 2-space indent; quizNorm
  // drops the wrap, the indent and the punctuation so the needle still lands.
  const msg = 'please investigate the failing integration test in the payments module';
  const wrapped = `
› please investigate the failing integration
  test in the payments module

  gpt-5.6-sol high · /private/tmp/wrc-probe
`;
  assert.strictEqual(classifyComposer(wrapped, msg, 'codex'), 'stuck');
});
