import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { MessageItem, ImageItem, VoiceItem, FileItem, VideoItem, DownloadedMedia, VoiceResult } from './types.js';
import { MessageItemType } from './types.js';
import { downloadAndDecrypt } from './cdn.js';
import { logger } from '../logger.js';
import { DATA_DIR } from '../constants.js';

// ── Media temp directory ────────────────────────────────────────────────────

const MEDIA_DIR = join(DATA_DIR, 'media');

function ensureMediaDir(): void {
  mkdirSync(MEDIA_DIR, { recursive: true });
}

function tempFilePath(prefix: string, ext: string): string {
  const rand = randomBytes(4).toString('hex');
  return join(MEDIA_DIR, `${prefix}-${Date.now()}-${rand}${ext}`);
}

// ── MIME detection ──────────────────────────────────────────────────────────

function detectMimeType(data: Buffer): string {
  if (data[0] === 0x89 && data[1] === 0x50) return 'image/png';
  if (data[0] === 0xFF && data[1] === 0xD8) return 'image/jpeg';
  if (data[0] === 0x47 && data[1] === 0x49) return 'image/gif';
  if (data[0] === 0x52 && data[1] === 0x49) return 'image/webp';
  if (data[0] === 0x42 && data[1] === 0x4D) return 'image/bmp';
  // Video signatures
  if (data.length >= 8) {
    const ftypOffset = data.indexOf(Buffer.from('ftyp'));
    if (ftypOffset >= 0 && ftypOffset <= 8) return 'video/mp4';
  }
  if (data[0] === 0x1A && data[1] === 0x45 && data[2] === 0xDF && data[3] === 0xA3) return 'video/webm';
  // PDF
  if (data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46) return 'application/pdf';
  // ZIP
  if (data[0] === 0x50 && data[1] === 0x4B) return 'application/zip';
  return 'application/octet-stream';
}

function mimeToExt(mime: string): string {
  const map: Record<string, string> = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif',
    'image/webp': '.webp', 'image/bmp': '.bmp',
    'video/mp4': '.mp4', 'video/webm': '.webm',
    'audio/wav': '.wav', 'audio/silk': '.silk',
    'application/pdf': '.pdf', 'application/zip': '.zip',
  };
  return map[mime] ?? '.bin';
}

// ── CDN data extraction (supports both old cdn_media and new flat formats) ──

interface CdnData {
  aesKey: string;
  encryptQueryParam: string;
}

function getImageCdnData(imageItem: ImageItem): CdnData | null {
  if (imageItem.cdn_media?.aes_key && imageItem.cdn_media?.encrypt_query_param) {
    return { aesKey: imageItem.cdn_media.aes_key, encryptQueryParam: imageItem.cdn_media.encrypt_query_param };
  }
  if (imageItem.aeskey && imageItem.media?.encrypt_query_param) {
    return { aesKey: imageItem.aeskey, encryptQueryParam: imageItem.media.encrypt_query_param };
  }
  logger.warn('Image item has no usable CDN data');
  return null;
}

function getVoiceCdnData(voiceItem: VoiceItem): CdnData | null {
  if (voiceItem.cdn_media?.aes_key && voiceItem.cdn_media?.encrypt_query_param) {
    return { aesKey: voiceItem.cdn_media.aes_key, encryptQueryParam: voiceItem.cdn_media.encrypt_query_param };
  }
  if (voiceItem.aeskey && voiceItem.media?.encrypt_query_param) {
    return { aesKey: voiceItem.aeskey, encryptQueryParam: voiceItem.media.encrypt_query_param };
  }
  logger.warn('Voice item has no usable CDN data');
  return null;
}

function getFileCdnData(fileItem: FileItem): CdnData | null {
  if (fileItem.cdn_media?.aes_key && fileItem.cdn_media?.encrypt_query_param) {
    return { aesKey: fileItem.cdn_media.aes_key, encryptQueryParam: fileItem.cdn_media.encrypt_query_param };
  }
  if (fileItem.aeskey && fileItem.media?.encrypt_query_param) {
    return { aesKey: fileItem.aeskey, encryptQueryParam: fileItem.media.encrypt_query_param };
  }
  logger.warn('File item has no usable CDN data');
  return null;
}

function getVideoCdnData(videoItem: VideoItem): CdnData | null {
  if (videoItem.cdn_media?.aes_key && videoItem.cdn_media?.encrypt_query_param) {
    return { aesKey: videoItem.cdn_media.aes_key, encryptQueryParam: videoItem.cdn_media.encrypt_query_param };
  }
  if (videoItem.aeskey && videoItem.media?.encrypt_query_param) {
    return { aesKey: videoItem.aeskey, encryptQueryParam: videoItem.media.encrypt_query_param };
  }
  logger.warn('Video item has no usable CDN data');
  return null;
}

// ── Download functions ──────────────────────────────────────────────────────

/**
 * Download a CDN image, decrypt it, and return a base64 data URI.
 */
export async function downloadImage(item: MessageItem): Promise<string | null> {
  const imageItem = item.image_item;
  if (!imageItem) return null;

  const cdnData = getImageCdnData(imageItem);
  if (!cdnData) return null;

  try {
    const decrypted = await downloadAndDecrypt(cdnData.encryptQueryParam, cdnData.aesKey);
    const mimeType = detectMimeType(decrypted);
    const base64 = decrypted.toString('base64');
    logger.info('Image downloaded and decrypted', { size: decrypted.length, mimeType });
    return `data:${mimeType};base64,${base64}`;
  } catch (err) {
    logger.warn('Failed to download image', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * Download a CDN image to a temp file and return a DownloadedMedia descriptor.
 */
export async function downloadImageToFile(item: MessageItem): Promise<DownloadedMedia | null> {
  const imageItem = item.image_item;
  if (!imageItem) return null;

  const cdnData = getImageCdnData(imageItem);
  if (!cdnData) return null;

  try {
    const decrypted = await downloadAndDecrypt(cdnData.encryptQueryParam, cdnData.aesKey);
    const mimeType = detectMimeType(decrypted);
    const ext = mimeToExt(mimeType);
    ensureMediaDir();
    const filePath = tempFilePath('img', ext);
    writeFileSync(filePath, decrypted);
    logger.info('Image saved to file', { filePath, size: decrypted.length });
    return { type: 'image', filePath, mimeType };
  } catch (err) {
    logger.warn('Failed to download image to file', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * Process a voice message item.
 * If WeChat ASR text is available, returns { text }.
 * Otherwise downloads the audio and returns { media }.
 */
export async function downloadVoice(item: MessageItem): Promise<VoiceResult | null> {
  const voiceItem = item.voice_item;
  if (!voiceItem) return null;

  // Check for WeChat ASR transcription
  const voiceText = voiceItem.text ?? voiceItem.voice_text;
  if (voiceText) {
    logger.info('Voice message has ASR text', { textLength: voiceText.length });
    return { text: voiceText };
  }

  // No ASR text — download the audio file
  const cdnData = getVoiceCdnData(voiceItem);
  if (!cdnData) return null;

  try {
    const decrypted = await downloadAndDecrypt(cdnData.encryptQueryParam, cdnData.aesKey);
    ensureMediaDir();
    // WeChat voice is typically SILK format
    const filePath = tempFilePath('voice', '.silk');
    writeFileSync(filePath, decrypted);
    logger.info('Voice audio saved', { filePath, size: decrypted.length });
    return { media: { type: 'audio', filePath, mimeType: 'audio/silk' } };
  } catch (err) {
    logger.warn('Failed to download voice', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * Download a file attachment from CDN and save to temp.
 */
export async function downloadFile(item: MessageItem): Promise<DownloadedMedia | null> {
  const fileItem = item.file_item;
  if (!fileItem) return null;

  const cdnData = getFileCdnData(fileItem);
  if (!cdnData) return null;

  try {
    const decrypted = await downloadAndDecrypt(cdnData.encryptQueryParam, cdnData.aesKey);
    const fileName = fileItem.file_name || 'attachment';
    // Use original extension from filename if available
    const ext = fileName.includes('.') ? '.' + fileName.split('.').pop()! : '.bin';
    ensureMediaDir();
    const filePath = tempFilePath('file', ext);
    writeFileSync(filePath, decrypted);
    logger.info('File saved', { filePath, fileName, size: decrypted.length });
    return { type: 'file', filePath, mimeType: detectMimeType(decrypted), fileName };
  } catch (err) {
    logger.warn('Failed to download file', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * Download a video from CDN and save to temp.
 */
export async function downloadVideo(item: MessageItem): Promise<DownloadedMedia | null> {
  const videoItem = item.video_item;
  if (!videoItem) return null;

  const cdnData = getVideoCdnData(videoItem);
  if (!cdnData) return null;

  try {
    const decrypted = await downloadAndDecrypt(cdnData.encryptQueryParam, cdnData.aesKey);
    const mimeType = detectMimeType(decrypted);
    const ext = mimeToExt(mimeType);
    ensureMediaDir();
    const filePath = tempFilePath('video', ext !== '.bin' ? ext : '.mp4');
    writeFileSync(filePath, decrypted);
    logger.info('Video saved', { filePath, size: decrypted.length });
    return { type: 'video', filePath, mimeType: mimeType.startsWith('video/') ? mimeType : 'video/mp4' };
  } catch (err) {
    logger.warn('Failed to download video', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

// ── Item extractors ─────────────────────────────────────────────────────────

/**
 * Extract text content from a message item.
 */
export function extractText(item: MessageItem): string {
  return item.text_item?.text ?? '';
}

/**
 * Find the first IMAGE type item in a list.
 */
export function extractFirstImageUrl(items?: MessageItem[]): MessageItem | undefined {
  return items?.find((item) => item.type === MessageItemType.IMAGE);
}

/**
 * Find the first VOICE type item in a list.
 */
export function extractFirstVoice(items?: MessageItem[]): MessageItem | undefined {
  return items?.find((item) => item.type === MessageItemType.VOICE);
}

/**
 * Find the first FILE type item in a list.
 */
export function extractFirstFile(items?: MessageItem[]): MessageItem | undefined {
  return items?.find((item) => item.type === MessageItemType.FILE);
}

/**
 * Find the first VIDEO type item in a list.
 */
export function extractFirstVideo(items?: MessageItem[]): MessageItem | undefined {
  return items?.find((item) => item.type === MessageItemType.VIDEO);
}
