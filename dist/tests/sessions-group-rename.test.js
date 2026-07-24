import { test } from 'node:test';
import assert from 'node:assert';
import { renameTmuxGroupInRegistry } from '../sessions.js';
// alpha (2 panes, one without a paneId) + alpha2 (prefix trap) + bravo.
function reg(overrides = {}) {
    return {
        active: 'a1',
        sessions: {
            a1: { tmux: 'alpha:1.0', paneId: '%1', cwd: '/h/a1', kind: 'claude' },
            a2: { tmux: 'alpha:2.0', cwd: '/h/a2', kind: 'claude' }, // no paneId yet
            trap: { tmux: 'alpha2:1.0', paneId: '%4', cwd: '/h/trap', kind: 'claude' },
            b1: { tmux: 'bravo:1.0', paneId: '%3', cwd: '/h/b1', kind: 'codex' },
        },
        ...overrides,
    };
}
test('renameTmuxGroupInRegistry rewrites every member coordinate, others untouched', () => {
    const r = reg();
    const res = renameTmuxGroupInRegistry(r, 'alpha', 'renamed');
    assert.deepStrictEqual(res.renamed.sort(), ['a1', 'a2']);
    assert.strictEqual(r.sessions.a1.tmux, 'renamed:1.0');
    assert.strictEqual(r.sessions.a2.tmux, 'renamed:2.0');
    assert.strictEqual(r.sessions.b1.tmux, 'bravo:1.0');
});
test('renameTmuxGroupInRegistry matches by session equality, not prefix', () => {
    // Renaming "alpha" must not capture "alpha2:1.0".
    const r = reg();
    renameTmuxGroupInRegistry(r, 'alpha', 'renamed');
    assert.strictEqual(r.sessions.trap.tmux, 'alpha2:1.0');
});
test('renameTmuxGroupInRegistry follows focusedTmuxSession only when it named the old group', () => {
    const focused = reg({ focusedTmuxSession: 'alpha' });
    renameTmuxGroupInRegistry(focused, 'alpha', 'renamed');
    assert.strictEqual(focused.focusedTmuxSession, 'renamed');
    const other = reg({ focusedTmuxSession: 'bravo' });
    renameTmuxGroupInRegistry(other, 'alpha', 'renamed');
    assert.strictEqual(other.focusedTmuxSession, 'bravo');
});
test('renameTmuxGroupInRegistry migrates keys only for paneId-less members', () => {
    const r = reg();
    const res = renameTmuxGroupInRegistry(r, 'alpha', 'renamed');
    // a1 has %1 → key unchanged; a2 is keyed by its coordinates → must migrate.
    assert.deepStrictEqual(res.keyMigrations, [
        { from: 'tmux:alpha:2.0', to: 'tmux:renamed:2.0' },
    ]);
});
test('renameTmuxGroupInRegistry is a no-op for an unknown group', () => {
    const r = reg({ focusedTmuxSession: 'alpha' });
    const res = renameTmuxGroupInRegistry(r, 'ghost', 'renamed');
    assert.deepStrictEqual(res, { renamed: [], keyMigrations: [] });
    assert.strictEqual(r.sessions.a1.tmux, 'alpha:1.0');
    assert.strictEqual(r.focusedTmuxSession, 'alpha');
});
