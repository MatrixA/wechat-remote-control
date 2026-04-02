import { loadJson, saveJson } from './store.js';
import { mkdirSync } from 'node:fs';
import { DATA_DIR } from './constants.js';
import { join } from 'node:path';
const SESSIONS_DIR = join(DATA_DIR, 'sessions');
function validateAccountId(accountId) {
    if (!/^[a-zA-Z0-9_.@=-]+$/.test(accountId)) {
        throw new Error(`Invalid accountId: "${accountId}"`);
    }
}
const DEFAULT_MAX_HISTORY = 100;
export function createSessionStore() {
    function getSessionPath(accountId) {
        validateAccountId(accountId);
        return join(SESSIONS_DIR, `${accountId}.json`);
    }
    function load(accountId) {
        validateAccountId(accountId);
        const session = loadJson(getSessionPath(accountId), {
            workingDirectory: process.cwd(),
            state: 'idle',
            chatHistory: [],
            maxHistoryLength: DEFAULT_MAX_HISTORY,
        });
        // Backward compatibility: ensure chatHistory exists
        if (!session.chatHistory) {
            session.chatHistory = [];
        }
        if (!session.maxHistoryLength) {
            session.maxHistoryLength = DEFAULT_MAX_HISTORY;
        }
        return session;
    }
    function save(accountId, session) {
        mkdirSync(SESSIONS_DIR, { recursive: true });
        // Trim chat history if it exceeds max length before saving
        const maxLen = session.maxHistoryLength || DEFAULT_MAX_HISTORY;
        if (session.chatHistory.length > maxLen) {
            session.chatHistory = session.chatHistory.slice(-maxLen);
        }
        saveJson(getSessionPath(accountId), session);
    }
    function clear(accountId, currentSession) {
        const session = {
            workingDirectory: currentSession?.workingDirectory ?? process.cwd(),
            model: currentSession?.model,
            permissionMode: currentSession?.permissionMode,
            state: 'idle',
            chatHistory: [],
            maxHistoryLength: currentSession?.maxHistoryLength || DEFAULT_MAX_HISTORY,
        };
        save(accountId, session);
        return session;
    }
    function addChatMessage(session, role, content) {
        if (!session.chatHistory) {
            session.chatHistory = [];
        }
        session.chatHistory.push({
            role,
            content,
            timestamp: Date.now(),
        });
        // Trim if exceeds max length
        const maxLen = session.maxHistoryLength || DEFAULT_MAX_HISTORY;
        if (session.chatHistory.length > maxLen) {
            session.chatHistory = session.chatHistory.slice(-maxLen);
        }
    }
    function getChatHistoryText(session, limit) {
        const history = session.chatHistory || [];
        const messages = limit ? history.slice(-limit) : history;
        if (messages.length === 0) {
            return '暂无对话记录';
        }
        const lines = [];
        for (const msg of messages) {
            const time = new Date(msg.timestamp).toLocaleString('zh-CN');
            const role = msg.role === 'user' ? '用户' : 'Claude';
            lines.push(`[${time}] ${role}:`);
            lines.push(msg.content);
            lines.push('');
        }
        return lines.join('\n');
    }
    return { load, save, clear, addChatMessage, getChatHistoryText };
}
