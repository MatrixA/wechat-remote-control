import { test } from 'node:test';
import assert from 'node:assert';
import { stripWrcHooks, stripWrcStatusLine } from '../hookuninstall.js';
import { guardedHookCommand, hookEventsFor } from '../hookcmd.js';
const SKILL_DIR = '/home/u/.claude/skills/wechat-remote-control';
/** Reproduce what attach Step 4 writes into a config for the given agent kind. */
function attachWrite(cfg, kind, skillDir = SKILL_DIR) {
    const hooks = (cfg.hooks ??= {});
    for (const [event, arg] of Object.entries(hookEventsFor(kind))) {
        const command = guardedHookCommand(skillDir, arg);
        const groups = (hooks[event] ??= []);
        for (const g of groups) {
            g.hooks = (g.hooks ?? []).filter((h) => !String(h?.command ?? '').includes('wechat-remote-control/hook.py'));
        }
        hooks[event] = groups.filter((g) => g.hooks?.length);
        hooks[event].push({ matcher: '', hooks: [{ type: 'command', command }] });
    }
    return cfg;
}
test('roundtrip: attach then strip returns an empty config (claude)', () => {
    const cfg = attachWrite({}, 'claude');
    assert.ok(cfg.hooks.PreToolUse); // sanity: attach wrote something
    const cleaned = stripWrcHooks(cfg);
    assert.deepStrictEqual(cleaned, {});
});
test('roundtrip: attach then strip returns an empty config (codex)', () => {
    const cfg = attachWrite({}, 'codex');
    assert.ok(cfg.hooks.UserPromptSubmit);
    assert.deepStrictEqual(stripWrcHooks(cfg), {});
});
test('preserves a non-wrc hook in the same event group', () => {
    const otherCmd = 'python3 /opt/other/hook.py stop';
    const cfg = {
        hooks: {
            Stop: [
                { matcher: '', hooks: [{ type: 'command', command: otherCmd }] },
            ],
        },
    };
    attachWrite(cfg, 'claude'); // adds wrc groups alongside the foreign one
    const cleaned = stripWrcHooks(cfg);
    // Foreign Stop hook survives; wrc Stop/PreToolUse/Notification groups gone.
    assert.strictEqual(cleaned.hooks.Stop.length, 1);
    assert.strictEqual(cleaned.hooks.Stop[0].hooks[0].command, otherCmd);
    assert.ok(!('PreToolUse' in cleaned.hooks));
    assert.ok(!('Notification' in cleaned.hooks));
});
test('preserves unrelated top-level settings', () => {
    const cfg = { model: 'opus', permissions: { allow: ['Bash'] } };
    attachWrite(cfg, 'claude');
    const cleaned = stripWrcHooks(cfg);
    assert.strictEqual(cleaned.model, 'opus');
    assert.deepStrictEqual(cleaned.permissions, { allow: ['Bash'] });
    assert.ok(!('hooks' in cleaned));
});
test('drops a group emptied by filtering but keeps a sibling group', () => {
    const cfg = {
        hooks: {
            PreToolUse: [
                { matcher: '', hooks: [{ type: 'command', command: guardedHookCommand(SKILL_DIR, 'pretooluse') }] },
                { matcher: 'Edit', hooks: [{ type: 'command', command: 'echo keep' }] },
            ],
        },
    };
    const cleaned = stripWrcHooks(cfg);
    assert.strictEqual(cleaned.hooks.PreToolUse.length, 1);
    assert.strictEqual(cleaned.hooks.PreToolUse[0].matcher, 'Edit');
});
test('idempotent: stripping twice equals stripping once', () => {
    const once = stripWrcHooks(attachWrite({ model: 'x' }, 'codex'));
    const twice = stripWrcHooks(JSON.parse(JSON.stringify(once)));
    assert.deepStrictEqual(twice, once);
});
test('safe on empty / missing config', () => {
    assert.deepStrictEqual(stripWrcHooks({}), {});
    assert.deepStrictEqual(stripWrcHooks({ hooks: {} }), {});
    assert.strictEqual(stripWrcHooks(null), null);
    assert.strictEqual(stripWrcHooks(undefined), undefined);
});
test('statusLine removed only when it points at this skill', () => {
    const mine = { statusLine: { type: 'command', command: `bash ${SKILL_DIR}/status.sh` }, theme: 'dark' };
    const cleaned = stripWrcStatusLine(mine, SKILL_DIR);
    assert.ok(!('statusLine' in cleaned));
    assert.strictEqual(cleaned.theme, 'dark');
});
test('statusLine pointing elsewhere is preserved', () => {
    const other = { statusLine: { type: 'command', command: 'bash /opt/mybar/status.sh' } };
    const cleaned = stripWrcStatusLine(other, SKILL_DIR);
    assert.deepStrictEqual(cleaned.statusLine, { type: 'command', command: 'bash /opt/mybar/status.sh' });
});
test('statusLine strip is safe when absent', () => {
    assert.deepStrictEqual(stripWrcStatusLine({}, SKILL_DIR), {});
    assert.strictEqual(stripWrcStatusLine(null, SKILL_DIR), null);
});
