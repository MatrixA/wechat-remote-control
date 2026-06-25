export declare const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export declare const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
export interface AccountData {
    botToken: string;
    accountId: string;
    baseUrl: string;
    userId: string;
    createdAt: string;
    /**
     * Single-user lock. A WeChat bot token grants control of the owner's terminal
     * (every injected message is auto-approved), so — exactly like the Telegram
     * transport's chat lock — the bridge binds to ONE sender: the first
     * from_user_id seen after login is captured here and every other sender is
     * dropped thereafter. Undefined until the first message is captured.
     */
    allowedUserId?: string;
}
/** Persist account credentials to disk. */
export declare function saveAccount(data: AccountData): void;
/** Load account credentials by ID. Returns null if not found. */
export declare function loadAccount(accountId: string): AccountData | null;
/**
 * Authorization decision (pure), mirroring telegram/auth.ts `isChatAllowed`.
 * If no user is bound yet, any sender is allowed (the transport captures+locks
 * the first one). Once bound, only that user is allowed.
 */
export declare function isWeChatUserAllowed(account: AccountData, userId: string): boolean;
/** Load the most recently modified account. Returns null if none exist. */
export declare function loadLatestAccount(): AccountData | null;
