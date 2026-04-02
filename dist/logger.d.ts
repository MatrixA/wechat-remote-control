/**
 * Redact sensitive values from a string:
 * - Bearer tokens (Authorization headers)
 * - aes_key values
 * - generic token/secret values in JSON payloads
 */
export declare function redact(obj: unknown): string;
export declare const logger: {
    readonly info: (message: string, data?: unknown) => void;
    readonly warn: (message: string, data?: unknown) => void;
    readonly error: (message: string, data?: unknown) => void;
    readonly debug: (message: string, data?: unknown) => void;
};
