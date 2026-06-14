import { test } from 'node:test';
import assert from 'node:assert';
import { encodeQrMatrix, renderTerminalQr } from '../wechat/qrcode.js';
const FINDER = [
    [1, 1, 1, 1, 1, 1, 1],
    [1, 0, 0, 0, 0, 0, 1],
    [1, 0, 1, 1, 1, 0, 1],
    [1, 0, 1, 1, 1, 0, 1],
    [1, 0, 1, 1, 1, 0, 1],
    [1, 0, 0, 0, 0, 0, 1],
    [1, 1, 1, 1, 1, 1, 1],
];
function assertFinder(matrix, ox, oy) {
    for (let y = 0; y < 7; y++) {
        for (let x = 0; x < 7; x++) {
            assert.strictEqual(matrix[oy + y][ox + x], FINDER[y][x] === 1, `finder mismatch at (${ox + x},${oy + y})`);
        }
    }
}
test('matrix is square with a valid QR size', () => {
    const m = encodeQrMatrix('https://example.com/login?token=abc123');
    const size = m.length;
    assert.ok(m.every((row) => row.length === size), 'rows must match width');
    assert.strictEqual((size - 17) % 4, 0, 'size must be 4*version+17');
    assert.ok(size >= 21 && size <= 177, 'size within QR bounds');
});
test('finder patterns present in three corners', () => {
    const m = encodeQrMatrix('hello world');
    const size = m.length;
    assertFinder(m, 0, 0);
    assertFinder(m, size - 7, 0);
    assertFinder(m, 0, size - 7);
});
test('timing patterns alternate on row/col 6', () => {
    const m = encodeQrMatrix('timing-pattern-check');
    const size = m.length;
    for (let i = 8; i < size - 8; i++) {
        assert.strictEqual(m[6][i], i % 2 === 0, `row-6 timing at ${i}`);
        assert.strictEqual(m[i][6], i % 2 === 0, `col-6 timing at ${i}`);
    }
});
test('dark module is always set', () => {
    const m = encodeQrMatrix('dark-module');
    const size = m.length;
    assert.strictEqual(m[size - 8][8], true);
});
test('encoding is deterministic', () => {
    const a = encodeQrMatrix('deterministic-payload-123');
    const b = encodeQrMatrix('deterministic-payload-123');
    assert.deepStrictEqual(a, b);
});
test('version grows with payload length', () => {
    const small = encodeQrMatrix('x').length;
    const large = encodeQrMatrix('y'.repeat(400)).length;
    assert.strictEqual(small, 21, 'single char fits version 1');
    assert.ok(large > small, 'long payload needs a larger version');
});
test('renderTerminalQr emits aligned half-block rows', () => {
    const out = renderTerminalQr('https://weixin.qq.com/q/abcXYZ123', { margin: 2 });
    const lines = out.split('\n');
    const width = lines[0].length;
    assert.ok(lines.length > 1, 'multiple rows');
    assert.ok(lines.every((l) => l.length === width), 'all rows equal width');
    const allowed = new Set(['█', '▀', '▄', ' ']);
    for (const ch of out) {
        if (ch === '\n')
            continue;
        assert.ok(allowed.has(ch), `unexpected char: ${JSON.stringify(ch)}`);
    }
    // size = render width minus 2*margin on each side; rows pack 2 modules each.
    const size = width - 4;
    assert.strictEqual(lines.length, Math.ceil((size + 4) / 2));
});
