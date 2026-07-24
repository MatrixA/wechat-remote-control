import { test } from 'node:test';
import assert from 'node:assert';
import { MAX_MSG_LEN, splitMessage, textFromContent, findResponseToInjected, findInterimTexts, findLastCompleteResponse, transcriptHasUserText, } from '../message.js';
// ── splitMessage ─────────────────────────────────────────────────────
test('splitMessage returns a single chunk when within limit', () => {
    assert.deepStrictEqual(splitMessage('hello'), ['hello']);
    const exact = 'x'.repeat(MAX_MSG_LEN);
    assert.deepStrictEqual(splitMessage(exact), [exact]);
});
test('splitMessage keeps every chunk within maxLen even for a long unbroken line', () => {
    const text = 'a'.repeat(5000); // no newlines → forces hard splits
    const chunks = splitMessage(text, 200);
    assert.ok(chunks.length > 1);
    for (const c of chunks)
        assert.ok(c.length <= 200, `chunk too long: ${c.length}`);
    // No content lost (no fences here, so chunks concatenate back to the original).
    assert.strictEqual(chunks.join(''), text);
});
test('splitMessage prefers newline boundaries', () => {
    const line = 'b'.repeat(120);
    const text = Array(10).fill(line).join('\n'); // 10 lines, ~1300 chars
    const chunks = splitMessage(text, 300);
    assert.ok(chunks.length > 1);
    // No chunk should start with a leading newline (they're trimmed).
    for (const c of chunks)
        assert.ok(!c.startsWith('\n'));
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
test('splitMessage chunks at a Telegram-sized 4096 limit, fences balanced', () => {
    const code = Array(400).fill('const x = 1;').join('\n'); // ~5200 chars
    const text = '```ts\n' + code + '\n```';
    const chunks = splitMessage(text, 4096);
    assert.ok(chunks.length > 1, 'expected multiple 4096-sized chunks');
    for (const c of chunks) {
        assert.ok(c.length <= 4096, `chunk too long: ${c.length}`);
        const fences = (c.match(/^```/gm) || []).length;
        assert.strictEqual(fences % 2, 0, 'unbalanced fences');
    }
});
// ── textFromContent ──────────────────────────────────────────────────
test('textFromContent handles string and block-array content', () => {
    assert.strictEqual(textFromContent('plain'), 'plain');
    assert.strictEqual(textFromContent([{ type: 'text', text: 'a' }, { type: 'tool_use' }, { type: 'text', text: 'b' }]), 'ab');
    assert.strictEqual(textFromContent({ weird: true }), null);
});
// ── findResponseToInjected ───────────────────────────────────────────
const entries = (...es) => es;
const user = (t) => ({ type: 'user', message: { content: t } });
const asst = (t, stop) => ({ type: 'assistant', message: { content: t, stop_reason: stop } });
test('findResponseToInjected returns the last end_turn response (complete)', () => {
    const t = entries(user('do X'), asst('working...', 'tool_use'), asst('done', 'end_turn'));
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
    const t = entries(user('ping'), asst('first answer', 'end_turn'), user('ping'), asst('second answer', 'end_turn'));
    assert.deepStrictEqual(findResponseToInjected(t, 'ping'), { text: 'second answer', complete: true });
});
// ── findInterimTexts ─────────────────────────────────────────────────
// Real transcripts carry ONE content block per JSONL line; every line of an API
// message replicates its message.id and stop_reason.
const line = (uuid, msgId, block, stop, extra = {}) => ({ type: 'assistant', uuid, message: { id: msgId, content: [block], stop_reason: stop }, ...extra });
const textLine = (uuid, msgId, text, stop = 'tool_use', extra = {}) => line(uuid, msgId, { type: 'text', text }, stop, extra);
const thinkLine = (uuid, msgId, stop = 'tool_use') => line(uuid, msgId, { type: 'thinking', thinking: 'hmm' }, stop);
const toolLine = (uuid, msgId, stop = 'tool_use') => line(uuid, msgId, { type: 'tool_use', name: 'Bash' }, stop);
const toolResult = () => ({ type: 'user', message: { content: [{ type: 'tool_result' }] } });
test('findInterimTexts returns [] without an anchor', () => {
    const t = entries(user('other'), textLine('u1', 'm1', 'x'.repeat(300)));
    assert.deepStrictEqual(findInterimTexts(t, 'do X'), []);
    assert.deepStrictEqual(findInterimTexts(t, null), []);
});
test('findInterimTexts extracts tool_use text and excludes the end_turn final', () => {
    const t = entries(user('do X'), thinkLine('u1', 'm1'), textLine('u2', 'm1', 'interim one'), toolLine('u3', 'm1'), toolResult(), textLine('u4', 'm2', 'final answer', 'end_turn'));
    assert.deepStrictEqual(findInterimTexts(t, 'do X'), [{ uuids: ['u2'], text: 'interim one' }]);
});
test('findInterimTexts refuses stop_reason null (still streaming) and sidechain lines', () => {
    const t = entries(user('do X'), textLine('u1', 'm1', 'not flushed yet', null), textLine('u2', 'm2', 'subagent text', 'tool_use', { isSidechain: true }), textLine('u3', 'm3', 'real interim'));
    assert.deepStrictEqual(findInterimTexts(t, 'do X'), [{ uuids: ['u3'], text: 'real interim' }]);
});
test('findInterimTexts merges adjacent text lines of the same message only', () => {
    const t = entries(user('do X'), textLine('u1', 'm1', 'part A '), textLine('u2', 'm1', 'part B'), toolLine('u3', 'm1'), toolResult(), thinkLine('u4', 'm2'), // same-message thinking must not glue m2 onto m1
    textLine('u5', 'm2', 'second block'), toolLine('u6', 'm2'));
    assert.deepStrictEqual(findInterimTexts(t, 'do X'), [
        { uuids: ['u1', 'u2'], text: 'part A part B' },
        { uuids: ['u5'], text: 'second block' },
    ]);
});
test('findInterimTexts stops at the next typed user message but scans past tool results', () => {
    const t = entries(user('do X'), textLine('u1', 'm1', 'first turn interim'), toolLine('u2', 'm1'), toolResult(), user('typed at terminal'), textLine('u3', 'm2', 'next turn interim'));
    assert.deepStrictEqual(findInterimTexts(t, 'do X'), [{ uuids: ['u1'], text: 'first turn interim' }]);
});
test('findInterimTexts anchors on the most recent occurrence of the injected text', () => {
    const t = entries(user('ping'), textLine('u1', 'm1', 'old interim'), textLine('u2', 'm2', 'old final', 'end_turn'), user('ping'), textLine('u3', 'm3', 'new interim'));
    assert.deepStrictEqual(findInterimTexts(t, 'ping'), [{ uuids: ['u3'], text: 'new interim' }]);
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
    assert.strictEqual(transcriptHasUserText(t, 'hello'), false); // not exact
    assert.strictEqual(transcriptHasUserText(t, 'hi'), false); // assistant text, not user
    assert.strictEqual(transcriptHasUserText(t, null), false);
});
