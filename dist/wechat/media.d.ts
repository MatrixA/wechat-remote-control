import type { MessageItem, DownloadedMedia, VoiceResult } from './types.js';
/**
 * Download a CDN image, decrypt it, and return a base64 data URI.
 */
export declare function downloadImage(item: MessageItem): Promise<string | null>;
/**
 * Download a CDN image to a temp file and return a DownloadedMedia descriptor.
 */
export declare function downloadImageToFile(item: MessageItem): Promise<DownloadedMedia | null>;
/**
 * Process a voice message item.
 * If WeChat ASR text is available, returns { text }.
 * Otherwise downloads the audio and returns { media }.
 */
export declare function downloadVoice(item: MessageItem): Promise<VoiceResult | null>;
/**
 * Download a file attachment from CDN and save to temp.
 */
export declare function downloadFile(item: MessageItem): Promise<DownloadedMedia | null>;
/**
 * Download a video from CDN and save to temp.
 */
export declare function downloadVideo(item: MessageItem): Promise<DownloadedMedia | null>;
/**
 * Extract text content from a message item.
 */
export declare function extractText(item: MessageItem): string;
/**
 * Find the first IMAGE type item in a list.
 */
export declare function extractFirstImageUrl(items?: MessageItem[]): MessageItem | undefined;
/**
 * Find the first VOICE type item in a list.
 */
export declare function extractFirstVoice(items?: MessageItem[]): MessageItem | undefined;
/**
 * Find the first FILE type item in a list.
 */
export declare function extractFirstFile(items?: MessageItem[]): MessageItem | undefined;
/**
 * Find the first VIDEO type item in a list.
 */
export declare function extractFirstVideo(items?: MessageItem[]): MessageItem | undefined;
