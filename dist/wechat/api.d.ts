import type { GetUpdatesResp, SendMessageReq, GetUploadUrlReq, GetUploadUrlResp } from './types.js';
export declare class WeChatApi {
    private readonly token;
    private readonly baseUrl;
    private readonly uin;
    constructor(token: string, baseUrl?: string);
    private headers;
    private request;
    /** Long-poll for new messages. Timeout 35s for long-polling. */
    getUpdates(buf?: string): Promise<GetUpdatesResp>;
    /** Send a message to a user. */
    sendMessage(req: SendMessageReq): Promise<void>;
    /**
     * Get a presigned upload URL for media files.
     * Matches the real API: filekey, media_type, to_user_id, rawsize, rawfilemd5,
     * filesize, no_need_thumb, aeskey.
     */
    getUploadUrl(req: GetUploadUrlReq): Promise<GetUploadUrlResp>;
    /** Fetch bot config (includes typing_ticket) for a given user. */
    getConfig(ilinkUserId: string, contextToken: string): Promise<{
        ret?: number;
        typing_ticket?: string;
    }>;
    /** Send a typing indicator to a user. status=1 for typing, status=2 to cancel. */
    sendTyping(toUserId: string, typingTicket: string, status?: 1 | 2): Promise<void>;
}
