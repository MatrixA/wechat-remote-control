/**
 * Source-of-truth MIRROR of the SKILL.md "uninstall" hooks/statusLine remover.
 *
 * `uninstall` reverses what attach Step 4/5 wrote. The canonical implementation
 * is the inline Python heredoc in SKILL.md; this module reproduces the two
 * load-bearing invariants so they can be unit-tested. Keep the two byte-identical
 * in behaviour (same filter, same emptiness pruning, same statusLine guard).
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
import { HOOK_MARK } from './hookcmd.js';

/**
 * Return a copy of `cfg` with every wrc hook entry removed and all resulting empty
 * containers pruned. Other hooks and settings are preserved. Idempotent.
 */
export function stripWrcHooks(cfg: any): any {
  if (!cfg || typeof cfg !== 'object') return cfg;
  const hooks = cfg.hooks;
  if (!hooks || typeof hooks !== 'object') return cfg;

  for (const event of Object.keys(hooks)) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    const kept = [];
    for (const g of groups) {
      const inner = Array.isArray(g?.hooks) ? g.hooks : [];
      const filtered = inner.filter((h: any) => !String(h?.command ?? '').includes(HOOK_MARK));
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
