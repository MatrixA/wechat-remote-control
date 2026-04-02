export declare const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export declare const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
export interface AccountData {
    botToken: string;
    accountId: string;
    baseUrl: string;
    userId: string;
    createdAt: string;
}
/** Persist account credentials to disk. */
export declare function saveAccount(data: AccountData): void;
/** Load account credentials by ID. Returns null if not found. */
export declare function loadAccount(accountId: string): AccountData | null;
/** Load the most recently modified account. Returns null if none exist. */
export declare function loadLatestAccount(): AccountData | null;
