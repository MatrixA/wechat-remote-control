export declare function buildCdnDownloadUrl(encryptQueryParam: string): string;
export declare function downloadAndDecrypt(encryptQueryParam: string, aesKeyBase64: string): Promise<Buffer>;
