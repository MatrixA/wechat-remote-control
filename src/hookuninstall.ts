/**
 * THE hooks/statusLine remover — the exact inverse of `mergeWrcHooks` in hookcmd.ts.
 * `bin/hooks.mjs` (driven by `bin/wrc hooks uninstall`) is the only caller; SKILL.md's
 * uninstall Step 1 shells out to it rather than re-implementing the strip inline. This
 * module used to be a test-only mirror of a Python heredoc in SKILL.md — the two are
 * now one, so these unit tests cover the real thing.
 *
 * Two load-bearing invariants:
 *
 *   1. MERGE-SAFE strip — only wrc's own entries are removed. Any hook entry whose
 *      command contains HOOK_MARK ('wechat-remote-control/hook.py') is dropped;
 *      everything else (other tools' hooks, unrelated settings) is left untouched.
 *      Emptied hook groups, emptied event arrays, and an emptied `hooks` object are
 *      pruned so the config is byte-clean (no dangling `{"hooks": {}}`).
 *   2. statusLine is removed ONLY when it points at THIS skill's status.sh — a
 *      statusLine the user set to something else is preserved.
 *
 * Both functions are pure and idempotent: running them on already-clean config is a
 * no-op, and they tolerate missing keys / empty objects.
 */
import { join } from 'node:path';
import { isWrcHookCommand } from './hookcmd.js';

/**
 * Return a copy of `cfg` with every wrc hook entry removed and all resulting empty
 * containers pruned. Other hooks and settings are preserved. Idempotent.
 *
 * Pass `skillDir` so entries installed from a directory not named `wechat-remote-control`
 * are recognised too — without it they survive an uninstall that reports success.
 */
export function stripWrcHooks(cfg: any, skillDir?: string): any {
  if (!cfg || typeof cfg !== 'object') return cfg;
  const hooks = cfg.hooks;
  if (!hooks || typeof hooks !== 'object') return cfg;

  for (const event of Object.keys(hooks)) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    const kept = [];
    for (const g of groups) {
      const inner = Array.isArray(g?.hooks) ? g.hooks : [];
      const filtered = inner.filter((h: any) => !isWrcHookCommand(h?.command, skillDir));
      // Drop groups left empty after filtering (mirrors attach's own group pruning).
      if (filtered.length > 0) kept.push({ ...g, hooks: filtered });
    }
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }

  if (Object.keys(hooks).length === 0) delete cfg.hooks;
  return cfg;
}

/**
 * Remove `settings.statusLine` only when its command runs THIS skill's status.sh.
 * A statusLine pointing elsewhere (or absent) is left untouched. Idempotent.
 */
export function stripWrcStatusLine(settings: any, skillDir: string): any {
  if (!settings || typeof settings !== 'object') return settings;
  const sl = settings.statusLine;
  const cmd = typeof sl?.command === 'string' ? sl.command : '';
  if (cmd && cmd.includes(join(skillDir, 'status.sh'))) {
    delete settings.statusLine;
  }
  return settings;
}
