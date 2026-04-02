import type { AccountData } from './accounts.js';
/** Phase 1: Request a QR code for login. Returns the URL and ID. */
export declare function startQrLogin(): Promise<{
    qrcodeUrl: string;
    qrcodeId: string;
}>;
/**
 * Phase 2: Wait for the user to scan and confirm the QR code.
 * Throws on expiry so the caller can regenerate the QR image.
 * Returns the full AccountData on success.
 */
export declare function waitForQrScan(qrcodeId: string): Promise<AccountData>;
