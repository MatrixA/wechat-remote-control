import { saveOffset, loadOffset, saveAllowedChat, isChatAllowed } from './auth.js';
import { logger } from '../logger.js';
const BACKOFF_THRESHOLD = 3;
const BACKOFF_LONG_MS = 30_000;
const BACKOFF_SHORT_MS = 3_000;
const MIN_POLL_INTERVAL_MS = 1_000;
// Default to SHORT polling (timeout 0). A long poll that is reset mid-flight leaves
// the SERVER holding the request for up to `timeout` seconds; the next getUpdates then
// collides with that "ghost" poll — HTTP 409 "terminated by other getUpdates request" —
// and fail→retry→409 loops until the ghost expires (up to 30s on the old value). Short
// polling returns immediately and leaves no hanging server-side request, so a flaky
// (e.g. GFW-affected) link self-recovers in seconds via the existing backoff. The
// MIN_POLL_INTERVAL_MS floor caps it at ~1 req/s; inbound latency stays ≤ ~1s. Stable
// links that prefer instant long-poll delivery can opt back in via WCC_TG_POLL_TIMEOUT.
const LONG_POLL_TIMEOUT_S = (() => {
    const v = parseInt(process.env.WCC_TG_POLL_TIMEOUT ?? '', 10);
    return Number.isFinite(v) && v >= 0 ? v : 0;
})();
function mediaNoteFor(msg) {
    if (msg.voice || msg.audio)
        return '⚠️ 暂不支持语音消息，请发送文字';
    if (msg.photo)
        return '⚠️ 暂不支持图片消息，请发送文字';
    if (msg.video || msg.document || msg.sticker)
        return '⚠️ 暂不支持该类型消息，请发送文字';
    return null;
}
/** Encode a message's reply destination: plain chat, or "<chatId>:<threadId>" inside a topic. */
function targetOf(msg) {
    if (msg.is_topic_message && msg.message_thread_id) {
        return `${msg.chat.id}:${msg.message_thread_id}`;
    }
    return String(msg.chat.id);
}
/** Normalise a Telegram Update into the shared inbound shape (pure). */
export function normalizeUpdate(update) {
    const cq = update.callback_query;
    if (cq) {
        const msg = cq.message;
        if (!msg)
            return null; // can't route a reply without a chat
        return {
            target: targetOf(msg),
            replyToken: cq.id,
            text: '',
            kind: 'callback',
            callbackData: cq.data ?? '',
            userKey: String(cq.from.id),
            // The tapped message, so handlers can edit it in place (e.g. move the
            // 🎯 marker on the /fc menu instead of sending a fresh message).
            messageId: String(msg.message_id),
        };
    }
    const msg = update.message;
    if (!msg)
        return null;
    const target = targetOf(msg);
    const userKey = String(msg.from?.id ?? msg.chat.id);
    const messageId = String(msg.message_id);
    // A topic was renamed in the Telegram UI (service message; also echoed for
    // the bridge's own editForumTopic calls — the core absorbs those by name).
    // Icon-only edits carry no name and are irrelevant here. Service messages
    // don't reliably set is_topic_message, so key off message_thread_id directly.
    if (msg.forum_topic_edited) {
        const name = (msg.forum_topic_edited.name ?? '').trim();
        if (!name || !msg.message_thread_id)
            return null;
        return {
            target: `${msg.chat.id}:${msg.message_thread_id}`,
            replyToken: '', text: '', kind: 'topic_edited', topicName: name, userKey, messageId,
        };
    }
    if (typeof msg.text === 'string' && msg.text.length > 0) {
        return {
            target, replyToken: '', text: msg.text, kind: 'text', userKey, messageId,
            // Conditional spread: inside a forum topic even non-reply messages carry
            // reply_to_message (the topic's root service message), so consumers must
            // match exact ids; absence stays absence (not `undefined`) so strict
            // object comparisons of the normalized shape keep working.
            ...(msg.reply_to_message?.message_id != null
                ? { replyToMessageId: String(msg.reply_to_message.message_id) } : {}),
        };
    }
    const note = mediaNoteFor(msg);
    if (note) {
        return { target, replyToken: '', text: '', kind: 'unsupported_media', mediaNote: note, userKey, messageId };
    }
    return null; // service message / unhandled
}
/** The plain chat id an update came from (authorization is chat-level, not thread-level). */
function chatIdOf(update) {
    const chat = update.message?.chat ?? update.callback_query?.message?.chat;
    return chat ? String(chat.id) : null;
}
/** Username best-effort, for capturing the locked chat. */
function usernameOf(update) {
    return update.message?.from?.username
        ?? update.callback_query?.from?.username
        ?? update.message?.chat?.username;
}
export function createTelegramMonitor(api, account, onMessage) {
    const controller = new AbortController();
    async function run() {
        let offset = loadOffset();
        let consecutiveFailures = 0;
        while (!controller.signal.aborted) {
            const iterStart = Date.now();
            try {
                const updates = await api.getUpdates({
                    offset,
                    timeout: LONG_POLL_TIMEOUT_S,
                    allowed_updates: ['message', 'callback_query'],
                });
                // Advance + persist the cursor BEFORE processing (crash-safe).
                for (const u of updates) {
                    if (u.update_id >= offset)
                        offset = u.update_id + 1;
                }
                if (updates.length > 0)
                    saveOffset(offset);
                for (const u of updates) {
                    const inbound = normalizeUpdate(u);
                    if (!inbound)
                        continue;
                    // ── Chat authorization lock ──
                    const chatId = chatIdOf(u) ?? inbound.target;
                    if (!isChatAllowed(account, chatId, inbound.userKey)) {
                        logger.warn('Dropping message from unauthorized chat', { chatId });
                        continue;
                    }
                    // Capture-lock only a PRIVATE chat: locking a group id would block the
                    // owner's own DM forever (the owner exception compares fromUserId to
                    // allowedChatId, which equals the user id only for private chats).
                    // A group that messages an unbound bot passes through un-captured, so
                    // the /bind-before-first-DM order still works.
                    const chatType = (u.message?.chat ?? u.callback_query?.message?.chat)?.type;
                    if (!account.allowedChatId && chatType === 'private') {
                        account.allowedChatId = chatId;
                        account.allowedUsername = usernameOf(u);
                        saveAllowedChat(chatId, account.allowedUsername);
                        logger.info('Telegram locked to chat', { chatId, username: account.allowedUsername });
                    }
                    try {
                        onMessage(inbound);
                    }
                    catch (err) {
                        logger.error('Error processing Telegram update', { error: err instanceof Error ? err.message : String(err) });
                    }
                }
                consecutiveFailures = 0;
            }
            catch (err) {
                if (controller.signal.aborted)
                    break;
                consecutiveFailures++;
                const errMsg = err instanceof Error ? err.message : String(err);
                // 409 = another poller / webhook is set. Back off long, keep retrying.
                const isConflict = errMsg.includes('409');
                logger.error('Telegram monitor error', { error: errMsg, consecutiveFailures, conflict: isConflict });
                const backoff = (isConflict || consecutiveFailures >= BACKOFF_THRESHOLD) ? BACKOFF_LONG_MS : BACKOFF_SHORT_MS;
                await sleep(backoff, controller.signal);
                continue;
            }
            const elapsed = Date.now() - iterStart;
            if (elapsed < MIN_POLL_INTERVAL_MS && !controller.signal.aborted) {
                await sleep(MIN_POLL_INTERVAL_MS - elapsed, controller.signal);
            }
        }
        logger.info('Telegram monitor stopped');
    }
    function stop() {
        if (!controller.signal.aborted)
            controller.abort();
    }
    return { run, stop };
}
function sleep(ms, signal) {
    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve();
            return;
        }
        // Drop the abort listener when the timer wins so completed sleeps don't
        // accumulate dead listeners on the long-lived AbortSignal.
        const onAbort = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
