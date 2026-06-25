import { logger } from '../logger.js';
export const DEFAULT_TELEGRAM_BASE = 'https://api.telegram.org';
/** Strip the bot token from a Telegram API URL so it is safe to log. */
export function redactUrl(url) {
    return url.replace(/\/bot[^/]+\//, '/bot***/');
}
export class TelegramApi {
    token;
    baseUrl;
    constructor(token, baseUrl = DEFAULT_TELEGRAM_BASE) {
        this.token = token;
        this.baseUrl = baseUrl.replace(/\/+$/, '');
    }
    async request(method, body, timeoutMs = 15_000) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const url = `${this.baseUrl}/bot${this.token}/${method}`;
        // Log the method only — the URL contains the token.
        logger.debug('Telegram API request', { method });
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
            const json = (await res.json());
            if (!json.ok) {
                throw new Error(`Telegram ${method} failed: ${json.error_code ?? '?'} ${json.description ?? ''}`.trim());
            }
            return json.result;
        }
        catch (err) {
            if (err instanceof DOMException && err.name === 'AbortError') {
                throw new Error(`Telegram ${method} timed out after ${timeoutMs}ms`);
            }
            throw err;
        }
        finally {
            clearTimeout(timer);
        }
    }
    /** Confirm the token and return the bot's own user record. */
    getMe() {
        return this.request('getMe', {}, 10_000);
    }
    /** Long-poll for updates. The server holds the connection up to `timeout` seconds. */
    getUpdates(opts) {
        const timeout = opts.timeout ?? 30;
        return this.request('getUpdates', { offset: opts.offset, timeout, allowed_updates: opts.allowed_updates }, (timeout + 10) * 1000);
    }
    sendMessage(chatId, text, opts = {}) {
        return this.request('sendMessage', {
            chat_id: chatId,
            text,
            parse_mode: opts.parse_mode,
            reply_markup: opts.reply_markup,
            disable_web_page_preview: opts.disable_web_page_preview ?? true,
        });
    }
    editMessageText(chatId, messageId, text, opts = {}) {
        return this.request('editMessageText', {
            chat_id: chatId,
            message_id: messageId,
            text,
            parse_mode: opts.parse_mode,
            reply_markup: opts.reply_markup,
            disable_web_page_preview: opts.disable_web_page_preview ?? true,
        });
    }
    sendChatAction(chatId, action = 'typing') {
        return this.request('sendChatAction', { chat_id: chatId, action }, 10_000);
    }
    setMyCommands(commands) {
        return this.request('setMyCommands', { commands }, 10_000);
    }
    answerCallbackQuery(callbackQueryId, text) {
        return this.request('answerCallbackQuery', { callback_query_id: callbackQueryId, text }, 10_000);
    }
}
