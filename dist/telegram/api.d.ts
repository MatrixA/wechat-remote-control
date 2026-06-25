/**
 * Telegram Bot API HTTP client.
 *
 * Mirrors the structure of WeChatApi (built-in fetch + AbortController), with one
 * critical difference: Telegram puts the bot token in the URL path
 * (`/bot<token>/<method>`). We therefore NEVER log the full URL — only the method
 * name — and expose redactUrl() for any defensive logging elsewhere.
 */
import type { TgUser, TgUpdate, TgMessage, TgInlineKeyboardMarkup, TgBotCommand } from './types.js';
export declare const DEFAULT_TELEGRAM_BASE = "https://api.telegram.org";
/** Strip the bot token from a Telegram API URL so it is safe to log. */
export declare function redactUrl(url: string): string;
export interface SendMessageOpts {
    parse_mode?: 'HTML' | 'MarkdownV2';
    reply_markup?: TgInlineKeyboardMarkup;
    disable_web_page_preview?: boolean;
}
export declare class TelegramApi {
    private readonly token;
    private readonly baseUrl;
    constructor(token: string, baseUrl?: string);
    private request;
    /** Confirm the token and return the bot's own user record. */
    getMe(): Promise<TgUser>;
    /** Long-poll for updates. The server holds the connection up to `timeout` seconds. */
    getUpdates(opts: {
        offset?: number;
        timeout?: number;
        allowed_updates?: string[];
    }): Promise<TgUpdate[]>;
    sendMessage(chatId: string, text: string, opts?: SendMessageOpts): Promise<TgMessage>;
    editMessageText(chatId: string, messageId: number, text: string, opts?: SendMessageOpts): Promise<unknown>;
    sendChatAction(chatId: string, action?: string): Promise<unknown>;
    setMyCommands(commands: TgBotCommand[]): Promise<unknown>;
    answerCallbackQuery(callbackQueryId: string, text?: string): Promise<unknown>;
}
