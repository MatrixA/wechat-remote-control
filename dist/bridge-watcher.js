import { statSync, openSync, readSync, closeSync, existsSync } from 'node:fs';
import { watch as fsWatch } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from './logger.js';
import { readBridge } from './bridge.js';
const DEBOUNCE_MS = 1500;
const BRIDGE_POLL_MS = 2000;
const MAX_MESSAGE_LENGTH = 2048;
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getSessionFilePath(cwd, sessionId) {
    const encoded = cwd.replace(/\//g, '-');
    return join(homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`);
}
function extractTextsFromNewLines(lines) {
    const texts = [];
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        try {
            const obj = JSON.parse(trimmed);
            // Only process complete assistant messages
            if (obj.type !== 'assistant')
                continue;
            const msg = obj.message;
            if (!msg || !msg.stop_reason)
                continue; // null/undefined = still streaming
            const content = msg.content;
            if (!Array.isArray(content))
                continue;
            const text = content
                .filter((b) => b.type === 'text' && typeof b.text === 'string')
                .map((b) => b.text)
                .join('');
            if (text.trim())
                texts.push(text.trim());
        }
        catch {
            // Incomplete or invalid JSON — skip
        }
    }
    return texts;
}
function splitMessage(text, maxLen = MAX_MESSAGE_LENGTH) {
    if (text.length <= maxLen)
        return [text];
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
        if (remaining.length <= maxLen) {
            chunks.push(remaining);
            break;
        }
        let idx = remaining.lastIndexOf('\n', maxLen);
        if (idx < maxLen * 0.3)
            idx = maxLen;
        chunks.push(remaining.slice(0, idx));
        remaining = remaining.slice(idx).replace(/^\n+/, '');
    }
    return chunks;
}
// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
export function createBridgeWatcher(account, sender, sharedCtx, onBridgeAttach) {
    let sessionWatch = null;
    let paused = false;
    let bridgePollTimer = null;
    let currentBridgeSessionId;
    // -- Session file watcher --
    function stopSessionWatch() {
        if (!sessionWatch)
            return;
        sessionWatch.watcher?.close();
        if (sessionWatch.debounceTimer)
            clearTimeout(sessionWatch.debounceTimer);
        if (sessionWatch.fallbackPollTimer)
            clearInterval(sessionWatch.fallbackPollTimer);
        sessionWatch = null;
    }
    function startSessionWatch(sessionId, cwd) {
        if (sessionWatch?.sessionId === sessionId)
            return; // already on this session
        stopSessionWatch();
        const filePath = getSessionFilePath(cwd, sessionId);
        if (!existsSync(filePath)) {
            logger.warn('BridgeWatcher: session file not found', { filePath });
            return;
        }
        const fileOffset = statSync(filePath).size; // start from current EOF
        const sw = {
            sessionId, filePath, fileOffset,
            pendingBuffer: '',
            watcher: null,
            debounceTimer: null,
            fallbackPollTimer: null,
        };
        try {
            sw.watcher = fsWatch(filePath, () => {
                if (!sessionWatch)
                    return;
                if (sessionWatch.debounceTimer)
                    clearTimeout(sessionWatch.debounceTimer);
                sessionWatch.debounceTimer = setTimeout(processNewContent, DEBOUNCE_MS);
            });
            sw.watcher.on('error', (err) => {
                logger.warn('BridgeWatcher: fs.watch error', { err: err.message });
            });
        }
        catch (err) {
            // fs.watch unavailable (some Linux configs, network filesystems, etc.)
            // Fall back to polling the session file directly so content is never lost.
            logger.warn('BridgeWatcher: fs.watch unavailable, using fallback poll', { filePath, err });
            sw.fallbackPollTimer = setInterval(processNewContent, BRIDGE_POLL_MS);
        }
        sessionWatch = sw;
        logger.info('BridgeWatcher: watching session', { sessionId, fileOffset, fallback: sw.watcher === null });
    }
    // -- Content processing --
    function processNewContent() {
        if (!sessionWatch || paused)
            return;
        try {
            const stat = statSync(sessionWatch.filePath);
            if (stat.size <= sessionWatch.fileOffset)
                return;
            // Read only new bytes
            const buf = Buffer.alloc(stat.size - sessionWatch.fileOffset);
            const fd = openSync(sessionWatch.filePath, 'r');
            try {
                readSync(fd, buf, 0, buf.length, sessionWatch.fileOffset);
            }
            finally {
                closeSync(fd);
            }
            sessionWatch.fileOffset = stat.size;
            // Prepend any partial line saved from the previous read
            const raw = sessionWatch.pendingBuffer + buf.toString('utf8');
            const lines = raw.split('\n');
            // Last element may be incomplete — save for next read
            sessionWatch.pendingBuffer = lines.pop() ?? '';
            const texts = extractTextsFromNewLines(lines);
            if (texts.length === 0)
                return;
            const fullText = texts.join('\n\n').trim();
            if (!fullText)
                return;
            logger.info('BridgeWatcher: pushing to WeChat', { chars: fullText.length });
            const toUserId = account.userId ?? '';
            const contextToken = sharedCtx.lastContextToken;
            for (const chunk of splitMessage(fullText)) {
                sender.sendText(toUserId, contextToken, chunk).catch((err) => {
                    logger.error('BridgeWatcher: sendText failed', {
                        err: err instanceof Error ? err.message : String(err),
                    });
                });
            }
        }
        catch (err) {
            logger.warn('BridgeWatcher: error reading session file', {
                err: err instanceof Error ? err.message : String(err),
            });
        }
    }
    // -- Bridge.json polling --
    function checkBridge() {
        const bridge = readBridge();
        if (!bridge) {
            // Bridge file deleted (e.g. by /wechat-sync) — stop forwarding to WeChat
            if (currentBridgeSessionId !== undefined) {
                currentBridgeSessionId = undefined;
                stopSessionWatch();
                logger.info('BridgeWatcher: bridge removed, stopped forwarding');
            }
            return;
        }
        if (bridge.sessionId !== currentBridgeSessionId) {
            currentBridgeSessionId = bridge.sessionId;
            startSessionWatch(bridge.sessionId, bridge.cwd);
            onBridgeAttach?.(bridge.sessionId, bridge.cwd);
        }
    }
    // -- Public API --
    function start() {
        checkBridge(); // immediate check on startup (daemon restart recovery)
        bridgePollTimer = setInterval(checkBridge, BRIDGE_POLL_MS);
    }
    /**
     * Call before claudeQuery. Prevents the watcher from pushing content that
     * will already be sent via the normal sendText response path.
     */
    function pause() {
        paused = true;
        if (sessionWatch?.debounceTimer) {
            clearTimeout(sessionWatch.debounceTimer);
            sessionWatch.debounceTimer = null;
        }
        logger.debug('BridgeWatcher: paused');
    }
    /**
     * Call after claudeQuery (in a finally block). Advances the file offset to
     * current EOF so that content written during the pause is not re-pushed.
     */
    function resume() {
        if (sessionWatch) {
            try {
                const size = statSync(sessionWatch.filePath).size;
                sessionWatch.fileOffset = size;
                sessionWatch.pendingBuffer = '';
                logger.debug('BridgeWatcher: resumed', { newOffset: size });
            }
            catch {
                // file may have been rotated — no-op
            }
        }
        paused = false;
    }
    function stop() {
        if (bridgePollTimer)
            clearInterval(bridgePollTimer);
        stopSessionWatch();
        logger.info('BridgeWatcher: stopped');
    }
    return { start, pause, resume, stop };
}
