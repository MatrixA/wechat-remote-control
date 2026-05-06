import { createInterface } from 'node:readline';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { WeChatApi } from './wechat/api.js';
import { loadLatestAccount } from './wechat/accounts.js';
import { startQrLogin, waitForQrScan } from './wechat/login.js';
import { createMonitor } from './wechat/monitor.js';
import { createSender } from './wechat/send.js';
import { downloadImage, extractText, extractFirstImageUrl, extractFirstVoice, extractFirstFile, extractFirstVideo, downloadVoice, downloadFile, downloadVideo, } from './wechat/media.js';
import { MessageType, MessageItemType } from './wechat/types.js';
import { createSessionStore } from './session.js';
import { createPermissionBroker } from './permission.js';
import { routeCommand } from './commands/router.js';
import { claudeQuery } from './claude/provider.js';
import { readBridge, writeBridge } from './bridge.js';
import { createBridgeWatcher } from './bridge-watcher.js';
import { loadConfig, saveConfig } from './config.js';
import { logger } from './logger.js';
import { DATA_DIR } from './constants.js';
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const MAX_MESSAGE_LENGTH = 2048;
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
        // Try to split at a newline near the limit
        let splitIdx = remaining.lastIndexOf('\n', maxLen);
        if (splitIdx < maxLen * 0.3) {
            splitIdx = maxLen;
        }
        chunks.push(remaining.slice(0, splitIdx));
        remaining = remaining.slice(splitIdx).replace(/^\n+/, '');
    }
    return chunks;
}
function promptUser(question, defaultValue) {
    return new Promise((resolve) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const display = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
        rl.question(display, (answer) => {
            rl.close();
            resolve(answer.trim() || defaultValue || '');
        });
    });
}
/** Open a file using the platform's default application (secure: uses spawnSync) */
function openFile(filePath) {
    const platform = process.platform;
    let cmd;
    let args;
    if (platform === 'darwin') {
        cmd = 'open';
        args = [filePath];
    }
    else if (platform === 'win32') {
        cmd = 'cmd';
        args = ['/c', 'start', '', filePath];
    }
    else {
        // Linux: try xdg-open
        cmd = 'xdg-open';
        args = [filePath];
    }
    const result = spawnSync(cmd, args, { stdio: 'ignore' });
    if (result.error) {
        logger.warn('Failed to open file', { cmd, filePath, error: result.error.message });
    }
}
// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
async function runSetup() {
    mkdirSync(DATA_DIR, { recursive: true });
    const QR_PATH = join(DATA_DIR, 'qrcode.png');
    console.log('正在设置...\n');
    // Loop: generate QR → display → poll for scan → handle expiry → repeat
    while (true) {
        const { qrcodeUrl, qrcodeId } = await startQrLogin();
        const isHeadlessLinux = process.platform === 'linux' &&
            !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
        if (isHeadlessLinux) {
            // Headless Linux: display QR in terminal using qrcode-terminal
            try {
                const qrcodeTerminal = await import('qrcode-terminal');
                console.log('请用微信扫描下方二维码：\n');
                qrcodeTerminal.default.generate(qrcodeUrl, { small: true });
                console.log();
                console.log('二维码链接：', qrcodeUrl);
                console.log();
            }
            catch {
                logger.warn('qrcode-terminal not available, falling back to URL');
                console.log('无法在终端显示二维码，请访问链接：');
                console.log(qrcodeUrl);
                console.log();
            }
        }
        else {
            // macOS / Windows / GUI Linux: generate QR PNG and open with system viewer
            const QRCode = await import('qrcode');
            const pngData = await QRCode.toBuffer(qrcodeUrl, { type: 'png', width: 400, margin: 2 });
            writeFileSync(QR_PATH, pngData);
            openFile(QR_PATH);
            console.log('已打开二维码图片，请用微信扫描：');
            console.log(`图片路径: ${QR_PATH}\n`);
        }
        console.log('等待扫码绑定...');
        try {
            await waitForQrScan(qrcodeId);
            console.log('✅ 绑定成功!');
            break;
        }
        catch (err) {
            if (err.message?.includes('expired')) {
                console.log('⚠️ 二维码已过期，正在刷新...\n');
                continue;
            }
            throw err;
        }
    }
    // Clean up QR image
    try {
        unlinkSync(QR_PATH);
    }
    catch {
        logger.warn('Failed to clean up QR image', { path: QR_PATH });
    }
    const workingDir = await promptUser('请输入工作目录', process.cwd());
    const config = loadConfig();
    config.workingDirectory = workingDir;
    saveConfig(config);
    console.log('运行 npm run daemon -- start 启动服务');
}
// ---------------------------------------------------------------------------
// Daemon
// ---------------------------------------------------------------------------
async function runDaemon() {
    const config = loadConfig();
    const account = loadLatestAccount();
    if (!account) {
        console.error('未找到账号，请先运行 node dist/main.js setup');
        process.exit(1);
    }
    const api = new WeChatApi(account.botToken, account.baseUrl);
    const sessionStore = createSessionStore();
    const session = sessionStore.load(account.accountId);
    // Fix: backfill session workingDirectory from config if it's still the default process.cwd()
    if (config.workingDirectory && session.workingDirectory === process.cwd()) {
        session.workingDirectory = config.workingDirectory;
        sessionStore.save(account.accountId, session);
    }
    const sender = createSender(api, account.accountId);
    const sharedCtx = { lastContextToken: '' };
    const bridgeWatcher = createBridgeWatcher(account, sender, sharedCtx, (sessionId) => {
        // Clear in-memory sdkSessionId so the next WeChat message resumes from bridge
        if (session.sdkSessionId !== sessionId) {
            session.sdkSessionId = undefined;
            sessionStore.save(account.accountId, session);
            logger.info('Bridge attach detected, cleared sdkSessionId', { newBridgeSession: sessionId });
        }
    });
    bridgeWatcher.start();
    const permissionBroker = createPermissionBroker(async () => {
        try {
            await sender.sendText(account.userId ?? '', sharedCtx.lastContextToken, '⏰ 权限请求超时，已自动拒绝。');
        }
        catch {
            logger.warn('Failed to send permission timeout message');
        }
    });
    // -- Wire the monitor callbacks --
    const callbacks = {
        onMessage: async (msg) => {
            await handleMessage(msg, account, session, sessionStore, permissionBroker, sender, config, sharedCtx, bridgeWatcher);
        },
        onSessionExpired: () => {
            logger.warn('Session expired, will keep retrying...');
            console.error('⚠️ 微信会话已过期，请重新运行 setup 扫码绑定');
        },
    };
    const monitor = createMonitor(api, callbacks);
    // -- Graceful shutdown --
    function shutdown() {
        logger.info('Shutting down...');
        bridgeWatcher.stop();
        monitor.stop();
        process.exit(0);
    }
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    logger.info('Daemon started', { accountId: account.accountId });
    console.log(`已启动 (账号: ${account.accountId})`);
    await monitor.run();
}
// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------
async function handleMessage(msg, account, session, sessionStore, permissionBroker, sender, config, sharedCtx, bridgeWatcher) {
    // Filter: only user messages with required fields
    if (msg.message_type !== MessageType.USER)
        return;
    if (!msg.from_user_id || !msg.item_list)
        return;
    const contextToken = msg.context_token ?? '';
    const fromUserId = msg.from_user_id;
    sharedCtx.lastContextToken = contextToken;
    // Extract text and media from items
    const userText = extractTextFromItems(msg.item_list);
    const imageItem = extractFirstImageUrl(msg.item_list);
    const voiceItem = extractFirstVoice(msg.item_list);
    const fileItem = extractFirstFile(msg.item_list);
    const videoItem = extractFirstVideo(msg.item_list);
    // Concurrency guard: reject normal messages and /clear while processing
    // Safety net: auto-reset stale processing state after 5 minutes
    const STALE_PROCESSING_MS = 5 * 60 * 1000;
    if (session.state === 'processing' || session.state === 'waiting_permission') {
        const lastUserMsg = session.chatHistory?.filter(m => m.role === 'user').slice(-1)[0];
        const stateAge = lastUserMsg ? Date.now() - lastUserMsg.timestamp : Infinity;
        if (stateAge > STALE_PROCESSING_MS) {
            logger.warn('Stale processing state detected, auto-resetting to idle', {
                state: session.state,
                stateAgeMs: stateAge,
            });
            session.state = 'idle';
            sessionStore.save(account.accountId, session);
            // Fall through to handle the message normally
        }
    }
    if (session.state === 'processing') {
        if (userText.startsWith('/clear')) {
            await sender.sendText(fromUserId, contextToken, '⏳ 正在处理上一条消息，请稍后再清除会话');
        }
        else if (!userText.startsWith('/')) {
            await sender.sendText(fromUserId, contextToken, '⏳ 正在处理上一条消息，请稍后...');
        }
        // Allow /status and /help during processing (read-only)
        if (!userText.startsWith('/status') && !userText.startsWith('/help'))
            return;
    }
    // -- Grace period: catch late y/n after timeout --
    if (session.state === 'idle' && permissionBroker.isTimedOut(account.accountId)) {
        const lower = userText.toLowerCase();
        if (lower === 'y' || lower === 'yes' || lower === 'n' || lower === 'no') {
            permissionBroker.clearTimedOut(account.accountId);
            await sender.sendText(fromUserId, contextToken, '⏰ 权限请求已超时，请重新发送你的请求。');
            return;
        }
    }
    // -- Permission state handling --
    if (session.state === 'waiting_permission') {
        // Check if there's actually a pending permission (may be lost after restart)
        const pendingPerm = permissionBroker.getPending(account.accountId);
        if (!pendingPerm) {
            session.state = 'idle';
            sessionStore.save(account.accountId, session);
            await sender.sendText(fromUserId, contextToken, '⚠️ 权限请求已失效（可能因服务重启），请重新发送你的请求。');
            return;
        }
        const lower = userText.toLowerCase();
        if (lower === 'y' || lower === 'yes') {
            const resolved = permissionBroker.resolvePermission(account.accountId, true);
            await sender.sendText(fromUserId, contextToken, resolved ? '✅ 已允许' : '⚠️ 权限请求处理失败，可能已超时');
        }
        else if (lower === 'n' || lower === 'no') {
            const resolved = permissionBroker.resolvePermission(account.accountId, false);
            await sender.sendText(fromUserId, contextToken, resolved ? '❌ 已拒绝' : '⚠️ 权限请求处理失败，可能已超时');
        }
        else {
            await sender.sendText(fromUserId, contextToken, '正在等待权限审批，请回复 y 或 n。');
        }
        return;
    }
    // -- Command routing --
    if (userText.startsWith('/')) {
        const updateSession = (partial) => {
            Object.assign(session, partial);
            sessionStore.save(account.accountId, session);
        };
        const ctx = {
            accountId: account.accountId,
            session,
            updateSession,
            clearSession: () => sessionStore.clear(account.accountId),
            getChatHistoryText: (limit) => sessionStore.getChatHistoryText(session, limit),
            rejectPendingPermission: () => permissionBroker.rejectPending(account.accountId),
            text: userText,
        };
        const result = routeCommand(ctx);
        if (result.handled && result.reply) {
            await sender.sendText(fromUserId, contextToken, result.reply);
            return;
        }
        if (result.handled && result.claudePrompt) {
            // Fall through to send the claudePrompt to Claude
            await sendToClaude(result.claudePrompt, imageItem, fromUserId, contextToken, account, session, sessionStore, permissionBroker, sender, config, bridgeWatcher);
            return;
        }
        if (result.handled) {
            // Handled but no reply and no claudePrompt (shouldn't normally happen)
            return;
        }
        // Not handled, treat as normal message (fall through)
    }
    // -- Normal message -> Claude --
    // Process voice messages: use ASR text if available
    let effectiveText = userText;
    let voiceResult = null;
    if (voiceItem && !effectiveText) {
        voiceResult = await downloadVoice(voiceItem);
        if (voiceResult?.text) {
            effectiveText = voiceResult.text;
        }
    }
    // Process file/video attachments
    let fileMedia = null;
    let videoMedia = null;
    if (fileItem) {
        fileMedia = await downloadFile(fileItem);
    }
    if (videoItem) {
        videoMedia = await downloadVideo(videoItem);
    }
    const hasAnyContent = effectiveText || imageItem || voiceResult?.media || fileMedia || videoMedia;
    if (!hasAnyContent) {
        await sender.sendText(fromUserId, contextToken, '暂不支持此类型消息，请发送文字、语音、图片或文件');
        return;
    }
    // Build context text for non-text media
    const mediaParts = [];
    if (voiceResult?.media) {
        mediaParts.push(`[语音消息，音频文件: ${voiceResult.media.filePath}]`);
    }
    if (fileMedia) {
        mediaParts.push(`[文件: ${fileMedia.fileName ?? fileMedia.filePath}，本地路径: ${fileMedia.filePath}]`);
    }
    if (videoMedia) {
        mediaParts.push(`[视频文件: ${videoMedia.filePath}]`);
    }
    if (mediaParts.length > 0) {
        effectiveText = [effectiveText, ...mediaParts].filter(Boolean).join('\n');
    }
    await sendToClaude(effectiveText, imageItem, fromUserId, contextToken, account, session, sessionStore, permissionBroker, sender, config, bridgeWatcher);
}
function extractTextFromItems(items) {
    const texts = [];
    for (const item of items) {
        const text = extractText(item);
        if (text)
            texts.push(text);
        // Also extract voice ASR text if present
        if (item.type === MessageItemType.VOICE) {
            const voiceText = item.voice_item?.text ?? item.voice_item?.voice_text;
            if (voiceText)
                texts.push(voiceText);
        }
    }
    return texts.join('\n');
}
async function sendToClaude(userText, imageItem, fromUserId, contextToken, account, session, sessionStore, permissionBroker, sender, config, bridgeWatcher) {
    // Set state to processing
    session.state = 'processing';
    sessionStore.save(account.accountId, session);
    // Record user message in chat history
    sessionStore.addChatMessage(session, 'user', userText || '(媒体消息)');
    // Pause the bridge watcher so it doesn't forward content that we'll
    // send directly via sendText below (prevents duplicate messages).
    bridgeWatcher.pause();
    try {
        // Download image if present
        let images;
        if (imageItem) {
            const base64DataUri = await downloadImage(imageItem);
            if (base64DataUri) {
                // Convert data URI to the format Claude expects
                const matches = base64DataUri.match(/^data:([^;]+);base64,(.+)$/);
                if (matches) {
                    images = [
                        {
                            type: 'image',
                            source: {
                                type: 'base64',
                                media_type: matches[1],
                                data: matches[2],
                            },
                        },
                    ];
                }
            }
        }
        const effectivePermissionMode = session.permissionMode ?? config.permissionMode;
        const isAutoPermission = effectivePermissionMode === 'auto';
        // Map 'auto' to the SDK's underlying mode (use acceptEdits as base, but we override canUseTool)
        const sdkPermissionMode = isAutoPermission ? 'acceptEdits' : effectivePermissionMode;
        // If no existing WeChat session, try to resume from bridge (attached interactive session)
        const bridge = !session.sdkSessionId ? readBridge() : null;
        const resumeId = session.sdkSessionId ?? bridge?.sessionId;
        const effectiveCwd = bridge?.cwd ?? session.workingDirectory ?? config.workingDirectory;
        // If coming from bridge, sync the cwd into session so subsequent messages use the same dir
        if (bridge) {
            session.workingDirectory = effectiveCwd;
            sessionStore.save(account.accountId, session);
            logger.info('Resuming from bridge', { sessionId: bridge.sessionId, cwd: effectiveCwd });
        }
        const queryOptions = {
            prompt: userText || '请描述这张图片',
            cwd: effectiveCwd,
            resume: resumeId,
            model: session.model,
            permissionMode: sdkPermissionMode,
            images,
            onPermissionRequest: isAutoPermission
                ? async () => true // auto-approve all tools, skip broker
                : async (toolName, toolInput) => {
                    // Set state to waiting_permission
                    session.state = 'waiting_permission';
                    sessionStore.save(account.accountId, session);
                    // Create pending permission
                    const permissionPromise = permissionBroker.createPending(account.accountId, toolName, toolInput);
                    // Send permission message to WeChat
                    const perm = permissionBroker.getPending(account.accountId);
                    if (perm) {
                        const permMsg = permissionBroker.formatPendingMessage(perm);
                        await sender.sendText(fromUserId, contextToken, permMsg);
                    }
                    const allowed = await permissionPromise;
                    // Reset state after permission resolved
                    session.state = 'processing';
                    sessionStore.save(account.accountId, session);
                    return allowed;
                },
        };
        let result = await claudeQuery(queryOptions);
        // If resume failed (e.g. corrupted session), retry without resume
        if (result.error && queryOptions.resume) {
            logger.warn('Resume failed, retrying without resume', { error: result.error, sessionId: queryOptions.resume });
            queryOptions.resume = undefined;
            session.sdkSessionId = undefined;
            sessionStore.save(account.accountId, session);
            const retryResult = await claudeQuery(queryOptions);
            Object.assign(result, retryResult);
        }
        // Send result back to WeChat (show generic error to user, log details internally)
        if (result.error) {
            logger.error('Claude query error', { error: result.error });
            await sender.sendText(fromUserId, contextToken, '⚠️ Claude 处理请求时出错，请稍后重试。');
        }
        else if (result.text) {
            // Record assistant response in chat history
            sessionStore.addChatMessage(session, 'assistant', result.text);
            const chunks = splitMessage(result.text);
            for (const chunk of chunks) {
                await sender.sendText(fromUserId, contextToken, chunk);
            }
        }
        else {
            await sender.sendText(fromUserId, contextToken, 'ℹ️ Claude 无返回内容（可能因权限被拒而终止）');
        }
        // Update session with new SDK session ID
        session.sdkSessionId = result.sessionId || undefined;
        session.state = 'idle';
        sessionStore.save(account.accountId, session);
        // Keep bridge.json updated with latest WeChat session so /wechat-sync can find it
        if (result.sessionId) {
            writeBridge({ sessionId: result.sessionId, cwd: effectiveCwd, attachedAt: new Date().toISOString() });
        }
    }
    catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error('Error in sendToClaude', { error: errorMsg });
        await sender.sendText(fromUserId, contextToken, '⚠️ 处理消息时出错，请稍后重试。');
        // Reset state
        session.state = 'idle';
        sessionStore.save(account.accountId, session);
    }
    finally {
        // Always resume the watcher; resume() advances fileOffset past content
        // written during this query so it won't be re-pushed by the watcher.
        bridgeWatcher.resume();
    }
}
// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const command = process.argv[2];
if (command === 'setup') {
    runSetup().catch((err) => {
        logger.error('Setup failed', { error: err instanceof Error ? err.message : String(err) });
        console.error('设置失败:', err);
        process.exit(1);
    });
}
else {
    // 'start' or no argument
    runDaemon().catch((err) => {
        logger.error('Daemon start failed', { error: err instanceof Error ? err.message : String(err) });
        console.error('启动失败:', err);
        process.exit(1);
    });
}
