import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Must set CLAUDE_CONFIG_DIR before importing modules that capture it at load.
const tmpRoot = mkdtempSync(join(tmpdir(), 'wrc-config-'));
process.env.CLAUDE_CONFIG_DIR = tmpRoot;

const { encodeCwd, isSameProjectDir, CLAUDE_PROJECTS_DIR } = await import('../constants.js');

test('encodeCwd replaces every non-[A-Za-z0-9-] char with dash (matches detect.py & index.js)', () => {
  assert.strictEqual(encodeCwd('/Users/foo.bar/my_dir baz'), '-Users-foo-bar-my-dir-baz');
  assert.strictEqual(encodeCwd('/mnt/data/playground'), '-mnt-data-playground');
  assert.strictEqual(encodeCwd('/a.b_c d'), '-a-b-c-d');
});

// Regression: encoding is ASCII-only. Claude Code maps each non-ASCII (e.g. CJK)
// char to '-' (verified empirically: ~/Documents/社会实践 → ...-Documents-----).
// The previous Unicode-aware impl kept CJK chars and silently disagreed with the
// daemon, breaking transcript discovery for non-English project paths.
test('encodeCwd is ASCII-only — non-ASCII chars each become a dash', () => {
  assert.strictEqual(encodeCwd('/Users/me/社会实践'), '-Users-me-----');
  assert.strictEqual(encodeCwd('/Users/José/café'), '-Users-Jos--caf-');
  // Mirror of detect.py's encode_cwd, computed independently, must agree exactly.
  const detectPyEncode = (cwd: string) =>
    [...cwd].map((c) => (/[A-Za-z0-9]/.test(c) && c.codePointAt(0)! < 128) || c === '-' ? c : '-').join('');
  for (const p of ['/Users/me/社会实践', '/proj/日本語/x', '/tmp/Ω-test', '/a_b.c d']) {
    assert.strictEqual(encodeCwd(p), detectPyEncode(p), `parity for ${p}`);
  }
});

test('CLAUDE_PROJECTS_DIR honours CLAUDE_CONFIG_DIR', () => {
  assert.strictEqual(CLAUDE_PROJECTS_DIR, join(tmpRoot, 'projects'));
});

// isSameProjectDir gates onStop's compaction-grace / same-project Stop acceptance.
// The critical guarantee: a Stop from a DIFFERENT project must NOT be treated as
// ours (that bug forwarded a foreign session's reply to the IM).
test('isSameProjectDir: same project dir → true, foreign project → false', () => {
  const proj = '/Users/me/.claude/projects/-Users-me-app';
  assert.strictEqual(isSameProjectDir(`${proj}/a.jsonl`, `${proj}/b.jsonl`), true);  // same project, different file
  assert.strictEqual(isSameProjectDir(`${proj}/a.jsonl`, `${proj}/a.jsonl`), true);  // identical
  // Foreign project (the C1 case): must be rejected.
  assert.strictEqual(
    isSameProjectDir(`${proj}/a.jsonl`, '/Users/me/.claude/projects/-Users-me-other/c.jsonl'),
    false,
  );
  // Null / missing inputs are never "same".
  assert.strictEqual(isSameProjectDir(null, `${proj}/a.jsonl`), false);
  assert.strictEqual(isSameProjectDir(`${proj}/a.jsonl`, undefined), false);
  assert.strictEqual(isSameProjectDir(null, null), false);
});
