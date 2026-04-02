import type { AccountData } from './wechat/accounts.js';
import type { createSender } from './wechat/send.js';
export declare function createBridgeWatcher(account: AccountData, sender: ReturnType<typeof createSender>, sharedCtx: {
    lastContextToken: string;
}, onBridgeAttach?: (sessionId: string, cwd: string) => void): {
    start: () => void;
    pause: () => void;
    resume: () => void;
    stop: () => void;
};
