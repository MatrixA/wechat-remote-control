import { randomBytes, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { decryptAesEcb, encryptAesEcb, aesEcbPaddedSize } from './crypto.js';
import { logger } from '../logger.js';
import { CDN_BASE_URL } from './accounts.js';
// ── Download ────────────────────────────────────────────────────────────────
export function buildCdnDownloadUrl(encryptQueryParam) {
    return `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`;
}
/**
 * Parse AES key from base64, handling both raw-16-byte and hex-string-32-char formats.
 */
export function parseAesKey(aesKeyBase64) {
    const raw = Buffer.from(aesKeyBase64, 'base64');
    if (raw.length === 16)
        return raw;
    // base64-of-hex-string: 32 hex chars → 16 bytes
    const hexStr = raw.toString('utf-8');
    if (/^[0-9a-fA-F]{32}$/.test(hexStr)) {
        return Buffer.from(hexStr, 'hex');
    }
    throw new Error(`Invalid AES key: expected 16 raw bytes or 32-char hex, got ${raw.length} bytes`);
}
export async function downloadAndDecrypt(encryptQueryParam, aesKeyBase64) {
    const url = buildCdnDownloadUrl(encryptQueryParam);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    let response;
    try {
        response = await fetch(url, { signal: controller.signal });
    }
    catch (err) {
        clearTimeout(timer);
        throw new Error(`CDN download failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    clearTimeout(timer);
    if (!response.ok) {
        throw new Error(`CDN download failed: ${response.status} ${response.statusText}`);
    }
    const encrypted = Buffer.from(await response.arrayBuffer());
    const aesKey = parseAesKey(aesKeyBase64);
    const decrypted = decryptAesEcb(aesKey, encrypted);
    logger.info('CDN download and decrypt succeeded', { size: decrypted.length });
    return decrypted;
}
// ── Upload ──────────────────────────────────────────────────────────────────
const UPLOAD_MAX_RETRIES = 3;
function buildCdnUploadUrl(uploadParam, filekey) {
    return `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}
/**
 * Encrypt a buffer and upload it to the WeChat CDN.
 * Returns the download encrypted_query_param from the CDN response.
 * Retries up to 3 times on server errors; 4xx errors abort immediately.
 */
async function uploadBufferToCdn(plaintext, uploadParam, uploadFullUrl, filekey, aeskey) {
    const ciphertext = encryptAesEcb(aeskey, plaintext);
    const trimmedFull = uploadFullUrl?.trim();
    let cdnUrl;
    if (trimmedFull) {
        cdnUrl = trimmedFull;
    }
    else if (uploadParam) {
        cdnUrl = buildCdnUploadUrl(uploadParam, filekey);
    }
    else {
        throw new Error('CDN upload URL missing (need upload_full_url or upload_param)');
    }
    logger.debug('CDN upload', { cdnUrl: cdnUrl.slice(0, 80), ciphertextSize: ciphertext.length });
    let downloadParam;
    let lastError;
    for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
        try {
            const res = await fetch(cdnUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/octet-stream' },
                body: new Uint8Array(ciphertext),
            });
            if (res.status >= 400 && res.status < 500) {
                const errMsg = res.headers.get('x-error-message') ?? await res.text();
                throw new Error(`CDN upload client error ${res.status}: ${errMsg}`);
            }
            if (res.status !== 200) {
                const errMsg = res.headers.get('x-error-message') ?? `status ${res.status}`;
                throw new Error(`CDN upload server error: ${errMsg}`);
            }
            downloadParam = res.headers.get('x-encrypted-param') ?? undefined;
            if (!downloadParam) {
                throw new Error('CDN upload response missing x-encrypted-param header');
            }
            logger.info('CDN upload succeeded', { attempt });
            break;
        }
        catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
            // Client errors (4xx) don't get retried
            if (lastError.message.includes('client error'))
                throw lastError;
            if (attempt < UPLOAD_MAX_RETRIES) {
                logger.warn('CDN upload attempt failed, retrying', { attempt, error: lastError.message });
            }
        }
    }
    if (!downloadParam) {
        throw lastError ?? new Error(`CDN upload failed after ${UPLOAD_MAX_RETRIES} attempts`);
    }
    return downloadParam;
}
/**
 * Full upload pipeline: read file → hash → gen AES key → getUploadUrl → CDN upload.
 * Returns the info needed to construct a send message.
 */
export async function uploadMediaToCdn(api, filePath, toUserId, mediaType) {
    const plaintext = readFileSync(filePath);
    const rawsize = plaintext.length;
    const rawfilemd5 = createHash('md5').update(plaintext).digest('hex');
    const filesize = aesEcbPaddedSize(rawsize);
    const filekey = randomBytes(16).toString('hex');
    const aeskey = randomBytes(16);
    logger.info('Upload pipeline start', { filePath, rawsize, filesize, mediaType });
    const uploadResp = await api.getUploadUrl({
        filekey,
        media_type: mediaType,
        to_user_id: toUserId,
        rawsize,
        rawfilemd5,
        filesize,
        no_need_thumb: true,
        aeskey: aeskey.toString('hex'),
    });
    const uploadFullUrl = uploadResp.upload_full_url?.trim();
    const uploadParam = uploadResp.upload_param;
    if (!uploadFullUrl && !uploadParam) {
        throw new Error('getUploadUrl returned no upload URL');
    }
    const downloadEncryptedQueryParam = await uploadBufferToCdn(plaintext, uploadParam, uploadFullUrl, filekey, aeskey);
    return {
        filekey,
        downloadEncryptedQueryParam,
        aeskey: aeskey.toString('hex'),
        fileSize: rawsize,
        fileSizeCiphertext: filesize,
    };
}
