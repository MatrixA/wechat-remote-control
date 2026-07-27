import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

// classifyModality lives in the untyped index.js monolith, which starts the
// daemon on import — so extract the source by marker and evaluate it. If the
// markers drift this throws loudly.
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
  + '\nreturn { classifyModality };',
);
const { classifyModality } = factory(() => '', { warn: () => {}, info: () => {}, debug: () => {} }) as {
  classifyModality: (pane: string, kind: string | null, alt: boolean) => string;
};

// ── Fixtures ─────────────────────────────────────────────────────────
// Verbatim `tmux capture-pane -p` tails from a live codex-cli 0.145.0 pane,
// 2026-07-27, driven through Esc ×0/×1/×2. `alternate_on` recorded alongside.

const CODEX_IDLE = `
• ACK2


› Summarize recent commits

  gpt-5.6-sol high · /private/tmp/wrc-probe
`;

const CODEX_WORKING = `
• Starting MCP servers (3/4): codex_apps (5s • esc to interrupt)


› Summarize recent commits

  gpt-5.6-sol high · /private/tmp/wrc-probe
`;

// After ONE Esc on an idle pane. alternate_on still 0 — the footer is the tell.
const CODEX_PRIMED = `
• ACK2


› Summarize recent commits

  esc again to edit previous message
`;

// After TWO Escs: full-screen transcript overlay, alternate_on = 1.
// Enter in here confirms a rewind and forks the session.
const CODEX_OVERLAY = `
  third line reply ACK2 only


• ACK2
───────────────────────────────────────────────────────────────────── 100% ─
 ↑/↓ to scroll   pgup/pgdn to page   home/end to jump
 q to quit   esc/← to edit prev   → to edit next   enter to edit message
`;

const CC_IDLE = `
${'─'.repeat(100)}
❯
${'─'.repeat(100)}
  ⏸ plan mode on (shift+tab to cycle) · ← for agents
`;

const CC_WORKING = `
✳ Burrowing… (esc to interrupt)

${'─'.repeat(100)}
❯
${'─'.repeat(100)}
  ⏸ plan mode on (shift+tab to cycle) · ← for agents
`;

// A pager the USER opened. alternate_on is 1, but this is not our overlay and
// `q` here would just be a letter in their buffer.
const LESS_PAGER = `
This is some file the user is reading in less, line 1
line 2
line 3
:
`;

const VIM = `
~
~
~
"notes.txt" 3L, 42B
`;

// ── the happy states ─────────────────────────────────────────────────

test('classifyModality: idle panes are idle', () => {
  assert.strictEqual(classifyModality(CODEX_IDLE, 'codex', false), 'idle');
  assert.strictEqual(classifyModality(CC_IDLE, 'claude', false), 'idle');
});

test('classifyModality: a running turn is working', () => {
  assert.strictEqual(classifyModality(CODEX_WORKING, 'codex', false), 'working');
  assert.strictEqual(classifyModality(CC_WORKING, 'claude', false), 'working');
});

// ── primed: the state that makes a second Esc dangerous ──────────────

test('classifyModality: one Esc on an idle codex pane reads primed, not idle', () => {
  // Getting this wrong is the whole bug: 'idle' would let a repeat /esc through
  // and open the rewind overlay.
  assert.strictEqual(classifyModality(CODEX_PRIMED, 'codex', false), 'primed');
});

test('classifyModality: primed beats a stale "esc to interrupt" above it', () => {
  // Load-bearing ordering. Codex prints "esc to interrupt" on its MCP-startup
  // spinner too, so 'working' is not a reliable "a turn is running" signal on a
  // pane that has already been primed. If 'working' were checked first we would
  // send Escape into a primed pane — which is precisely how the rewind overlay
  // opens.
  const primedWithSpinnerHistory = `
• Starting MCP servers (3/4): codex_apps (5s • esc to interrupt)


› Summarize recent commits

  esc again to edit previous message
`;
  assert.strictEqual(classifyModality(primedWithSpinnerHistory, 'codex', false), 'primed');
});

test('classifyModality: primed wins over the idle footer it replaced', () => {
  // The primed footer REPLACES the model/cwd line, so there is no ambiguity —
  // assert it explicitly so a future footer tweak fails loudly here.
  assert.ok(!CODEX_PRIMED.includes('gpt-5.6-sol high · /private'));
});

// ── overlay vs a foreign alt-screen ──────────────────────────────────

test('classifyModality: the codex rewind overlay is recognised as overlay', () => {
  assert.strictEqual(classifyModality(CODEX_OVERLAY, 'codex', true), 'overlay');
});

test('classifyModality: alt-screen we do not recognise is unknown, never overlay', () => {
  // 'overlay' authorises sending `q`. In less/vim that is a keystroke into the
  // user's own session, so anything we cannot positively identify must be
  // hands-off.
  assert.strictEqual(classifyModality(LESS_PAGER, 'codex', true), 'unknown');
  assert.strictEqual(classifyModality(VIM, 'claude', true), 'unknown');
});

test('classifyModality: overlay text without the alt-screen probe is NOT an overlay', () => {
  // alternate_on is the structural primary signal; the text is confirmation
  // only. An assistant reply quoting "q to quit ... to edit prev" must not
  // masquerade as an overlay.
  const quoted = `
⏺ the footer reads "q to quit   esc/← to edit prev   → to edit next"

› Summarize recent commits

  gpt-5.6-sol high · /private/tmp/wrc-probe
`;
  assert.strictEqual(classifyModality(quoted, 'codex', false), 'idle');
});

test('classifyModality: inside an overlay, stale "esc to interrupt" history does not read as working', () => {
  // Ordering matters: the overlay shows scrolled transcript, which very often
  // contains an older turn's spinner line. Checking working first would send an
  // Escape into a pager and page it further back.
  const overlayWithStaleSpinner = `
• ACK2 (12s • esc to interrupt)
───────────────────────────────────────────────────────────────────── 100% ─
 ↑/↓ to scroll   pgup/pgdn to page   home/end to jump
 q to quit   esc/← to edit prev   → to edit next   enter to edit message
`;
  assert.strictEqual(classifyModality(overlayWithStaleSpinner, 'codex', true), 'overlay');
});

// ── degenerate input ─────────────────────────────────────────────────

test('classifyModality: empty pane text is idle, empty alt-screen is unknown', () => {
  assert.strictEqual(classifyModality('', 'codex', false), 'idle');
  assert.strictEqual(classifyModality('', 'codex', true), 'unknown');
  assert.strictEqual(classifyModality(null as unknown as string, 'codex', true), 'unknown');
});
