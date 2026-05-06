export declare function generateAesKey(): string;
/** Compute AES-128-ECB ciphertext size with PKCS7 padding (always adds at least 1 byte). */
export declare function aesEcbPaddedSize(size: number): number;
export declare function encryptAesEcb(key: Buffer, plaintext: Buffer): Buffer;
export declare function decryptAesEcb(key: Buffer, ciphertext: Buffer): Buffer;
