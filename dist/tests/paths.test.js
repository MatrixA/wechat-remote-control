import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Must set CLAUDE_CONFIG_DIR before importing modules that capture it at load.
const tmpRoot = mkdtempSync(join(tmpdir(), 'wrc-config-'));
process.env.CLAUDE_CONFIG_DIR = tmpRoot;
const { encodeCwd, CLAUDE_PROJECTS_DIR } = await import('../constants.js');
test('encodeCwd replaces every non-alphanumeric char with dash (matches detect.py)', () => {
    assert.strictEqual(encodeCwd('/Users/foo.bar/my_dir baz'), '-Users-foo-bar-my-dir-baz');
    assert.strictEqual(encodeCwd('/mnt/data/playground'), '-mnt-data-playground');
    assert.strictEqual(encodeCwd('/a.b_c d'), '-a-b-c-d');
});
test('CLAUDE_PROJECTS_DIR honours CLAUDE_CONFIG_DIR', () => {
    assert.strictEqual(CLAUDE_PROJECTS_DIR, join(tmpRoot, 'projects'));
});
