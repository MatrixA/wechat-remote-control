/** Encode `text` into a QR module matrix. `true` = dark module. */
export declare function encodeQrMatrix(text: string): boolean[][];
/**
 * Render a QR matrix as a terminal string using Unicode half-block characters,
 * mirroring `qrcode`'s `type:'utf8'` output (each text row packs two module
 * rows). A dark module renders as the terminal foreground; light as background.
 */
export declare function renderTerminalQr(text: string, opts?: {
    margin?: number;
}): string;
