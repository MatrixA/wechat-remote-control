/**
 * Telegram transport adapter.
 *
 * Exposes the rich Bot API features the WeChat transport lacks (inline keyboards,
 * message editing, command menu, chat-action typing), behind the generic
 * Transport interface. Output is rendered as HTML; every send falls back to plain
 * text if the HTML payload is rejected (malformed entities or over-length), so an
 * odd agent response can never silently fail to deliver.
 */
import { TelegramApi } from './api.js';
import { createTelegramMonitor } from './monitor.js';
import { loadTelegramAccount } from './auth.js';
import { toTelegramHtml, buildInlineKeyboard } from './format.js';
import { logger } from '../logger.js';
import type {
  Transport, TransportCapabilities, SentMessage, Button, MenuCommand,
} from '../transport/types.js';
import type { TgInlineKeyboardMarkup } from './types.js';

const TYPING_REFRESH_MS = 4_000; // Telegram chat-action expires after ~5s

const CAPS: TransportCapabilities = {
  inlineKeyboards: true,
  editMessages: true,
  typingIndicator: true,
  commandMenu: true,
  // Telegram's hard limit is 4096. We chunk well under it to leave headroom for
  // HTML-escaping expansion (& < > grow to 4-5 chars). deliver() additionally
  // falls back to plain text if an escaped payload still exceeds the limit, so a
  // pathological escape-heavy chunk degrades gracefully rather than failing.
  maxMessageLen: 2800,
};

export function createTelegramTransport(): Transport {
  let api: TelegramApi | null = null;
  let monitor: ReturnType<typeof createTelegramMonitor> | null = null;
  let typingTimer: ReturnType<typeof setInterval> | null = null;

  function clearTypingTimer(): void {
    if (typingTimer) { clearInterval(typingTimer); typingTimer = null; }
  }

  /** Send text as HTML, falling back to plain text on a parse/length rejection. */
  async function deliver(chatId: string, text: string, reply_markup?: TgInlineKeyboardMarkup): Promise<SentMessage> {
    try {
      const msg = await api!.sendMessage(chatId, toTelegramHtml(text), { parse_mode: 'HTML', reply_markup });
      return { messageId: String(msg.message_id) };
    } catch (err) {
      logger.warn('Telegram HTML send failed, retrying as plain text', { error: err instanceof Error ? err.message : String(err) });
      const msg = await api!.sendMessage(chatId, text, { reply_markup });
      return { messageId: String(msg.message_id) };
    }
  }

  return {
    name: 'telegram',
    caps: CAPS,

    async start(onMessage, onEvent): Promise<void> {
      const account = loadTelegramAccount();
      if (!account?.botToken) {
        throw new Error('No Telegram bot token found. Run login --telegram first.');
      }
      api = new TelegramApi(account.botToken);

      // Confirm the token and learn the bot's @username for the ready banner.
      // The first connection to api.telegram.org on a flaky/throttled route
      // frequently resets or times out; retry a few times before giving up so a
      // transient startup failure doesn't kill the (otherwise resilient) daemon.
      let selfName = account.botUsername;
      const GETME_RETRIES = 8;
      let lastErr: unknown = null;
      for (let attempt = 1; attempt <= GETME_RETRIES; attempt++) {
        try {
          selfName = (await api.getMe()).username ?? selfName;
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          const m = err instanceof Error ? err.message : String(err);
          // A genuine auth rejection (401) will never succeed on retry — fail fast.
          if (m.includes('401') || m.toLowerCase().includes('unauthorized')) break;
          logger.warn('Telegram getMe failed, retrying', { attempt, retries: GETME_RETRIES, error: m });
          if (attempt < GETME_RETRIES) await new Promise((r) => setTimeout(r, 2_000));
        }
      }
      if (lastErr) {
        throw new Error(`Telegram token rejected: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
      }

      onEvent({ type: 'ready', selfName });

      monitor = createTelegramMonitor(api, account, onMessage);
      await monitor.run();
    },

    stop(): void {
      clearTypingTimer();
      monitor?.stop();
    },

    async sendText(target: string, text: string): Promise<SentMessage> {
      return deliver(target, text);
    },

    async editText(target: string, messageId: string, text: string): Promise<void> {
      try {
        await api!.editMessageText(target, Number(messageId), toTelegramHtml(text), { parse_mode: 'HTML' });
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        if (m.includes('not modified')) return; // identical content — harmless
        // Let the caller decide whether to fall back to a fresh send.
        throw err;
      }
    },

    async sendTyping(target: string, on: boolean): Promise<void> {
      if (!api) return;
      clearTypingTimer();
      if (!on) return;
      const send = () => api!.sendChatAction(target, 'typing').catch(() => {});
      send();
      typingTimer = setInterval(send, TYPING_REFRESH_MS);
    },

    async sendButtons(target: string, text: string, rows: Button[][]): Promise<SentMessage> {
      return deliver(target, text, buildInlineKeyboard(rows));
    },

    async answerCallback(replyToken: string, text?: string): Promise<void> {
      if (!api || !replyToken) return;
      await api.answerCallbackQuery(replyToken, text).catch(() => {});
    },

    async setCommandMenu(commands: MenuCommand[]): Promise<void> {
      if (!api) return;
      await api.setMyCommands(commands.map((c) => ({ command: c.command, description: c.description }))).catch((err) => {
        logger.warn('setMyCommands failed', { error: err instanceof Error ? err.message : String(err) });
      });
    },
  };
}
