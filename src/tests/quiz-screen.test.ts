import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

// quizOnScreen lives in the untyped index.js monolith, which starts the daemon
// on import — so extract the function source by marker and evaluate it with
// stubbed pane capture. If the markers drift, this throws loudly: update them
// together with the extraction below.
const src = readFileSync(new URL('../../src/index.js', import.meta.url), 'utf8');
const start = src.indexOf('function quizNorm');
const end = src.indexOf('/** Strip the inline keyboard');
assert.ok(start >= 0 && end > start, 'quizNorm/quizOnScreen extraction markers not found in src/index.js');

let paneText = '';
const factory = new Function(
  'capturePaneContent', 'stripAnsi', 'logger',
  src.slice(start, end) + '\nreturn { quizOnScreen };'
);
const { quizOnScreen } = factory(() => paneText, (s: string) => s, { debug: () => {} }) as {
  quizOnScreen: (target: string, question: unknown, attempt?: number) => boolean;
};

// attempt=1 skips the 500ms blocking redraw-retry — these are static fixtures.
const onScreen = (screen: string, question: unknown) => {
  paneText = screen;
  return quizOnScreen('stub', question, 1);
};

const fruit = {
  question: '我们选哪个水果来做端到端测试这是一个偏长的中文问题',
  options: [{ label: 'Apple' }, { label: 'Banana' }, { label: 'Cherry' }],
};
const colors = {
  question: '多选测试你平时喜欢哪些颜色呢',
  options: [{ label: 'Red' }, { label: 'Green' }, { label: 'Blue' }],
  multiSelect: true,
};

// Fixtures are verbatim tmux captures of a real Claude Code session (2026-07).
// Current CC quiz chrome: numbered options, a "Type something." free-text row,
// a "Chat about this" row, and an Enter/Esc hint line — no "Other" row.

const LIVE_SINGLE = `
 ☐ 水果选择

我们选哪个水果来做端到端测试这是一个偏长的中文问题

❯ 1. Apple
     选择苹果作为端到端测试的水果
  2. Banana
     选择香蕉作为端到端测试的水果
  3. Cherry
     选择樱桃作为端到端测试的水果
  4. Type something.
──────────────────────────────────────────────────────────────────
  5. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`;

const LIVE_MULTI = `
←  ☐ 颜色多选  ✔ Submit  →

多选测试你平时喜欢哪些颜色呢

❯ 1. [ ] Red
  红色
  2. [ ] Green
  绿色
  3. [ ] Blue
  蓝色
  4. [ ] Type something
     Submit
──────────────────────────────────────────────────────────────────
  5. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`;

// After answering in the terminal: the echo shows question → chosen label,
// and the original prompt (still on screen) lists all labels IN ORDER — the
// live-chrome anchor is what must reject this, not the label needles.
const AFTER_ANSWER = `
❯ Call the AskUserQuestion tool right now with exactly one single-select question:
  question="我们选哪个水果来做端到端测试这是一个偏长的中文问题", options with labels Apple, Banana, Cherry.
  Do nothing else.

⏺ User answered Claude's questions:
  ⎿  · 我们选哪个水果来做端到端测试这是一个偏长的中文问题 → Apple

⏺ 你选择了 Apple（苹果）作为端到端测试的水果。

──────────────────────────────────────────────────────────────────
❯
──────────────────────────────────────────────────────────────────
  ← for agents                                        ● high · /effort
`;

// After Esc: the decline echo lists ALL labels in order "(Red / Green / Blue)"
// — the ordered-list needle alone would false-positive here.
const AFTER_ESC = `
⏺ User declined to answer questions
  ⎿  · 多选测试你平时喜欢哪些颜色呢 (Red / Green / Blue)

──────────────────────────────────────────────────────────────────
❯
──────────────────────────────────────────────────────────────────
  ← for agents                                        ● high · /effort
`;

test('quizOnScreen accepts a live single-select quiz TUI', () => {
  assert.strictEqual(onScreen(LIVE_SINGLE, fruit), true);
});

test('quizOnScreen accepts a live multiSelect quiz TUI', () => {
  assert.strictEqual(onScreen(LIVE_MULTI, colors), true);
});

test('quizOnScreen rejects the answered-in-terminal echo (ordered labels present via prompt echo)', () => {
  assert.strictEqual(onScreen(AFTER_ANSWER, fruit), false);
});

test('quizOnScreen rejects the Esc-declined echo (lists ALL labels in order)', () => {
  assert.strictEqual(onScreen(AFTER_ESC, colors), false);
});

test('quizOnScreen accepts a short pane where the question is clipped above the options', () => {
  const clipped = LIVE_SINGLE.split('\n').slice(5).join('\n'); // header + question scrolled off, list starts at "❯ 1. Apple"
  assert.strictEqual(onScreen(clipped, fruit), true);
});

test('quizOnScreen accepts the legacy "Other" row rendering', () => {
  const legacy = `
问题文本在这里我们选哪个水果来做端到端测试这是一个偏长的中文问题

❯ Apple
  Banana
  Cherry
  Other
`;
  assert.strictEqual(onScreen(legacy, fruit), true);
});

test('quizOnScreen does not treat prose "otherwise" as live chrome', () => {
  const prose = `
⏺ 关于 Apple、Banana、Cherry 的讨论：otherwise we would pick Apple.
  我们选哪个水果来做端到端测试这是一个偏长的中文问题
`;
  assert.strictEqual(onScreen(prose, fruit), false);
});
