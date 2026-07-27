/**
 * Return a copy of `cfg` with every wrc hook entry removed and all resulting empty
 * containers pruned. Other hooks and settings are preserved. Idempotent.
 *
 * Pass `skillDir` so entries installed from a directory not named `wechat-remote-control`
 * are recognised too — without it they survive an uninstall that reports success.
 */
export declare function stripWrcHooks(cfg: any, skillDir?: string): any;
/**
 * Remove `settings.statusLine` only when its command runs THIS skill's status.sh.
 * A statusLine pointing elsewhere (or absent) is left untouched. Idempotent.
 */
export declare function stripWrcStatusLine(settings: any, skillDir: string): any;
