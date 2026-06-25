import type { AgentKind } from './constants.js';
/**
 * Mirror of CPython's `shlex.quote` (POSIX): returns the string unquoted when it
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
