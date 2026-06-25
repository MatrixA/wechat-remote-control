import type { Transport } from './types.js';
export type TransportName = 'wechat' | 'telegram';
export declare function createTransport(name: TransportName): Promise<Transport>;
/**
 * Decide the active transport. Priority:
 *   1. WCC_TRANSPORT env var
 *   2. --telegram / --wechat argv flag
 *   3. credentials present on disk (telegram account, else wechat account)
 *   4. default 'wechat'
 */
export declare function resolveTransportName(argv?: string[]): TransportName;
