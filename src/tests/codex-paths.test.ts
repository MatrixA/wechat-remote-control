import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Must set CODEX_HOME before importing modules that capture it at load.
const tmpRoot = mkdtempSync(join(tmpdir(), 'wrc-codex-'));
process.env.CODEX_HOME = tmpRoot;

const { CODEX_HOME, CODEX_SESSIONS_DIR } = await import('../constants.js');

test('CODEX_HOME honours the CODEX_HOME env var', () => {
  assert.strictEqual(CODEX_HOME, tmpRoot);
});

test('CODEX_SESSIONS_DIR resolves to <CODEX_HOME>/sessions', () => {
  assert.strictEqual(CODEX_SESSIONS_DIR, join(tmpRoot, 'sessions'));
  assert.strictEqual(CODEX_SESSIONS_DIR, join(CODEX_HOME, 'sessions'));
});
