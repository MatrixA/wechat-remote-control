/**
 * IM transport abstraction.
 *
 * The bridge core (src/index.js) drives a tmux-hosted coding agent and forwards
 * its output to an instant-messenger. WeChat was hard-coded throughout; this
 * interface lets a second IM (Telegram) plug in without the core knowing which
 * transport it talks to.
 *
 * The single most important idea: a reply destination is an OPAQUE `target`
 * string that only the transport understands. WeChat encodes its
 * `(userId, contextToken)` couple into one string; Telegram uses `String(chatId)`
 * or `"<chatId>:<threadId>"` for a forum-topic destination. The core never
 * parses `target` — it just hands it back to the transport.
 */
export interface TransportCapabilities {
    /** Inline tap-able keyboards (Telegram) vs numbered-text menus (WeChat). */
    inlineKeyboards: boolean;
    /** Can edit a previously sent message in place (Telegram). */
    editMessages: boolean;
    /** Supports a typing / chat-action indicator. */
    typingIndicator: boolean;
    /** Supports a persistent command menu (Telegram setMyCommands). */
    commandMenu: boolean;
    /**
     * Forum-topic routing is live: a topics-enabled group is bound and each
     * session can own its own thread. Recomputed by the transport at start().
     */
    topics: boolean;
    /** Can attach emoji reactions to a user's message (Telegram setMessageReaction). */
    reactions: boolean;
    /** Can send a text file (Telegram sendDocument) for very long responses. */
    documents: boolean;
    /**
     * Max characters per outbound message. Callers chunk with splitMessage() at
     * this size. WeChat 2048; Telegram 4096 (kept conservative for HTML escaping
     * headroom — see telegram/transport.ts).
     */
    maxMessageLen: number;
}
export type InboundKind = 'text' | 'callback' | 'unsupported_media' | 'topic_edited';
/**
 * Normalised inbound message. Both transports map their native payload onto this
 * shape so the core handles one type.
 */
export interface InboundMessage {
    /** Opaque reply target (transport-specific encoding). */
    target: string;
    /** Token needed to acknowledge an interactive callback (Telegram callback_query.id); '' otherwise. */
    replyToken: string;
    /** User text to inject (voice ASR folded in for WeChat). Empty for callbacks / unsupported media. */
    text: string;
    kind: InboundKind;
    /** Present when kind === 'callback': the button's encoded payload. */
    callbackData?: string;
    /** A human-facing notice to send back (unsupported media, or a side-note alongside text). */
    mediaNote?: string;
    /** Stable per-user id, used for first-message welcome dedup and (Telegram) auth. */
    userKey: string;
    /** IM message id of this inbound message (Telegram; used for reactions). */
    messageId?: string;
    /**
     * IM message id this message replies to (Telegram reply_to_message). Caveat:
     * inside a forum topic, a NON-reply message still carries reply_to_message
     * pointing at the topic's root service message — presence alone never means
     * "the user replied"; only exact equality with a message id the bridge sent
     * (e.g. a ForceReply prompt) is meaningful.
     */
    replyToMessageId?: string;
    /** Present when kind === 'topic_edited': the topic's new display name. */
    topicName?: string;
}
/**
 * One inline-keyboard button: either a callback button (`data`, <= 64 UTF-8
 * bytes — Telegram limit) or a URL button (`url`). Exactly one must be set.
 */
export interface Button {
    label: string;
    data?: string;
    url?: string;
}
/** Result of a send. `messageId` is set only when the transport supports editing. */
export interface SentMessage {
    messageId?: string;
}
/** A command menu entry (Telegram setMyCommands). */
export interface MenuCommand {
    command: string;
    description: string;
}
export type TransportEvent = {
    type: 'session_expired';
    detail?: string;
} | {
    type: 'ready';
    selfName?: string;
};
/** A document (file) payload for very long responses. */
export interface OutboundDocument {
    filename: string;
    content: string;
    caption?: string;
}
/**
 * Forum-topic management (Telegram supergroups with Topics enabled). All
 * targets returned/accepted here are the same opaque strings the rest of the
 * Transport interface uses.
 */
export interface TopicsApi {
    /** Bind the group a message came from as the topics group. */
    bind(target: string): Promise<{
        ok: boolean;
        reason?: string;
    }>;
    /** Create a topic and return its opaque per-topic target. */
    create(name: string): Promise<string>;
    rename(target: string, name: string): Promise<void>;
    close(target: string): Promise<void>;
    reopen(target: string): Promise<void>;
    /** Delete the topic and its history (Telegram deleteForumTopic) — irreversible. */
    remove(target: string): Promise<void>;
    /** Deep link (t.me/c/...) to a topic, when derivable. */
    link(target: string): string | null;
}
export interface Transport {
    readonly name: 'wechat' | 'telegram';
    readonly caps: TransportCapabilities;
    /** Begin receiving. Resolves once the receive loop is wired; runs until stop(). */
    start(onMessage: (m: InboundMessage) => void, onEvent: (e: TransportEvent) => void): Promise<void>;
    stop(): void;
    /**
     * `opts.forceReply` asks the client to open its reply UI on this message
     * (Telegram ForceReply) so the user's next message arrives as a reply the
     * core can match by id. Transports without the concept ignore it — an
     * implementation may declare fewer parameters (WeChat does).
     */
    sendText(target: string, text: string, opts?: {
        forceReply?: boolean;
    }): Promise<SentMessage>;
    /**
     * Edit a prior message. Only meaningful when caps.editMessages. `buttons`
     * (when given) replaces the message's inline keyboard — Telegram drops the
     * keyboard on an edit that omits reply_markup, so callers that want to keep
     * a button must re-send it.
     */
    editText(target: string, messageId: string, text: string, buttons?: Button[][]): Promise<void>;
    /** Show/hide a typing indicator. The transport owns its own refresh cadence. */
    sendTyping(target: string, on: boolean): Promise<void>;
    /** Send text with an inline keyboard. Only meaningful when caps.inlineKeyboards. */
    sendButtons(target: string, text: string, rows: Button[][]): Promise<SentMessage>;
    /** Acknowledge a button tap (clears the client spinner). No-op on WeChat. */
    answerCallback(replyToken: string, text?: string): Promise<void>;
    /** Register the bot command menu. No-op on WeChat. */
    setCommandMenu?(commands: MenuCommand[]): Promise<void>;
    /** React to a user's message with an emoji. Only when caps.reactions. */
    react?(target: string, messageId: string, emoji: string): Promise<void>;
    /** Send a file. Only when caps.documents. */
    sendDocument?(target: string, doc: OutboundDocument): Promise<SentMessage>;
    /** Forum-topic management. Present on Telegram; caps.topics gates live use. */
    topics?: TopicsApi;
    /**
     * The "home" destination for global notices (welcome, dashboards): the bound
     * topics group's General topic, else the locked private chat. Null when the
     * transport has no better idea than the last inbound target.
     */
    homeTarget?(): string | null;
}
