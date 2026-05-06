import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { DATA_DIR } from './constants.js';
import { logger } from './logger.js';
const BRIDGE_FILE = join(DATA_DIR, 'bridge.json');
export function readBridge() {
    try {
        const raw = readFileSync(BRIDGE_FILE, 'utf8');
        const data = JSON.parse(raw);
        if (!data.sessionId || !data.cwd)
            return null;
        return data;
    }
    catch {
        return null;
    }
}
export function writeBridge(data) {
    try {
        writeFileSync(BRIDGE_FILE, JSON.stringify(data, null, 2));
        logger.debug('Bridge updated', { sessionId: data.sessionId, cwd: data.cwd });
    }
    catch (err) {
        logger.warn('Failed to write bridge file', { error: err instanceof Error ? err.message : String(err) });
    }
}
/**
 * Find the most recently modified session JSONL in the Claude project directory for a given cwd.
 * Claude encodes the project path by replacing all '/' with '-'.
 * e.g. /mnt/data/playground → -mnt-data-playground
 */
export function getLatestSessionId(cwd) {
    try {
        const encoded = cwd.replace(/\//g, '-');
        const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
        const projectDir = join(claudeDir, 'projects', encoded);
        const files = readdirSync(projectDir)
            .filter(f => f.endsWith('.jsonl'))
            .map(f => ({
            sessionId: basename(f, '.jsonl'),
            mtime: statSync(join(projectDir, f)).mtimeMs,
        }))
            .sort((a, b) => b.mtime - a.mtime);
        return files[0]?.sessionId;
    }
    catch {
        return undefined;
    }
}
