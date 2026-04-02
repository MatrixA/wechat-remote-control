import { MessageItemType, MessageType, MessageState } from './types.js';
import { logger } from '../logger.js';
export function createSender(api, botAccountId) {
    let clientCounter = 0;
    function generateClientId() {
        return `wcc-${Date.now()}-${++clientCounter}`;
    }
    async function sendText(toUserId, contextToken, text) {
        const clientId = generateClientId();
        const items = [
            {
                type: MessageItemType.TEXT,
                text_item: { text },
            },
        ];
        const msg = {
            from_user_id: botAccountId,
            to_user_id: toUserId,
            client_id: clientId,
            message_type: MessageType.BOT,
            message_state: MessageState.FINISH,
            context_token: contextToken,
            item_list: items,
        };
        logger.info('Sending text message', { toUserId, clientId, textLength: text.length });
        await api.sendMessage({ msg });
        logger.info('Text message sent', { toUserId, clientId });
    }
    return { sendText };
}
