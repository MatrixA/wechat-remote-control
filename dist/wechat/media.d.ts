import type { MessageItem } from './types.js';
/**
 * Download a CDN image, decrypt it, and return a base64 data URI.
 * Returns null on failure.
 */
export declare function downloadImage(item: MessageItem): Promise<string | null>;
/**
 * Extract text content from a message item.
 * Returns text_item.text or empty string.
 */
export declare function extractText(item: MessageItem): string;
/**
 * Find the first IMAGE type item in a list.
 */
export declare function extractFirstImageUrl(items?: MessageItem[]): MessageItem | undefined;
