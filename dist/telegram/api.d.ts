/**
 * Telegram Bot API HTTP client.
 *
 * Mirrors the structure of WeChatApi (built-in fetch + AbortController), with one
 * critical difference: Telegram puts the bot token in the URL path
 * (`/bot<token>/<method>`). We therefore NEVER log the full URL — only the method
 * name — and expose redactUrl() for any defensive logging elsewhere.
 *
 * Rate limits: a 429 response carries parameters.retry_after (seconds). We sleep
 * and retry once (bounded) — enough to absorb the occasional edit-heavy burst
 * from live turn-status updates without turning the client into a retry loop.
 */
import type { TgUser, TgUpdate, TgMessage, TgChat, TgInlineKeyboardMarkup, TgBotCommand, TgForumTopic } from './types.js';
export declare const DEFAULT_TELEGRAM_BASE = "https://api.telegram.org";
/** Strip the bot token from a Telegram API URL so it is safe to log. */
export declare function redactUrl(url: string): string;
export interface SendMessageOpts {
    parse_mode?: 'HTML' | 'MarkdownV2';
    reply_markup?: TgInlineKeyboardMarkup;
    disable_web_page_preview?: boolean;
    /** Forum-topic thread to post into. */
    message_thread_id?: number;
}
export declare class TelegramApi {
    private readonly token;
    private readonly baseUrl;
    constructor(token: string, baseUrl?: string);
    private url;
    private request;
    /** Confirm the token and return the bot's own user record. */
    getMe(): Promise<TgUser>;
    /** Long-poll for updates. The server holds the connection up to `timeout` seconds. */
    getUpdates(opts: {
        offset?: number;
        timeout?: number;
        allowed_updates?: string[];
    }): Promise<TgUpdate[]>;
    getChat(chatId: string): Promise<TgChat>;
    sendMessage(chatId: string, text: string, opts?: SendMessageOpts): Promise<TgMessage>;
    editMessageText(chatId: string, messageId: number, text: string, opts?: SendMessageOpts): Promise<unknown>;
    sendChatAction(chatId: string, action?: string, threadId?: number): Promise<unknown>;
    setMyCommands(commands: TgBotCommand[]): Promise<unknown>;
    answerCallbackQuery(callbackQueryId: string, text?: string): Promise<unknown>;
    /**
     * React to a message with a single emoji (replaces the bot's prior reaction).
     * Only emoji from Telegram's fixed allowed set work — callers pick from it.
     */
    setMessageReaction(chatId: string, messageId: number, emoji?: string): Promise<unknown>;
    createForumTopic(chatId: string, name: string): Promise<TgForumTopic>;
    editForumTopic(chatId: string, threadId: number, name: string): Promise<unknown>;
    closeForumTopic(chatId: string, threadId: number): Promise<unknown>;
    reopenForumTopic(chatId: string, threadId: number): Promise<unknown>;
    /** Deletes the topic AND its message history — the thread id is dead afterwards. */
    deleteForumTopic(chatId: string, threadId: number): Promise<unknown>;
    /**
     * Upload a document (multipart/form-data — the one non-JSON request). Used
     * for very long responses that would otherwise arrive as many chunks.
     */
    sendDocument(chatId: string, filename: string, content: string, opts?: {
        caption?: string;
        message_thread_id?: number;
    }): Promise<TgMessage>;
}
