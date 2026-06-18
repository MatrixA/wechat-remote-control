import { test } from 'node:test';
import assert from 'node:assert';

import {
  MAX_MSG_LEN,
  splitMessage,
  textFromContent,
  findResponseToInjected,
  findLastCompleteResponse,
  transcriptHasUserText,
} from '../message.js';

// ── splitMessage ─────────────────────────────────────────────────────
test('splitMessage returns a single chunk when within limit', () => {
  assert.deepStrictEqual(splitMessage('hello'), ['hello']);
  const exact = 'x'.repeat(MAX_MSG_LEN);
  assert.deepStrictEqual(splitMessage(exact), [exact]);
});

test('splitMessage keeps every chunk within maxLen even for a long unbroken line', () => {
  const text = 'a'.repeat(5000);            // no newlines → forces hard splits
  const chunks = splitMessage(text, 200);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 200, `chunk too long: ${c.length}`);
  // No content lost (no fences here, so chunks concatenate back to the original).
  assert.strictEqual(chunks.join(''), text);
});

test('splitMessage prefers newline boundaries', () => {
  const line = 'b'.repeat(120);
  const text = Array(10).fill(line).join('\n'); // 10 lines, ~1300 chars
  const chunks = splitMessage(text, 300);
  assert.ok(chunks.length > 1);
  // No chunk should start with a leading newline (they're trimmed).
  for (const c of chunks) assert.ok(!c.startsWith('\n'));
});

test('splitMessage balances code fences across chunk boundaries', () => {
  const code = Array(40).fill('console.log("line");').join('\n'); // long body
  const text = '```js\n' + code + '\n```';
  const chunks = splitMessage(text, 200);
  assert.ok(chunks.length > 1, 'expected the code block to span multiple chunks');
  // Every chunk must contain an even number of fence markers (balanced).
  for (const c of chunks) {
    const fences = (c.match(/^```/gm) || []).length;
    assert.strictEqual(fences % 2, 0, `unbalanced fences in chunk:\n${c}`);
  }
  // First chunk opens a fence, last chunk closes one.
  assert.ok(chunks[0].startsWith('```'));
  assert.ok(chunks[chunks.length - 1].trimEnd().endsWith('```'));
});

// ── textFromContent ──────────────────────────────────────────────────
test('textFromContent handles string and block-array content', () => {
  assert.strictEqual(textFromContent('plain'), 'plain');
  assert.strictEqual(
    textFromContent([{ type: 'text', text: 'a' }, { type: 'tool_use' }, { type: 'text', text: 'b' }]),
    'ab',
  );
  assert.strictEqual(textFromContent({ weird: true }), null);
});

// ── findResponseToInjected ───────────────────────────────────────────
const entries = (...es: any[]) => es;
const user = (t: string) => ({ type: 'user', message: { content: t } });
const asst = (t: string, stop?: string) => ({ type: 'assistant', message: { content: t, stop_reason: stop } });

test('findResponseToInjected returns the last end_turn response (complete)', () => {
  const t = entries(
    user('do X'),
    asst('working...', 'tool_use'),
    asst('done', 'end_turn'),
  );
  assert.deepStrictEqual(findResponseToInjected(t, 'do X'), { text: 'done', complete: true });
});

test('findResponseToInjected returns partial text when no end_turn yet (incomplete)', () => {
  const t = entries(user('do X'), asst('still going', 'tool_use'));
  assert.deepStrictEqual(findResponseToInjected(t, 'do X'), { text: 'still going', complete: false });
});

test('findResponseToInjected returns null when the injected message is absent', () => {
  const t = entries(user('something else'), asst('done', 'end_turn'));
  assert.strictEqual(findResponseToInjected(t, 'do X'), null);
  assert.strictEqual(findResponseToInjected(t, null), null);
});

test('findResponseToInjected matches the most recent occurrence of the injected text', () => {
  const t = entries(
    user('ping'), asst('first answer', 'end_turn'),
    user('ping'), asst('second answer', 'end_turn'),
  );
  assert.deepStrictEqual(findResponseToInjected(t, 'ping'), { text: 'second answer', complete: true });
});

// ── findLastCompleteResponse ─────────────────────────────────────────
test('findLastCompleteResponse finds the last end_turn assistant text', () => {
  const t = entries(asst('a', 'end_turn'), asst('b', 'tool_use'), asst('c', 'end_turn'));
  assert.deepStrictEqual(findLastCompleteResponse(t), { text: 'c', complete: true });
  assert.strictEqual(findLastCompleteResponse(entries(asst('x', 'tool_use'))), null);
});

// ── transcriptHasUserText ────────────────────────────────────────────
test('transcriptHasUserText detects (only) an exact user-message match', () => {
  const t = entries(user('hello world'), asst('hi', 'end_turn'));
  assert.strictEqual(transcriptHasUserText(t, 'hello world'), true);
  assert.strictEqual(transcriptHasUserText(t, 'hello'), false);   // not exact
  assert.strictEqual(transcriptHasUserText(t, 'hi'), false);      // assistant text, not user
  assert.strictEqual(transcriptHasUserText(t, null), false);
});
