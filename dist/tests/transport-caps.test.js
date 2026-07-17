import { test } from 'node:test';
import assert from 'node:assert';
import { createTransport, resolveTransportName } from '../transport/index.js';
test('createTransport returns the wechat adapter with text-only caps', async () => {
    const t = await createTransport('wechat');
    assert.strictEqual(t.name, 'wechat');
    assert.strictEqual(t.caps.inlineKeyboards, false);
    assert.strictEqual(t.caps.editMessages, false);
    assert.strictEqual(t.caps.commandMenu, false);
    assert.strictEqual(t.caps.topics, false);
    assert.strictEqual(t.caps.reactions, false);
    assert.strictEqual(t.caps.documents, false);
    assert.strictEqual(t.caps.maxMessageLen, 2048);
});
test('createTransport returns the telegram adapter with rich caps', async () => {
    const t = await createTransport('telegram');
    assert.strictEqual(t.name, 'telegram');
    assert.strictEqual(t.caps.inlineKeyboards, true);
    assert.strictEqual(t.caps.editMessages, true);
    assert.strictEqual(t.caps.commandMenu, true);
    assert.strictEqual(t.caps.reactions, true);
    assert.strictEqual(t.caps.documents, true);
    // topics stays false until a group is bound at start()
    assert.strictEqual(t.caps.topics, false);
    assert.ok(t.caps.maxMessageLen >= 2048);
});
test('resolveTransportName honours the explicit flag over the creds heuristic', () => {
    assert.strictEqual(resolveTransportName(['--telegram']), 'telegram');
    assert.strictEqual(resolveTransportName(['--wechat']), 'wechat');
});
test('resolveTransportName honours WCC_TRANSPORT env (highest priority)', () => {
    const prev = process.env.WCC_TRANSPORT;
    try {
        process.env.WCC_TRANSPORT = 'telegram';
        assert.strictEqual(resolveTransportName([]), 'telegram');
        process.env.WCC_TRANSPORT = 'wechat';
        assert.strictEqual(resolveTransportName(['--telegram']), 'wechat'); // env wins over argv
    }
    finally {
        if (prev === undefined)
            delete process.env.WCC_TRANSPORT;
        else
            process.env.WCC_TRANSPORT = prev;
    }
});
