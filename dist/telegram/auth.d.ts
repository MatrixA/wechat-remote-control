export declare const TELEGRAM_DIR: string;
export declare const TELEGRAM_ACCOUNT_PATH: string;
export interface TelegramAccount {
    botToken: string;
    botUsername?: string;
    allowedChatId?: string;
    allowedUsername?: string;
    createdAt: string;
}
export declare function loadTelegramAccount(): TelegramAccount | null;
export declare function saveTelegramAccount(account: TelegramAccount): void;
/** Persist (or update) the authorized chat once it is known. */
export declare function saveAllowedChat(chatId: string, username?: string): TelegramAccount | null;
/**
 * Authorization decision (pure). If no chat is bound yet, any chat is allowed
 * (the monitor will capture+lock it). Once bound, only that chat is allowed.
 */
export declare function isChatAllowed(account: TelegramAccount, chatId: string): boolean;
export declare function loadOffset(): number;
export declare function saveOffset(offset: number): void;
