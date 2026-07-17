import type { Transport } from '../transport/types.js';
/** Decode an opaque target into its chat + optional forum-thread parts. */
export declare function decodeTarget(target: string): {
    chatId: string;
    threadId?: number;
};
/** Encode a chat + optional thread into the opaque target shape. */
export declare function encodeTarget(chatId: string, threadId?: number): string;
export declare function createTelegramTransport(): Transport;
