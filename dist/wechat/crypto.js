import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
export function generateAesKey() {
    return randomBytes(16).toString("base64");
}
/** Compute AES-128-ECB ciphertext size with PKCS7 padding (always adds at least 1 byte). */
export function aesEcbPaddedSize(size) {
    return Math.ceil((size + 1) / 16) * 16;
}
export function encryptAesEcb(key, plaintext) {
    const cipher = createCipheriv("aes-128-ecb", key, null);
    return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}
export function decryptAesEcb(key, ciphertext) {
    const decipher = createDecipheriv("aes-128-ecb", key, null);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
