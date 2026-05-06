import { WeChatApi } from './api.js';
export declare function createSender(api: WeChatApi, botAccountId: string): {
    sendText: (toUserId: string, contextToken: string, text: string) => Promise<void>;
    sendImage: (toUserId: string, contextToken: string, filePath: string, caption?: string) => Promise<void>;
    sendVideo: (toUserId: string, contextToken: string, filePath: string, caption?: string) => Promise<void>;
    sendFile: (toUserId: string, contextToken: string, filePath: string, fileName?: string, caption?: string) => Promise<void>;
};
