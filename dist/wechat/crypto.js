import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
export function generateAesKey() {
    return randomBytes(16).toString("base64");
}
export function aesEcbPaddedSize(size) {
    const block = 16;
    return Math.floor((size + block - 1) / block) * block;
}
export function encryptAesEcb(key, plaintext) {
    const cipher = createCipheriv("aes-128-ecb", key, null);
    return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}
export function decryptAesEcb(key, ciphertext) {
    const decipher = createDecipheriv("aes-128-ecb", key, null);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
