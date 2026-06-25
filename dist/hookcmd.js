/**
 * Source-of-truth MIRROR of the SKILL.md "attach Step 4" hooks writer.
 *
 * The skill registers agent hooks via an inline Python heredoc in SKILL.md — that
 * heredoc is the canonical implementation. This module reproduces the two
 * load-bearing invariants so they can be unit-tested. Keep the two byte-identical
 * (including the shlex-quoting of the path).
 *
 *   1. GUARDED command — a missing/erroring hook.py can never block a prompt:
 *        [ -f <hook.py> ] && python3 <hook.py> <arg> 2>/dev/null; exit 0
 *      Only stderr is redirected; stdout still carries the PreToolUse
 *      permission-decision JSON the agent reads to auto-approve, and `exit 0` is
 *      forced. A bare `python3 <missing>.py` exits 2, which Codex treats as a
 *      UserPromptSubmit BLOCK (surfacing stderr as the reason) — the exact bug this
 *      guards against. We never emit a deny/exit-2.
 *   2. Per-agent event set — Codex fires UserPromptSubmit (no Notification); Claude
 *      fires Notification (no UserPromptSubmit).
 */
import { join } from 'node:path';
/**
 * Mirror of CPython's `shlex.quote` (POSIX): returns the string unquoted when it
 * contains only shell-safe characters, otherwise wraps it in single quotes with
 * embedded single quotes escaped as `'"'"'`. The safe set matches shlex's
 * `_find_unsafe = re.compile(r'[^\w@%+=:,./-]', re.ASCII)`.
 */
export function shQuote(s) {
    if (s === '')
        return "''";
    if (!/[^\w@%+=:,.\/-]/.test(s))
        return s;
    return "'" + s.replace(/'/g, `'"'"'`) + "'";
}
/** The exact guarded shell command registered for one hook event. */
export function guardedHookCommand(skillDir, arg) {
    const qbase = shQuote(join(skillDir, 'hook.py'));
    return `[ -f ${qbase} ] && python3 ${qbase} ${arg} 2>/dev/null; exit 0`;
}
/** Event-name → hook.py arg map for the given agent. */
export function hookEventsFor(kind) {
    return kind === 'codex'
        ? { PreToolUse: 'pretooluse', Stop: 'stop', UserPromptSubmit: 'userpromptsubmit' }
        : { PreToolUse: 'pretooluse', Stop: 'stop', Notification: 'notification' };
}
/** Substring that identifies a wrc hook entry (used by the migrate-not-skip filter). */
export const HOOK_MARK = 'wechat-remote-control/hook.py';
