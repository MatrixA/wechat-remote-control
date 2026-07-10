import { WeChatApi } from './api.js';
import {
  MessageItemType, MessageType, MessageState,
  type MessageItem, type OutboundMessage,
} from './types.js';
import { logger } from '../logger.js';

// The bridge only ever sends TEXT to the IM (assistant replies / status lines).
// The image/video/file senders + the whole CDN upload pipeline were never reached
// at runtime — the transport adapter calls sender.sendText exclusively — so they
// were removed. Re-add from git history if multimedia replies are ever needed.
export function createSender(api: WeChatApi, botAccountId: string) {
  let clientCounter = 0;

  function generateClientId(): string {
    return `wcc-${Date.now()}-${++clientCounter}`;
  }

  /** Send a single message item to a user. */
  async function sendItem(toUserId: string, contextToken: string, item: MessageItem): Promise<void> {
    const clientId = generateClientId();
    const msg: OutboundMessage = {
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

  async function sendText(toUserId: string, contextToken: string, text: string): Promise<void> {
    logger.info('Sending text message', { toUserId, textLength: text.length });
    await sendItem(toUserId, contextToken, {
      type: MessageItemType.TEXT,
      text_item: { text },
    });
    logger.info('Text message sent', { toUserId });
  }

  return { sendText };
}
