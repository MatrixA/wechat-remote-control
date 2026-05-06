import { basename } from 'node:path';
import { MessageItemType, MessageType, MessageState, UploadMediaType, } from './types.js';
import { uploadMediaToCdn } from './cdn.js';
import { logger } from '../logger.js';
export function createSender(api, botAccountId) {
    let clientCounter = 0;
    function generateClientId() {
        return `wcc-${Date.now()}-${++clientCounter}`;
    }
    /**
     * Send a single message item to a user.
     */
    async function sendItem(toUserId, contextToken, item) {
        const clientId = generateClientId();
        const msg = {
            from_user_id: botAccountId,
            to_user_id: toUserId,
            client_id: clientId,
            message_type: MessageType.BOT,
            message_state: MessageState.FINISH,
            context_token: contextToken,
            item_list: [item],
        };
        await api.sendMessage({ msg });
    }
    async function sendText(toUserId, contextToken, text) {
        logger.info('Sending text message', { toUserId, textLength: text.length });
        await sendItem(toUserId, contextToken, {
            type: MessageItemType.TEXT,
            text_item: { text },
        });
        logger.info('Text message sent', { toUserId });
    }
    /**
     * Upload a local image file and send it to a user.
     */
    async function sendImage(toUserId, contextToken, filePath, caption) {
        logger.info('Sending image', { toUserId, filePath });
        // Send caption as a separate text message first (if provided)
        if (caption) {
            await sendText(toUserId, contextToken, caption);
        }
        const uploaded = await uploadMediaToCdn(api, filePath, toUserId, UploadMediaType.IMAGE);
        await sendItem(toUserId, contextToken, {
            type: MessageItemType.IMAGE,
            image_item: {
                media: {
                    encrypt_query_param: uploaded.downloadEncryptedQueryParam,
                    aes_key: Buffer.from(uploaded.aeskey).toString('base64'),
                    encrypt_type: 1,
                },
                mid_size: uploaded.fileSizeCiphertext,
            },
        });
        logger.info('Image sent', { toUserId, fileSize: uploaded.fileSize });
    }
    /**
     * Upload a local video file and send it to a user.
     */
    async function sendVideo(toUserId, contextToken, filePath, caption) {
        logger.info('Sending video', { toUserId, filePath });
        if (caption) {
            await sendText(toUserId, contextToken, caption);
        }
        const uploaded = await uploadMediaToCdn(api, filePath, toUserId, UploadMediaType.VIDEO);
        await sendItem(toUserId, contextToken, {
            type: MessageItemType.VIDEO,
            video_item: {
                media: {
                    encrypt_query_param: uploaded.downloadEncryptedQueryParam,
                    aes_key: Buffer.from(uploaded.aeskey).toString('base64'),
                    encrypt_type: 1,
                },
                video_size: uploaded.fileSizeCiphertext,
            },
        });
        logger.info('Video sent', { toUserId, fileSize: uploaded.fileSize });
    }
    /**
     * Upload a local file and send it as an attachment to a user.
     */
    async function sendFile(toUserId, contextToken, filePath, fileName, caption) {
        const name = fileName ?? basename(filePath);
        logger.info('Sending file', { toUserId, filePath, fileName: name });
        if (caption) {
            await sendText(toUserId, contextToken, caption);
        }
        const uploaded = await uploadMediaToCdn(api, filePath, toUserId, UploadMediaType.FILE);
        await sendItem(toUserId, contextToken, {
            type: MessageItemType.FILE,
            file_item: {
                media: {
                    encrypt_query_param: uploaded.downloadEncryptedQueryParam,
                    aes_key: Buffer.from(uploaded.aeskey).toString('base64'),
                    encrypt_type: 1,
                },
                file_name: name,
                len: String(uploaded.fileSize),
            },
        });
        logger.info('File sent', { toUserId, fileName: name, fileSize: uploaded.fileSize });
    }
    return { sendText, sendImage, sendVideo, sendFile };
}
