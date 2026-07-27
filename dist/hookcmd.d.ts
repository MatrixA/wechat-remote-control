import type { AgentKind } from './constants.js';
/**
 * Port of CPython's `shlex.quote` (POSIX): returns the string unquoted when it
 * contains only shell-safe characters, otherwise wraps it in single quotes with
 * embedded single quotes escaped as `'"'"'`. The safe set matches shlex's
 * `_find_unsafe = re.compile(r'[^\w@%+=:,./-]', re.ASCII)`.
 */
export declare function shQuote(s: string): string;
/** The exact guarded shell command registered for one hook event. */
export declare function guardedHookCommand(skillDir: string, arg: string): string;
/** Event-name → hook.py arg map for the given agent. */
export declare function hookEventsFor(kind: AgentKind): Record<string, string>;
/** Substring that identifies a wrc hook entry (used by the migrate-not-skip filter). */
export declare const HOOK_MARK = "wechat-remote-control/hook.py";
/**
 * Is this hook command one of ours?
 *
 * HOOK_MARK alone only recognises an install whose directory is literally named
 * `wechat-remote-control`. That is what `git clone` and `npx skills add` produce, but a
 * renamed clone (a worktree, a `-v1` suffix, a vendored copy) silently fell outside it:
 * migrate-not-skip stopped matching, so every attach appended another duplicate entry,
 * and uninstall reported success while removing nothing. Matching the caller's own
 * install path as well fixes both. It is a strict superset — everything HOOK_MARK
 * matched before still matches — so no already-installed entry becomes unrecognisable.
 *
 * `stripWrcStatusLine` has always keyed off skillDir this way; the hook side was the
 * odd one out.
 */
export declare function isWrcHookCommand(command: unknown, skillDir?: string): boolean;
/** Which config file holds this agent's hooks, given its config dir. */
export declare function hookConfigFileFor(kind: AgentKind, configDir: string): string;
/**
 * Merge wrc's hook entries for `kind` into `cfg`, in place, and return it.
 *
 * Every other tool's hooks and every unrelated setting survive untouched: for each of
 * our events we strip only entries carrying HOOK_MARK, drop groups left empty by that
 * strip, then append exactly one fresh guarded entry. Running it twice yields an
 * identical object, and running it over a config broken by an older install repairs it.
 */
export declare function mergeWrcHooks(cfg: any, skillDir: string, kind: AgentKind): any;
/** The statusLine entry attach installs for Claude (Codex has no status line). */
export declare function wrcStatusLine(skillDir: string): {
    type: 'command';
    command: string;
};
