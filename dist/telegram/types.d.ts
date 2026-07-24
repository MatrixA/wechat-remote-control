export interface TgResponse<T> {
    ok: boolean;
    result?: T;
    description?: string;
    error_code?: number;
    parameters?: {
        retry_after?: number;
        migrate_to_chat_id?: number;
    };
}
export interface TgUser {
    id: number;
    is_bot: boolean;
    first_name?: string;
    username?: string;
}
export interface TgChat {
    id: number;
    type: string;
    username?: string;
    title?: string;
    /** True for supergroups with Topics enabled. */
    is_forum?: boolean;
}
export interface TgMessage {
    message_id: number;
    from?: TgUser;
    chat: TgChat;
    date: number;
    text?: string;
    /** Forum-topic thread id; only meaningful together with is_topic_message. */
    message_thread_id?: number;
    is_topic_message?: boolean;
    /** Service message: this topic was edited (name and/or icon; absent field = unchanged). */
    forum_topic_edited?: {
        name?: string;
        icon_custom_emoji_id?: string;
    };
    /**
     * The message this one replies to (only message_id is consumed). Inside a
     * forum topic this is ALSO set on non-reply messages (the topic's root
     * service message) — consumers must match exact ids, never mere presence.
     */
    reply_to_message?: {
        message_id: number;
    };
    photo?: unknown[];
    document?: unknown;
    voice?: unknown;
    video?: unknown;
    audio?: unknown;
    sticker?: unknown;
}
export interface TgCallbackQuery {
    id: string;
    from: TgUser;
    message?: TgMessage;
    data?: string;
}
export interface TgUpdate {
    update_id: number;
    message?: TgMessage;
    edited_message?: TgMessage;
    callback_query?: TgCallbackQuery;
}
export interface TgInlineKeyboardButton {
    text: string;
    callback_data?: string;
    url?: string;
}
export interface TgInlineKeyboardMarkup {
    inline_keyboard: TgInlineKeyboardButton[][];
}
/** sendMessage reply_markup variant that opens the client's reply UI. */
export interface TgForceReply {
    force_reply: true;
    input_field_placeholder?: string;
    selective?: boolean;
}
export interface TgBotCommand {
    command: string;
    description: string;
}
/** Result of createForumTopic. */
export interface TgForumTopic {
    message_thread_id: number;
    name: string;
    icon_color?: number;
}
