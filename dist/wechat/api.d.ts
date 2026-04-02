import type { GetUpdatesResp, SendMessageReq, GetUploadUrlResp } from './types.js';
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
    /** Get a presigned upload URL for media files. */
    getUploadUrl(fileType: string, fileSize: number, fileName: string): Promise<GetUploadUrlResp>;
}
