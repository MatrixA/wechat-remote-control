export type SessionState = 'idle' | 'processing' | 'waiting_permission';
export interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
    timestamp: number;
}
export interface Session {
    sdkSessionId?: string;
    previousSdkSessionId?: string;
    workingDirectory: string;
    model?: string;
    permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'auto';
    state: SessionState;
    chatHistory: ChatMessage[];
    maxHistoryLength?: number;
}
export interface PendingPermission {
    toolName: string;
    toolInput: string;
    resolve: (allowed: boolean) => void;
    timer: NodeJS.Timeout;
}
export declare function createSessionStore(): {
    load: (accountId: string) => Session;
    save: (accountId: string, session: Session) => void;
    clear: (accountId: string, currentSession?: Session) => Session;
    addChatMessage: (session: Session, role: "user" | "assistant", content: string) => void;
    getChatHistoryText: (session: Session, limit?: number) => string;
};
