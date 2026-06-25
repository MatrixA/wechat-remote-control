/**
 * Telegram transport adapter.
 *
 * Exposes the rich Bot API features the WeChat transport lacks (inline keyboards,
 * message editing, command menu, chat-action typing), behind the generic
 * Transport interface. Output is rendered as HTML; every send falls back to plain
 * text if the HTML payload is rejected (malformed entities or over-length), so an
 * odd agent response can never silently fail to deliver.
 */
import { TelegramApi } from './api.js';
import { createTelegramMonitor } from './monitor.js';
import { loadTelegramAccount } from './auth.js';
import { toTelegramHtml, buildInlineKeyboard } from './format.js';
import { logger } from '../logger.js';
const TYPING_REFRESH_MS = 4_000; // Telegram chat-action expires after ~5s
const CAPS = {
    inlineKeyboards: true,
    editMessages: true,
    typingIndicator: true,
    commandMenu: true,
    // Telegram's hard limit is 4096. We chunk well under it to leave headroom for
    // HTML-escaping expansion (& < > grow to 4-5 chars). deliver() additionally
    // falls back to plain text if an escaped payload still exceeds the limit, so a
    // pathological escape-heavy chunk degrades gracefully rather than failing.
    maxMessageLen: 2800,
};
export function createTelegramTransport() {
    let api = null;
    let monitor = null;
    let typingTimer = null;
    function clearTypingTimer() {
        if (typingTimer) {
            clearInterval(typingTimer);
            typingTimer = null;
        }
    }
    /** Send text as HTML, falling back to plain text on a parse/length rejection. */
    async function deliver(chatId, text, reply_markup) {
        try {
            const msg = await api.sendMessage(chatId, toTelegramHtml(text), { parse_mode: 'HTML', reply_markup });
            return { messageId: String(msg.message_id) };
        }
        catch (err) {
            logger.warn('Telegram HTML send failed, retrying as plain text', { error: err instanceof Error ? err.message : String(err) });
            const msg = await api.sendMessage(chatId, text, { reply_markup });
            return { messageId: String(msg.message_id) };
        }
    }
    return {
        name: 'telegram',
        caps: CAPS,
        async start(onMessage, onEvent) {
            const account = loadTelegramAccount();
            if (!account?.botToken) {
                throw new Error('No Telegram bot token found. Run login --telegram first.');
            }
            api = new TelegramApi(account.botToken);
            // Confirm the token and learn the bot's @username for the ready banner.
            let selfName = account.botUsername;
            try {
                selfName = (await api.getMe()).username ?? selfName;
            }
            catch (err) {
                throw new Error(`Telegram token rejected: ${err instanceof Error ? err.message : String(err)}`);
            }
            onEvent({ type: 'ready', selfName });
            monitor = createTelegramMonitor(api, account, onMessage);
            await monitor.run();
        },
        stop() {
            clearTypingTimer();
            monitor?.stop();
        },
        async sendText(target, text) {
            return deliver(target, text);
        },
        async editText(target, messageId, text) {
            try {
                await api.editMessageText(target, Number(messageId), toTelegramHtml(text), { parse_mode: 'HTML' });
            }
            catch (err) {
                const m = err instanceof Error ? err.message : String(err);
                if (m.includes('not modified'))
                    return; // identical content — harmless
                // Let the caller decide whether to fall back to a fresh send.
                throw err;
            }
        },
        async sendTyping(target, on) {
            if (!api)
                return;
            clearTypingTimer();
            if (!on)
                return;
            const send = () => api.sendChatAction(target, 'typing').catch(() => { });
            send();
            typingTimer = setInterval(send, TYPING_REFRESH_MS);
        },
        async sendButtons(target, text, rows) {
            return deliver(target, text, buildInlineKeyboard(rows));
        },
        async answerCallback(replyToken, text) {
            if (!api || !replyToken)
                return;
            await api.answerCallbackQuery(replyToken, text).catch(() => { });
        },
        async setCommandMenu(commands) {
            if (!api)
                return;
            await api.setMyCommands(commands.map((c) => ({ command: c.command, description: c.description }))).catch((err) => {
                logger.warn('setMyCommands failed', { error: err instanceof Error ? err.message : String(err) });
            });
        },
    };
}
