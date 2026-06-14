import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { DATA_DIR, CLAUDE_PROJECTS_DIR, encodeCwd } from './constants.js';
import { logger } from './logger.js';

const BRIDGE_FILE = join(DATA_DIR, 'bridge.json');

export interface BridgeData {
  sessionId: string;
  cwd: string;
  attachedAt: string;
}

export function readBridge(): BridgeData | null {
  try {
    const raw = readFileSync(BRIDGE_FILE, 'utf8');
    const data = JSON.parse(raw) as BridgeData;
    if (!data.sessionId || !data.cwd) return null;
    return data;
  } catch {
    return null;
  }
}

export function writeBridge(data: BridgeData): void {
  try {
    writeFileSync(BRIDGE_FILE, JSON.stringify(data, null, 2));
    logger.debug('Bridge updated', { sessionId: data.sessionId, cwd: data.cwd });
  } catch (err) {
    logger.warn('Failed to write bridge file', { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Find the most recently modified session JSONL in the Claude project directory for a given cwd.
 * Claude encodes the project path by replacing every non-alphanumeric char with '-' (see encodeCwd).
 * e.g. /mnt/data/play.ground → -mnt-data-play-ground
 */
export function getLatestSessionId(cwd: string): string | undefined {
  try {
    const projectDir = join(CLAUDE_PROJECTS_DIR, encodeCwd(cwd));
    const files = readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({
        sessionId: basename(f, '.jsonl'),
        mtime: statSync(join(projectDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);
    return files[0]?.sessionId;
  } catch {
    return undefined;
  }
}
