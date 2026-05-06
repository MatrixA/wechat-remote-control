import type { WeChatApi } from './api.js';
import type { UploadedMedia } from './types.js';
import { UploadMediaType } from './types.js';
export declare function buildCdnDownloadUrl(encryptQueryParam: string): string;
/**
 * Parse AES key from base64, handling both raw-16-byte and hex-string-32-char formats.
 */
export declare function parseAesKey(aesKeyBase64: string): Buffer;
export declare function downloadAndDecrypt(encryptQueryParam: string, aesKeyBase64: string): Promise<Buffer>;
/**
 * Full upload pipeline: read file → hash → gen AES key → getUploadUrl → CDN upload.
 * Returns the info needed to construct a send message.
 */
export declare function uploadMediaToCdn(api: WeChatApi, filePath: string, toUserId: string, mediaType: UploadMediaType): Promise<UploadedMedia>;
