import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

export function generateAesKey(): string {
  return randomBytes(16).toString("base64");
}

/** Compute AES-128-ECB ciphertext size with PKCS7 padding (always adds at least 1 byte). */
export function aesEcbPaddedSize(size: number): number {
  return Math.ceil((size + 1) / 16) * 16;
}

export function encryptAesEcb(key: Buffer, plaintext: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export function decryptAesEcb(key: Buffer, ciphertext: Buffer): Buffer {
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
