import { test } from 'node:test';
import assert from 'node:assert';

import { isChatAllowed } from '../telegram/auth.js';
import type { TelegramAccount } from '../telegram/auth.js';

const base: TelegramAccount = { botToken: 't', createdAt: '2026-01-01' };

test('isChatAllowed permits any chat while unbound (first contact captures)', () => {
  assert.strictEqual(isChatAllowed(base, '42'), true);
  assert.strictEqual(isChatAllowed(base, '99'), true);
});

test('isChatAllowed locks to the bound chat once set', () => {
  const bound: TelegramAccount = { ...base, allowedChatId: '42' };
  assert.strictEqual(isChatAllowed(bound, '42'), true);
  assert.strictEqual(isChatAllowed(bound, '99'), false);
  assert.strictEqual(isChatAllowed(bound, ''), false);
});
