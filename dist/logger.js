import { mkdirSync, appendFileSync, readdirSync, unlinkSync, statSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
const LOG_DIR = join(homedir(), ".wechat-remote-control", "logs");
const MAX_LOG_FILES = 30; // Keep at most N distinct days of logs (incl. rotations)
const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB per file → rotate to .1, .2, ...
const MAX_ROTATIONS = 5; // Keep current + .1 .. .N per day
// DEBUG is the dominant log volume (every API request/response). Make it opt-in
// so a runaway loop or noisy debug never blows up disk by default.
const DEBUG_ENABLED = process.env.WRC_DEBUG === "1" || process.env.WRC_DEBUG === "true";
const FILE_RE = /^bridge-(\d{4}-\d{2}-\d{2})\.log(\.\d+)?$/;
/** Drop log files for dates beyond the most-recent MAX_LOG_FILES distinct days. */
function cleanupOldLogs() {
    try {
        const files = readdirSync(LOG_DIR).filter((f) => FILE_RE.test(f));
        const dates = Array.from(new Set(files.map((f) => f.match(FILE_RE)[1]))).sort();
        const keep = new Set(dates.slice(-MAX_LOG_FILES));
        for (const f of files) {
            const d = f.match(FILE_RE)[1];
            if (!keep.has(d)) {
                try {
                    unlinkSync(join(LOG_DIR, f));
                }
                catch { }
            }
        }
    }
    catch {
        // Ignore errors during cleanup
    }
}
/** If the active log file exceeds MAX_FILE_BYTES, rotate file → .1, .1 → .2, ... */
function rotateIfNeeded(filePath) {
    let size = 0;
    try {
        size = statSync(filePath).size;
    }
    catch {
        return;
    }
    if (size < MAX_FILE_BYTES)
        return;
    // Shift existing rotations outward; the oldest (.MAX_ROTATIONS) is dropped on
    // overwrite by the next rename.
    for (let i = MAX_ROTATIONS - 1; i >= 1; i--) {
        try {
            renameSync(`${filePath}.${i}`, `${filePath}.${i + 1}`);
        }
        catch { }
    }
    try {
        renameSync(filePath, `${filePath}.1`);
    }
    catch { }
}
/**
 * Redact sensitive values from a string:
 * - Bearer tokens (Authorization headers)
 * - aes_key values
 * - generic token/secret values in JSON payloads
 */
export function redact(obj) {
    const raw = typeof obj === "string" ? obj : JSON.stringify(obj);
    if (!raw)
        return raw;
    let safe = raw;
    // Mask Bearer tokens: "Bearer <anything>"
    safe = safe.replace(/Bearer\s+[^\s"\\]+/gi, "Bearer ***");
    // Mask generic token/secret/password/api_key values in JSON
    safe = safe.replace(/"(?:(?:[\w]+_)?token|secret|password|api_key)"\s*:\s*"[^"]*"/gi, (match) => {
        const key = match.match(/"[^"]*"/)?.[0] ?? '""';
        return `${key}: "***"`;
    });
    return safe;
}
function ensureLogDir() {
    mkdirSync(LOG_DIR, { recursive: true });
    cleanupOldLogs();
}
function getLogFilePath() {
    const now = new Date();
    const date = now.toISOString().slice(0, 10); // YYYY-MM-DD
    return join(LOG_DIR, `bridge-${date}.log`);
}
function writeLogLine(level, message, data) {
    ensureLogDir();
    const path = getLogFilePath();
    rotateIfNeeded(path);
    const timestamp = new Date().toISOString();
    const parts = [timestamp, level, message];
    if (data !== undefined) {
        parts.push(redact(data));
    }
    const line = parts.join(" ") + "\n";
    appendFileSync(path, line, "utf-8");
}
export const logger = {
    info(message, data) {
        writeLogLine("INFO", message, data);
    },
    warn(message, data) {
        writeLogLine("WARN", message, data);
    },
    error(message, data) {
        writeLogLine("ERROR", message, data);
    },
    debug(message, data) {
        if (!DEBUG_ENABLED)
            return;
        writeLogLine("DEBUG", message, data);
    },
};
