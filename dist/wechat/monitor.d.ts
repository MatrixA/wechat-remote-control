import { WeChatApi } from './api.js';
import type { WeixinMessage } from './types.js';
export interface MonitorCallbacks {
    onMessage: (msg: WeixinMessage) => Promise<void>;
    onSessionExpired: () => void;
}
export declare function createMonitor(api: WeChatApi, callbacks: MonitorCallbacks): {
    run: () => Promise<void>;
    stop: () => void;
};
