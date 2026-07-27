/**
 * THE hooks writer. `bin/hooks.mjs` (driven by `bin/wrc hooks install`) is the only
 * caller; SKILL.md's attach Step 4/5 shells out to it rather than re-implementing the
 * merge inline. This module used to be a test-only mirror of a Python heredoc in
 * SKILL.md — the two are now one, so these unit tests cover the real thing.
 *
 * Three load-bearing invariants:
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
 *   3. MIGRATE, don't skip — a pre-existing wrc handler (old hardcoded path, unguarded
 *      command, wrong install dir) is stripped and replaced with the fresh guarded one,
 *      so re-running install self-heals an already-broken config and is idempotent.
 *
 * The shell-quoting helper below stays a faithful port of CPython's `shlex.quote`
 * because the commands it produced are already sitting in users' settings.json —
 * quoting them differently on re-install would churn every existing config.
 */
import { join } from 'node:path';
import type { AgentKind } from './constants.js';

/**
 * Port of CPython's `shlex.quote` (POSIX): returns the string unquoted when it
 * contains only shell-safe characters, otherwise wraps it in single quotes with
 * embedded single quotes escaped as `'"'"'`. The safe set matches shlex's
 * `_find_unsafe = re.compile(r'[^\w@%+=:,./-]', re.ASCII)`.
 */
export function shQuote(s: string): string {
  if (s === '') return "''";
  if (!/[^\w@%+=:,.\/-]/.test(s)) return s;
  return "'" + s.replace(/'/g, `'"'"'`) + "'";
}

/** The exact guarded shell command registered for one hook event. */
export function guardedHookCommand(skillDir: string, arg: string): string {
  const qbase = shQuote(join(skillDir, 'hook.py'));
  return `[ -f ${qbase} ] && python3 ${qbase} ${arg} 2>/dev/null; exit 0`;
}

/** Event-name → hook.py arg map for the given agent. */
export function hookEventsFor(kind: AgentKind): Record<string, string> {
  return kind === 'codex'
    ? { PreToolUse: 'pretooluse', Stop: 'stop', UserPromptSubmit: 'userpromptsubmit' }
    : { PreToolUse: 'pretooluse', Stop: 'stop', Notification: 'notification' };
}

/** Substring that identifies a wrc hook entry (used by the migrate-not-skip filter). */
export const HOOK_MARK = 'wechat-remote-control/hook.py';

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
export function isWrcHookCommand(command: unknown, skillDir?: string): boolean {
  const cmd = String(command ?? '');
  if (!cmd) return false;
  if (cmd.includes(HOOK_MARK)) return true;
  return !!skillDir && cmd.includes(join(skillDir, 'hook.py'));
}

/** Which config file holds this agent's hooks, given its config dir. */
export function hookConfigFileFor(kind: AgentKind, configDir: string): string {
  return join(configDir, kind === 'codex' ? 'hooks.json' : 'settings.json');
}

/**
 * Merge wrc's hook entries for `kind` into `cfg`, in place, and return it.
 *
 * Every other tool's hooks and every unrelated setting survive untouched: for each of
 * our events we strip only entries carrying HOOK_MARK, drop groups left empty by that
 * strip, then append exactly one fresh guarded entry. Running it twice yields an
 * identical object, and running it over a config broken by an older install repairs it.
 */
export function mergeWrcHooks(cfg: any, skillDir: string, kind: AgentKind): any {
  const hooks = (cfg.hooks && typeof cfg.hooks === 'object') ? cfg.hooks : (cfg.hooks = {});

  for (const [event, arg] of Object.entries(hookEventsFor(kind))) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    const kept = [];
    for (const g of groups) {
      const inner = Array.isArray(g?.hooks) ? g.hooks : [];
      const filtered = inner.filter((h: any) => !isWrcHookCommand(h?.command, skillDir));
      if (filtered.length > 0) kept.push({ ...g, hooks: filtered });
    }
    kept.push({
      matcher: '',
      hooks: [{ type: 'command', command: guardedHookCommand(skillDir, arg) }],
    });
    hooks[event] = kept;
  }

  return cfg;
}

/** The statusLine entry attach installs for Claude (Codex has no status line). */
export function wrcStatusLine(skillDir: string): { type: 'command'; command: string } {
  return { type: 'command', command: 'bash ' + join(skillDir, 'status.sh') };
}
