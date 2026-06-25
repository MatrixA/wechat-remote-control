import { test } from 'node:test';
import assert from 'node:assert';
import { escapeHtml, toTelegramHtml, buildInlineKeyboard } from '../telegram/format.js';
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
