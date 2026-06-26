/**
 * Return a copy of `cfg` with every wrc hook entry removed and all resulting empty
 * containers pruned. Other hooks and settings are preserved. Idempotent.
 */
export declare function stripWrcHooks(cfg: any): any;
/**
 * Remove `settings.statusLine` only when its command runs THIS skill's status.sh.
 * A statusLine pointing elsewhere (or absent) is left untouched. Idempotent.
 */
export declare function stripWrcStatusLine(settings: any, skillDir: string): any;
