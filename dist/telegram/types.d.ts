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
}
export interface TgMessage {
    message_id: number;
    from?: TgUser;
    chat: TgChat;
    date: number;
    text?: string;
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
    callback_data: string;
}
export interface TgInlineKeyboardMarkup {
    inline_keyboard: TgInlineKeyboardButton[][];
}
export interface TgBotCommand {
    command: string;
    description: string;
}
