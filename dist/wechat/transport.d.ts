import type { WeixinMessage } from './types.js';
import type { Transport, InboundMessage } from '../transport/types.js';
/** Encode the WeChat reply couple into one opaque target string. */
export declare function encodeTarget(userId: string, contextToken: string): string;
/**
 * Map a raw WeChat message onto the normalised inbound shape, preserving the
 * original media-handling semantics (image/voice-without-ASR → a notice; file /
 * video → a text marker; voice ASR text → injectable text). Returns null when
 * there is nothing to act on.
 */
export declare function normalizeWeixinMessage(msg: WeixinMessage): InboundMessage | null;
export declare function createWeChatTransport(): Transport;
