/**
 * Telegram transport adapter.
 *
 * Exposes the rich Bot API features the WeChat transport lacks (inline keyboards,
 * message editing, command menu, chat-action typing, forum topics, reactions,
 * document uploads), behind the generic Transport interface. Output is rendered
 * as HTML; every send falls back to plain text if the HTML payload is rejected
 * (malformed entities or over-length), so an odd agent response can never
 * silently fail to deliver.
 *
 * Target encoding (opaque to the core): "<chatId>" for a plain chat, or
 * "<chatId>:<threadId>" for a forum-topic destination. Only this file
 * encodes/decodes that shape.
 */
import { TelegramApi } from './api.js';
import { createTelegramMonitor } from './monitor.js';
import { loadTelegramAccount, saveBoundGroup } from './auth.js';
import { toTelegramHtml, toExpandableHtml, buildInlineKeyboard } from './format.js';
import { logger } from '../logger.js';
const TYPING_REFRESH_MS = 4_000; // Telegram chat-action expires after ~5s
// Startup token verification (getMe) retry. A fresh process's FIRST connection to
// api.telegram.org is frequently reset on a flaky/GFW-affected link, so a single
// shot would fatal-exit the daemon on a very common transient failure. Retry with
// a bounded backoff; only a real auth rejection (HTTP 401) aborts immediately.
const GETME_MAX_ATTEMPTS = 8;
const GETME_RETRY_MS = 2_000;
// Responses longer than this render with the tail collapsed into an expandable
// blockquote, so a long answer doesn't wallpaper the chat.
const EXPANDABLE_THRESHOLD = 1_500;
/** Decode an opaque target into its chat + optional forum-thread parts. */
export function decodeTarget(target) {
    const idx = target.indexOf(':');
    if (idx < 0)
        return { chatId: target };
    const thread = parseInt(target.slice(idx + 1), 10);
    if (!Number.isFinite(thread))
        return { chatId: target };
    return { chatId: target.slice(0, idx), threadId: thread };
}
/** Encode a chat + optional thread into the opaque target shape. */
export function encodeTarget(chatId, threadId) {
    return threadId ? `${chatId}:${threadId}` : chatId;
}
export function createTelegramTransport() {
    let api = null;
    let monitor = null;
    // One typing refresher per destination — concurrent sessions in different
    // topics each keep their own indicator alive.
    const typingTimers = new Map();
    let groupChatId;
    const caps = {
        inlineKeyboards: true,
        editMessages: true,
        typingIndicator: true,
        commandMenu: true,
        topics: false, // recomputed at start() from the bound group
        reactions: true,
        documents: true,
        // Telegram's hard limit is 4096. We chunk well under it to leave headroom for
        // HTML-escaping expansion (& < > grow to 4-5 chars). deliver() additionally
        // falls back to plain text if an escaped payload still exceeds the limit, so a
        // pathological escape-heavy chunk degrades gracefully rather than failing.
        maxMessageLen: 2800,
    };
    function clearTypingTimer(target) {
        const t = typingTimers.get(target);
        if (t) {
            clearInterval(t);
            typingTimers.delete(target);
        }
    }
    /** Send text as HTML, falling back to plain text on a parse/length rejection. */
    async function deliver(target, text, reply_markup, opts = {}) {
        const { chatId, threadId } = decodeTarget(target);
        const html = opts.expandable && text.length > EXPANDABLE_THRESHOLD
            ? toExpandableHtml(text)
            : toTelegramHtml(text);
        try {
            const msg = await api.sendMessage(chatId, html, { parse_mode: 'HTML', reply_markup, message_thread_id: threadId });
            return { messageId: String(msg.message_id) };
        }
        catch (err) {
            logger.warn('Telegram HTML send failed, retrying as plain text', { error: err instanceof Error ? err.message : String(err) });
            const msg = await api.sendMessage(chatId, text, { reply_markup, message_thread_id: threadId });
            return { messageId: String(msg.message_id) };
        }
    }
    return {
        name: 'telegram',
        caps,
        async start(onMessage, onEvent) {
            const account = loadTelegramAccount();
            if (!account?.botToken) {
                throw new Error('No Telegram bot token found. Run login --telegram first.');
            }
            api = new TelegramApi(account.botToken);
            groupChatId = account.groupChatId;
            caps.topics = !!groupChatId;
            // Confirm the token and learn the bot's @username for the ready banner.
            // Retry transient network failures (ECONNRESET / timeout / "fetch failed")
            // so a flaky first connection doesn't kill the daemon; bail only on a real
            // 401 auth rejection.
            let selfName = account.botUsername;
            let verified = false;
            for (let attempt = 1; attempt <= GETME_MAX_ATTEMPTS; attempt++) {
                try {
                    selfName = (await api.getMe()).username ?? selfName;
                    verified = true;
                    break;
                }
                catch (err) {
                    const m = err instanceof Error ? err.message : String(err);
                    if (/\b401\b|unauthorized/i.test(m)) {
                        throw new Error(`Telegram token rejected (auth): ${m}`);
                    }
                    logger.warn('getMe failed, retrying', { attempt, max: GETME_MAX_ATTEMPTS, error: m });
                    if (attempt < GETME_MAX_ATTEMPTS)
                        await new Promise((r) => setTimeout(r, GETME_RETRY_MS));
                }
            }
            if (!verified) {
                throw new Error(`Telegram getMe failed after ${GETME_MAX_ATTEMPTS} attempts (link unstable?)`);
            }
            onEvent({ type: 'ready', selfName });
            monitor = createTelegramMonitor(api, account, onMessage);
            await monitor.run();
        },
        stop() {
            for (const target of [...typingTimers.keys()])
                clearTypingTimer(target);
            monitor?.stop();
        },
        async sendText(target, text) {
            return deliver(target, text, undefined, { expandable: true });
        },
        async editText(target, messageId, text, buttons) {
            const { chatId } = decodeTarget(target);
            try {
                await api.editMessageText(chatId, Number(messageId), toTelegramHtml(text), {
                    parse_mode: 'HTML',
                    reply_markup: buttons ? buildInlineKeyboard(buttons) : undefined,
                });
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
            clearTypingTimer(target);
            if (!on)
                return;
            const { chatId, threadId } = decodeTarget(target);
            const send = () => api.sendChatAction(chatId, 'typing', threadId).catch(() => { });
            send();
            typingTimers.set(target, setInterval(send, TYPING_REFRESH_MS));
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
        async react(target, messageId, emoji) {
            if (!api)
                return;
            const { chatId } = decodeTarget(target);
            await api.setMessageReaction(chatId, Number(messageId), emoji);
        },
        async sendDocument(target, doc) {
            const { chatId, threadId } = decodeTarget(target);
            const msg = await api.sendDocument(chatId, doc.filename, doc.content, {
                caption: doc.caption,
                message_thread_id: threadId,
            });
            return { messageId: String(msg.message_id) };
        },
        homeTarget() {
            if (groupChatId)
                return groupChatId; // the group's General topic
            const account = loadTelegramAccount();
            return account?.allowedChatId ?? null;
        },
        topics: {
            async bind(target) {
                if (!api)
                    return { ok: false, reason: 'transport not started' };
                const { chatId } = decodeTarget(target);
                let chat;
                try {
                    chat = await api.getChat(chatId);
                }
                catch (err) {
                    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
                }
                if (chat.type !== 'supergroup' || !chat.is_forum) {
                    return { ok: false, reason: '这里不是开启了「话题(Topics)」的超级群。请在群设置中开启话题功能后重试。' };
                }
                saveBoundGroup(chatId, chat.title);
                groupChatId = chatId;
                caps.topics = true;
                logger.info('Telegram topics group bound', { title: chat.title });
                return { ok: true };
            },
            async create(name) {
                if (!api || !groupChatId)
                    throw new Error('no topics group bound');
                const topic = await api.createForumTopic(groupChatId, name.slice(0, 128));
                return encodeTarget(groupChatId, topic.message_thread_id);
            },
            async rename(target, name) {
                if (!api)
                    return;
                const { chatId, threadId } = decodeTarget(target);
                if (!threadId)
                    return;
                await api.editForumTopic(chatId, threadId, name.slice(0, 128));
            },
            async close(target) {
                if (!api)
                    return;
                const { chatId, threadId } = decodeTarget(target);
                if (!threadId)
                    return;
                await api.closeForumTopic(chatId, threadId);
            },
            async reopen(target) {
                if (!api)
                    return;
                const { chatId, threadId } = decodeTarget(target);
                if (!threadId)
                    return;
                await api.reopenForumTopic(chatId, threadId);
            },
            async remove(target) {
                if (!api)
                    return;
                const { chatId, threadId } = decodeTarget(target);
                if (!threadId)
                    return;
                await api.deleteForumTopic(chatId, threadId);
            },
            link(target) {
                const { chatId, threadId } = decodeTarget(target);
                if (!threadId)
                    return null;
                // Supergroup ids are -100<internal>; the t.me/c/ form uses the internal part.
                const m = chatId.match(/^-100(\d+)$/);
                if (!m)
                    return null;
                return `https://t.me/c/${m[1]}/${threadId}`;
            },
        },
    };
}
