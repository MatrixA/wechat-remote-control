export interface VerifyResult {
    username?: string;
}
/** Confirm the token with getMe and persist it (preserving any prior chat lock). */
export declare function verifyToken(token: string): Promise<VerifyResult>;
export interface CaptureResult {
    chatId: string;
    username?: string;
}
/**
 * Poll getUpdates until the user messages the bot, then lock that chat.
 * Throws after timeoutMs if no message arrives.
 */
export declare function captureAuthorizedChat(token: string, opts?: {
    timeoutMs?: number;
}): Promise<CaptureResult>;
