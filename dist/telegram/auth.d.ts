export declare const TELEGRAM_DIR: string;
export declare const TELEGRAM_ACCOUNT_PATH: string;
export interface TelegramAccount {
    botToken: string;
    botUsername?: string;
    allowedChatId?: string;
    allowedUsername?: string;
    /** Bound topics supergroup (set by /bind in a forum-enabled group). */
    groupChatId?: string;
    groupTitle?: string;
    createdAt: string;
}
export declare function loadTelegramAccount(): TelegramAccount | null;
export declare function saveTelegramAccount(account: TelegramAccount): void;
/** Persist (or update) the authorized chat once it is known. */
export declare function saveAllowedChat(chatId: string, username?: string): TelegramAccount | null;
/** Persist the bound topics group. */
export declare function saveBoundGroup(chatId: string, title?: string): TelegramAccount | null;
/**
 * Authorization decision (pure). If no chat is bound yet, any chat is allowed
 * (the monitor will capture+lock it). Once bound: the locked private chat, the
 * bound topics group, and — from any chat — the owner themself (their user id
 * equals the locked private chat id) are allowed. The owner exception is what
 * lets a /bind reach the bridge from a not-yet-bound group.
 */
export declare function isChatAllowed(account: TelegramAccount, chatId: string, fromUserId?: string): boolean;
export declare function loadOffset(): number;
export declare function saveOffset(offset: number): void;
