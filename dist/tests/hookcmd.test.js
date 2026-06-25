import { test } from 'node:test';
import assert from 'node:assert';
import { guardedHookCommand, hookEventsFor, shQuote, HOOK_MARK } from '../hookcmd.js';
test('guarded command for a normal path (unquoted, matches shlex.quote)', () => {
    const dir = '/home/u/.agents/skills/wechat-remote-control';
    assert.strictEqual(guardedHookCommand(dir, 'userpromptsubmit'), '[ -f /home/u/.agents/skills/wechat-remote-control/hook.py ] && ' +
        'python3 /home/u/.agents/skills/wechat-remote-control/hook.py userpromptsubmit 2>/dev/null; exit 0');
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
