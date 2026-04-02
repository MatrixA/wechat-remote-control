export declare function generateAesKey(): string;
export declare function aesEcbPaddedSize(size: number): number;
export declare function encryptAesEcb(key: Buffer, plaintext: Buffer): Buffer;
export declare function decryptAesEcb(key: Buffer, ciphertext: Buffer): Buffer;
