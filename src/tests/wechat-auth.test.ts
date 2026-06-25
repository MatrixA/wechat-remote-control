import { test } from 'node:test';
import assert from 'node:assert';

import { isWeChatUserAllowed } from '../wechat/accounts.js';
import type { AccountData } from '../wechat/accounts.js';

const base: AccountData = {
  botToken: 't', accountId: 'bot', baseUrl: 'https://ilinkai.weixin.qq.com',
  userId: 'owner', createdAt: '2026-01-01',
};

test('isWeChatUserAllowed permits any sender while unbound (first contact captures)', () => {
  assert.strictEqual(isWeChatUserAllowed(base, 'u1'), true);
  assert.strictEqual(isWeChatUserAllowed(base, 'u2'), true);
});

test('isWeChatUserAllowed locks to the bound user once set', () => {
  const bound: AccountData = { ...base, allowedUserId: 'u1' };
  assert.strictEqual(isWeChatUserAllowed(bound, 'u1'), true);
  assert.strictEqual(isWeChatUserAllowed(bound, 'u2'), false);
  assert.strictEqual(isWeChatUserAllowed(bound, ''), false);
});
