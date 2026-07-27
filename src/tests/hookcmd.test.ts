import { test } from 'node:test';
import assert from 'node:assert';
import {
  guardedHookCommand, hookEventsFor, shQuote, HOOK_MARK,
  mergeWrcHooks, wrcStatusLine, hookConfigFileFor, isWrcHookCommand,
} from '../hookcmd.js';
import { stripWrcHooks, stripWrcStatusLine } from '../hookuninstall.js';

const DIR = '/home/u/.claude/skills/wechat-remote-control';

test('guarded command for a normal path (unquoted, matches shlex.quote)', () => {
  const dir = '/home/u/.agents/skills/wechat-remote-control';
  assert.strictEqual(
    guardedHookCommand(dir, 'userpromptsubmit'),
    '[ -f /home/u/.agents/skills/wechat-remote-control/hook.py ] && ' +
      'python3 /home/u/.agents/skills/wechat-remote-control/hook.py userpromptsubmit 2>/dev/null; exit 0',
  );
});

test('command can never block: always ends with "; exit 0"', () => {
  for (const arg of ['pretooluse', 'stop', 'userpromptsubmit', 'notification']) {
    assert.ok(guardedHookCommand('/x/wechat-remote-control', arg).endsWith('; exit 0'));
  }
});

test('only stderr is redirected — stdout (PreToolUse allow JSON) must still flow', () => {
  const cmd = guardedHookCommand('/x/wechat-remote-control', 'pretooluse');
  assert.match(cmd, /2>\/dev\/null/); // stderr suppressed
  assert.doesNotMatch(cmd, /(^|[^2])>\/dev\/null/); // stdout never redirected
});

test('codex events include UserPromptSubmit and exclude Notification', () => {
  const e = hookEventsFor('codex');
  assert.ok('UserPromptSubmit' in e);
  assert.ok(!('Notification' in e));
  assert.strictEqual(e.UserPromptSubmit, 'userpromptsubmit');
});

test('claude events include Notification and exclude UserPromptSubmit', () => {
  const e = hookEventsFor('claude');
  assert.ok('Notification' in e);
  assert.ok(!('UserPromptSubmit' in e));
  assert.strictEqual(e.Notification, 'notification');
});

test('paths with spaces are single-quoted so [ -f ... ] parses as one arg', () => {
  const cmd = guardedHookCommand('/home/My Skills/wechat-remote-control', 'stop');
  assert.ok(cmd.includes("[ -f '/home/My Skills/wechat-remote-control/hook.py' ]"));
  assert.ok(cmd.includes("python3 '/home/My Skills/wechat-remote-control/hook.py' stop"));
});

test('command contains HOOK_MARK so the migrate-not-skip filter matches it', () => {
  assert.ok(guardedHookCommand('/x/wechat-remote-control', 'stop').includes(HOOK_MARK));
});

test('shQuote mirrors shlex.quote: safe unquoted, unsafe single-quoted', () => {
  assert.strictEqual(shQuote('/a/b-c.py'), '/a/b-c.py');
  assert.strictEqual(shQuote('a b'), "'a b'");
  assert.strictEqual(shQuote("a'b"), `'a'"'"'b'`);
  assert.strictEqual(shQuote(''), "''");
});

test('merge writes exactly one entry per event of the agent kind', () => {
  const cfg = mergeWrcHooks({}, DIR, 'codex');
  assert.deepStrictEqual(Object.keys(cfg.hooks).sort(), ['PreToolUse', 'Stop', 'UserPromptSubmit']);
  for (const event of Object.keys(cfg.hooks)) {
    assert.strictEqual(cfg.hooks[event].length, 1);
    assert.strictEqual(cfg.hooks[event][0].hooks.length, 1);
    assert.ok(cfg.hooks[event][0].hooks[0].command.includes(HOOK_MARK));
  }
});

test('merge is idempotent — a second run yields a deep-equal config', () => {
  const once = mergeWrcHooks({}, DIR, 'claude');
  const twice = mergeWrcHooks(JSON.parse(JSON.stringify(once)), DIR, 'claude');
  assert.deepStrictEqual(twice, once);
});

test('merge preserves other tools hooks, on our events and on theirs', () => {
  const foreign = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo other' }] };
  const cfg: any = mergeWrcHooks({
    hooks: {
      Stop: [foreign],
      SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'echo theirs' }] }],
    },
    otherSetting: 42,
  }, DIR, 'claude');

  assert.deepStrictEqual(cfg.hooks.Stop[0], foreign);       // theirs kept, and kept first
  assert.strictEqual(cfg.hooks.Stop.length, 2);             // ours appended after
  assert.strictEqual(cfg.hooks.SessionStart.length, 1);     // event we never touch
  assert.strictEqual(cfg.otherSetting, 42);
});

test('merge migrates a stale wrc entry instead of appending a duplicate', () => {
  // An old install: unguarded command, wrong dir — but still carries HOOK_MARK.
  const stale = '/old/path/wechat-remote-control/hook.py stop';
  const cfg: any = mergeWrcHooks({
    hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: stale }] }] },
  }, DIR, 'claude');

  assert.strictEqual(cfg.hooks.Stop.length, 1);             // emptied group dropped, one fresh
  assert.strictEqual(cfg.hooks.Stop[0].hooks[0].command, guardedHookCommand(DIR, 'stop'));
});

test('a group holding both a stale wrc entry and a foreign one keeps only the foreign', () => {
  const cfg: any = mergeWrcHooks({
    hooks: {
      Stop: [{
        matcher: '',
        hooks: [
          { type: 'command', command: `python3 /x/wechat-remote-control/hook.py stop` },
          { type: 'command', command: 'echo keep-me' },
        ],
      }],
    },
  }, DIR, 'claude');

  assert.deepStrictEqual(cfg.hooks.Stop[0].hooks, [{ type: 'command', command: 'echo keep-me' }]);
  assert.strictEqual(cfg.hooks.Stop[1].hooks[0].command, guardedHookCommand(DIR, 'stop'));
});

test('strip is the exact inverse of merge on an untouched config', () => {
  const original = { hooks: { Stop: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo other' }] }] } };
  const merged = mergeWrcHooks(JSON.parse(JSON.stringify(original)), DIR, 'codex');
  assert.deepStrictEqual(stripWrcHooks(merged), original);
});

test('strip after merge on an empty config leaves no dangling hooks key', () => {
  const cfg = stripWrcHooks(mergeWrcHooks({}, DIR, 'claude'));
  assert.deepStrictEqual(cfg, {});
});

test('statusLine round-trips: installed then stripped leaves settings clean', () => {
  const settings: any = { theme: 'dark', statusLine: wrcStatusLine(DIR) };
  assert.strictEqual(settings.statusLine.command, `bash ${DIR}/status.sh`);
  stripWrcStatusLine(settings, DIR);
  assert.deepStrictEqual(settings, { theme: 'dark' });
});

test('hook config file is settings.json for claude, hooks.json for codex', () => {
  assert.strictEqual(hookConfigFileFor('claude', '/home/u/.claude'), '/home/u/.claude/settings.json');
  assert.strictEqual(hookConfigFileFor('codex', '/home/u/.codex'), '/home/u/.codex/hooks.json');
});

// An install dir not literally named `wechat-remote-control` — a worktree, a renamed
// clone, a vendored copy. HOOK_MARK alone does not see these.
const ODD = '/home/u/checkouts/wrc-v2';

test('ours-detection: HOOK_MARK always wins, skillDir catches a renamed install', () => {
  assert.ok(isWrcHookCommand(guardedHookCommand(DIR, 'stop')));              // canonical, no dir needed
  assert.ok(isWrcHookCommand(guardedHookCommand(ODD, 'stop'), ODD));         // renamed, dir supplied
  assert.ok(!isWrcHookCommand(guardedHookCommand(ODD, 'stop')));             // renamed, no dir → invisible
  assert.ok(!isWrcHookCommand('echo unrelated', ODD));
  assert.ok(!isWrcHookCommand(undefined, ODD));
});

test('a renamed install still migrates instead of duplicating', () => {
  let cfg = mergeWrcHooks({}, ODD, 'claude');
  cfg = mergeWrcHooks(JSON.parse(JSON.stringify(cfg)), ODD, 'claude');
  assert.strictEqual(cfg.hooks.Stop.length, 1, 'second install must replace, not append');
});

test('a renamed install is fully removed by uninstall', () => {
  const cfg = stripWrcHooks(mergeWrcHooks({}, ODD, 'claude'), ODD);
  assert.deepStrictEqual(cfg, {}, 'uninstall must not silently leave entries behind');
});

test('widening is a strict superset: canonical entries strip with or without skillDir', () => {
  assert.deepStrictEqual(stripWrcHooks(mergeWrcHooks({}, DIR, 'claude')), {});
  assert.deepStrictEqual(stripWrcHooks(mergeWrcHooks({}, DIR, 'claude'), DIR), {});
  // A foreign command that merely lives under our dir name is still not ours.
  const foreign = { hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: `bash ${ODD}/other.sh` }] }] } };
  assert.deepStrictEqual(stripWrcHooks(JSON.parse(JSON.stringify(foreign)), ODD), foreign);
});
