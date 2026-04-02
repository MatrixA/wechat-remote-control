import { decryptAesEcb } from "./crypto.js";
import { logger } from "../logger.js";
import { CDN_BASE_URL } from "./accounts.js";
export function buildCdnDownloadUrl(encryptQueryParam) {
    if (!/^[A-Za-z0-9%=&+._~-]+$/.test(encryptQueryParam)) {
        throw new Error('Invalid CDN query parameter');
    }
    return `${CDN_BASE_URL}?${encryptQueryParam}`;
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
    // Handle both formats:
    // 1. base64-of-raw-16-bytes (16 raw bytes encoded as base64)
    // 2. base64-of-hex-string (32 hex chars encoded as base64)
    let aesKey;
    const raw = Buffer.from(aesKeyBase64, "base64");
    if (raw.length === 16) {
        // base64-of-raw-16-bytes
        aesKey = raw;
    }
    else {
        // base64-of-hex-string: decode the string as hex to get the 16-byte key
        const hexStr = raw.toString("utf-8");
        aesKey = Buffer.from(hexStr, "hex");
    }
    const decrypted = decryptAesEcb(aesKey, encrypted);
    logger.info("CDN download and decrypt succeeded", { size: decrypted.length });
    return decrypted;
}
