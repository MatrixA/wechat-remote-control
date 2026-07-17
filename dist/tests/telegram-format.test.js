import { test } from 'node:test';
import assert from 'node:assert';
import { escapeHtml, toTelegramHtml, toExpandableHtml, findExpandableSplit, buildInlineKeyboard } from '../telegram/format.js';
// ── escapeHtml ───────────────────────────────────────────────────────
test('escapeHtml escapes only & < >', () => {
    assert.strictEqual(escapeHtml('a & b < c > d'), 'a &amp; b &lt; c &gt; d');
    assert.strictEqual(escapeHtml('"quotes" stay'), '"quotes" stay'); // no positional escaping needed
});
// ── toTelegramHtml ───────────────────────────────────────────────────
test('toTelegramHtml escapes prose and wraps fenced code in <pre><code>', () => {
    const out = toTelegramHtml('hi <there>\n```js\nif (a < b) {}\n```\nbye & done');
    assert.ok(out.includes('hi &lt;there&gt;'));
    assert.ok(out.includes('<pre><code>if (a &lt; b) {}</code></pre>'));
    assert.ok(out.includes('bye &amp; done'));
});
test('toTelegramHtml drops the language tag and handles plain text', () => {
    assert.strictEqual(toTelegramHtml('just text'), 'just text');
    assert.strictEqual(toTelegramHtml('```\nraw\n```'), '<pre><code>raw</code></pre>');
});
// ── buildInlineKeyboard ──────────────────────────────────────────────
test('buildInlineKeyboard maps rows to inline_keyboard', () => {
    const kb = buildInlineKeyboard([
        [{ label: 'A', data: 'model:0' }],
        [{ label: 'B', data: 'sw:1' }, { label: 'C', data: 'quiz:0:2' }],
    ]);
    assert.deepStrictEqual(kb, {
        inline_keyboard: [
            [{ text: 'A', callback_data: 'model:0' }],
            [{ text: 'B', callback_data: 'sw:1' }, { text: 'C', callback_data: 'quiz:0:2' }],
        ],
    });
});
test('buildInlineKeyboard throws when callback_data exceeds 64 bytes', () => {
    const tooLong = 'x'.repeat(65);
    assert.throws(() => buildInlineKeyboard([[{ label: 'L', data: tooLong }]]), /64 bytes/);
});
// ── URL buttons ──────────────────────────────────────────────────────
test('buildInlineKeyboard supports url buttons alongside callback buttons', () => {
    const kb = buildInlineKeyboard([[
            { label: 'switch', data: 'sw:1' },
            { label: 'open', url: 'https://t.me/c/123/55' },
        ]]);
    assert.deepStrictEqual(kb.inline_keyboard[0], [
        { text: 'switch', callback_data: 'sw:1' },
        { text: 'open', url: 'https://t.me/c/123/55' },
    ]);
    assert.throws(() => buildInlineKeyboard([[{ label: 'empty' }]]), /neither data nor url/);
});
// ── expandable blockquote ────────────────────────────────────────────
test('findExpandableSplit picks a line boundary outside code fences', () => {
    const text = ['head line', '```', 'code '.repeat(50), '```', 'tail line'].join('\n');
    const split = findExpandableSplit(text, 5);
    // must not split inside the fence: boundary lands at the end of a fence-closed region
    const head = text.slice(0, split);
    assert.strictEqual((head.match(/```/g) || []).length % 2, 0);
});
test('findExpandableSplit returns -1 for short text', () => {
    assert.strictEqual(findExpandableSplit('short', 600), -1);
});
test('toExpandableHtml wraps the tail in an expandable blockquote', () => {
    const text = Array.from({ length: 60 }, (_, i) => `line ${i} of the long answer`).join('\n');
    const out = toExpandableHtml(text, 100);
    assert.ok(out.includes('<blockquote expandable>'));
    assert.ok(out.endsWith('</blockquote>'));
    assert.ok(out.indexOf('line 0') < out.indexOf('<blockquote expandable>'));
});
test('toExpandableHtml falls back to plain rendering when no safe split exists', () => {
    const out = toExpandableHtml('tiny', 600);
    assert.strictEqual(out, 'tiny');
});
