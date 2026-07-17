import { logger } from '../logger.js';
export const DEFAULT_TELEGRAM_BASE = 'https://api.telegram.org';
/** Strip the bot token from a Telegram API URL so it is safe to log. */
export function redactUrl(url) {
    return url.replace(/\/bot[^/]+\//, '/bot***/');
}
const MAX_RETRY_AFTER_S = 30;
export class TelegramApi {
    token;
    baseUrl;
    constructor(token, baseUrl = DEFAULT_TELEGRAM_BASE) {
        this.token = token;
        this.baseUrl = baseUrl.replace(/\/+$/, '');
    }
    url(method) {
        return `${this.baseUrl}/bot${this.token}/${method}`;
    }
    async request(method, body, timeoutMs = 15_000, retried = false) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        // Log the method only — the URL contains the token.
        logger.debug('Telegram API request', { method });
        try {
            const res = await fetch(this.url(method), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
            const json = (await res.json());
            if (!json.ok) {
                // 429: honour retry_after once (bounded) rather than failing the send.
                const retryAfter = json.error_code === 429 ? json.parameters?.retry_after : undefined;
                if (retryAfter && !retried) {
                    const waitS = Math.min(retryAfter, MAX_RETRY_AFTER_S);
                    logger.warn('Telegram 429, honouring retry_after', { method, waitS });
                    clearTimeout(timer);
                    await new Promise((r) => setTimeout(r, waitS * 1000));
                    return this.request(method, body, timeoutMs, true);
                }
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
    getChat(chatId) {
        return this.request('getChat', { chat_id: chatId }, 10_000);
    }
    sendMessage(chatId, text, opts = {}) {
        return this.request('sendMessage', {
            chat_id: chatId,
            text,
            parse_mode: opts.parse_mode,
            reply_markup: opts.reply_markup,
            disable_web_page_preview: opts.disable_web_page_preview ?? true,
            message_thread_id: opts.message_thread_id,
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
    sendChatAction(chatId, action = 'typing', threadId) {
        return this.request('sendChatAction', { chat_id: chatId, action, message_thread_id: threadId }, 10_000);
    }
    setMyCommands(commands) {
        return this.request('setMyCommands', { commands }, 10_000);
    }
    answerCallbackQuery(callbackQueryId, text) {
        return this.request('answerCallbackQuery', { callback_query_id: callbackQueryId, text }, 10_000);
    }
    /**
     * React to a message with a single emoji (replaces the bot's prior reaction).
     * Only emoji from Telegram's fixed allowed set work — callers pick from it.
     */
    setMessageReaction(chatId, messageId, emoji) {
        return this.request('setMessageReaction', {
            chat_id: chatId,
            message_id: messageId,
            reaction: emoji ? [{ type: 'emoji', emoji }] : [],
        }, 10_000);
    }
    // ── Forum topics ──
    createForumTopic(chatId, name) {
        return this.request('createForumTopic', { chat_id: chatId, name }, 10_000);
    }
    editForumTopic(chatId, threadId, name) {
        return this.request('editForumTopic', { chat_id: chatId, message_thread_id: threadId, name }, 10_000);
    }
    closeForumTopic(chatId, threadId) {
        return this.request('closeForumTopic', { chat_id: chatId, message_thread_id: threadId }, 10_000);
    }
    reopenForumTopic(chatId, threadId) {
        return this.request('reopenForumTopic', { chat_id: chatId, message_thread_id: threadId }, 10_000);
    }
    /** Deletes the topic AND its message history — the thread id is dead afterwards. */
    deleteForumTopic(chatId, threadId) {
        return this.request('deleteForumTopic', { chat_id: chatId, message_thread_id: threadId }, 10_000);
    }
    /**
     * Upload a document (multipart/form-data — the one non-JSON request). Used
     * for very long responses that would otherwise arrive as many chunks.
     */
    async sendDocument(chatId, filename, content, opts = {}) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 60_000);
        logger.debug('Telegram API request', { method: 'sendDocument' });
        try {
            const form = new FormData();
            form.append('chat_id', chatId);
            form.append('document', new Blob([content], { type: 'text/markdown' }), filename);
            if (opts.caption)
                form.append('caption', opts.caption);
            if (opts.message_thread_id)
                form.append('message_thread_id', String(opts.message_thread_id));
            const res = await fetch(this.url('sendDocument'), {
                method: 'POST',
                body: form,
                signal: controller.signal,
            });
            const json = (await res.json());
            if (!json.ok) {
                throw new Error(`Telegram sendDocument failed: ${json.error_code ?? '?'} ${json.description ?? ''}`.trim());
            }
            return json.result;
        }
        catch (err) {
            if (err instanceof DOMException && err.name === 'AbortError') {
                throw new Error('Telegram sendDocument timed out after 60000ms');
            }
            throw err;
        }
        finally {
            clearTimeout(timer);
        }
    }
}
