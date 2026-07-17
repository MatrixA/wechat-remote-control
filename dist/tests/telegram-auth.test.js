import { test } from 'node:test';
import assert from 'node:assert';
import { isChatAllowed } from '../telegram/auth.js';
const base = { botToken: 't', createdAt: '2026-01-01' };
test('isChatAllowed permits any chat while unbound (first contact captures)', () => {
    assert.strictEqual(isChatAllowed(base, '42'), true);
    assert.strictEqual(isChatAllowed(base, '99'), true);
});
test('isChatAllowed locks to the bound chat once set', () => {
    const bound = { ...base, allowedChatId: '42' };
    assert.strictEqual(isChatAllowed(bound, '42'), true);
    assert.strictEqual(isChatAllowed(bound, '99'), false);
    assert.strictEqual(isChatAllowed(bound, ''), false);
});
test('isChatAllowed also admits the bound topics group', () => {
    const bound = { ...base, allowedChatId: '42', groupChatId: '-100777' };
    assert.strictEqual(isChatAllowed(bound, '-100777'), true);
    assert.strictEqual(isChatAllowed(bound, '-100778'), false);
});
test('isChatAllowed admits the owner from any chat (enables /bind in a new group)', () => {
    const bound = { ...base, allowedChatId: '42' };
    // owner (user id 42 == locked private chat id) speaking inside an unbound group
    assert.strictEqual(isChatAllowed(bound, '-100999', '42'), true);
    // a stranger in that group is still dropped
    assert.strictEqual(isChatAllowed(bound, '-100999', '7'), false);
});
