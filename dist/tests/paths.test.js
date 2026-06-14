import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Must set CLAUDE_CONFIG_DIR before importing modules that capture it at load.
const tmpRoot = mkdtempSync(join(tmpdir(), 'wrc-config-'));
process.env.CLAUDE_CONFIG_DIR = tmpRoot;
const { encodeCwd, CLAUDE_PROJECTS_DIR } = await import('../constants.js');
const { getLatestSessionId } = await import('../bridge.js');
test('encodeCwd replaces every non-alphanumeric char with dash (matches detect.py)', () => {
    assert.strictEqual(encodeCwd('/Users/foo.bar/my_dir baz'), '-Users-foo-bar-my-dir-baz');
    assert.strictEqual(encodeCwd('/mnt/data/playground'), '-mnt-data-playground');
    assert.strictEqual(encodeCwd('/a.b_c d'), '-a-b-c-d');
});
test('CLAUDE_PROJECTS_DIR honours CLAUDE_CONFIG_DIR', () => {
    assert.strictEqual(CLAUDE_PROJECTS_DIR, join(tmpRoot, 'projects'));
});
test('getLatestSessionId resolves under CLAUDE_CONFIG_DIR and picks newest', () => {
    const cwd = '/tmp/some.project_dir';
    const projDir = join(CLAUDE_PROJECTS_DIR, encodeCwd(cwd));
    mkdirSync(projDir, { recursive: true });
    const older = join(projDir, 'older-session.jsonl');
    const newer = join(projDir, 'newer-session.jsonl');
    writeFileSync(older, '{}');
    writeFileSync(newer, '{}');
    const now = Date.now() / 1000;
    utimesSync(older, now - 100, now - 100);
    utimesSync(newer, now, now);
    assert.strictEqual(getLatestSessionId(cwd), 'newer-session');
});
test('getLatestSessionId returns undefined for unknown cwd', () => {
    assert.strictEqual(getLatestSessionId('/no/such/project/here'), undefined);
});
