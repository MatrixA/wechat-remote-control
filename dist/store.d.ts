/**
 * Load a JSON file, returning a typed object or the fallback if the file
 * does not exist or cannot be parsed.
 */
export declare function loadJson<T>(filePath: string, fallback: T): T;
/**
 * Persist an object as pretty-printed JSON.
 * File is written with mode 0o600 (owner read/write only).
 */
export declare function saveJson(filePath: string, data: unknown): void;
