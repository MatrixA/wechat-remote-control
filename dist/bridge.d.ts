export interface BridgeData {
    sessionId: string;
    cwd: string;
    attachedAt: string;
}
export declare function readBridge(): BridgeData | null;
export declare function writeBridge(data: BridgeData): void;
/**
 * Find the most recently modified session JSONL in the Claude project directory for a given cwd.
 * Claude encodes the project path by replacing all '/' with '-'.
 * e.g. /mnt/data/playground → -mnt-data-playground
 */
export declare function getLatestSessionId(cwd: string): string | undefined;
