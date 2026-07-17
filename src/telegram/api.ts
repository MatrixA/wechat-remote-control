/**
 * Telegram Bot API HTTP client.
 *
 * Mirrors the structure of WeChatApi (built-in fetch + AbortController), with one
 * critical difference: Telegram puts the bot token in the URL path
 * (`/bot<token>/<method>`). We therefore NEVER log the full URL — only the method
 * name — and expose redactUrl() for any defensive logging elsewhere.
 *
 * Rate limits: a 429 response carries parameters.retry_after (seconds). We sleep
 * and retry once (bounded) — enough to absorb the occasional edit-heavy burst
 * from live turn-status updates without turning the client into a retry loop.
 */
import type {
  TgResponse, TgUser, TgUpdate, TgMessage, TgChat, TgInlineKeyboardMarkup, TgBotCommand, TgForumTopic,
} from './types.js';
import { logger } from '../logger.js';

export const DEFAULT_TELEGRAM_BASE = 'https://api.telegram.org';

/** Strip the bot token from a Telegram API URL so it is safe to log. */
export function redactUrl(url: string): string {
  return url.replace(/\/bot[^/]+\//, '/bot***/');
}

const MAX_RETRY_AFTER_S = 30;

export interface SendMessageOpts {
  parse_mode?: 'HTML' | 'MarkdownV2';
  reply_markup?: TgInlineKeyboardMarkup;
  disable_web_page_preview?: boolean;
  /** Forum-topic thread to post into. */
  message_thread_id?: number;
}

export class TelegramApi {
  private readonly token: string;
  private readonly baseUrl: string;

  constructor(token: string, baseUrl: string = DEFAULT_TELEGRAM_BASE) {
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  private url(method: string): string {
    return `${this.baseUrl}/bot${this.token}/${method}`;
  }

  private async request<T>(method: string, body: unknown, timeoutMs = 15_000, retried = false): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // Log the method only — the URL contains the token.
    logger.debug('Telegram API request', { method });

    try {
      const res = await fetch(this.url(method), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const json = (await res.json()) as TgResponse<T>;
      if (!json.ok) {
        // 429: honour retry_after once (bounded) rather than failing the send.
        const retryAfter = json.error_code === 429 ? json.parameters?.retry_after : undefined;
        if (retryAfter && !retried) {
          const waitS = Math.min(retryAfter, MAX_RETRY_AFTER_S);
          logger.warn('Telegram 429, honouring retry_after', { method, waitS });
          clearTimeout(timer);
          await new Promise((r) => setTimeout(r, waitS * 1000));
          return this.request<T>(method, body, timeoutMs, true);
        }
        throw new Error(`Telegram ${method} failed: ${json.error_code ?? '?'} ${json.description ?? ''}`.trim());
      }
      return json.result as T;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new Error(`Telegram ${method} timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Confirm the token and return the bot's own user record. */
  getMe(): Promise<TgUser> {
    return this.request<TgUser>('getMe', {}, 10_000);
  }

  /** Long-poll for updates. The server holds the connection up to `timeout` seconds. */
  getUpdates(opts: { offset?: number; timeout?: number; allowed_updates?: string[] }): Promise<TgUpdate[]> {
    const timeout = opts.timeout ?? 30;
    return this.request<TgUpdate[]>(
      'getUpdates',
      { offset: opts.offset, timeout, allowed_updates: opts.allowed_updates },
      (timeout + 10) * 1000,
    );
  }

  getChat(chatId: string): Promise<TgChat> {
    return this.request<TgChat>('getChat', { chat_id: chatId }, 10_000);
  }

  sendMessage(chatId: string, text: string, opts: SendMessageOpts = {}): Promise<TgMessage> {
    return this.request<TgMessage>('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: opts.parse_mode,
      reply_markup: opts.reply_markup,
      disable_web_page_preview: opts.disable_web_page_preview ?? true,
      message_thread_id: opts.message_thread_id,
    });
  }

  editMessageText(chatId: string, messageId: number, text: string, opts: SendMessageOpts = {}): Promise<unknown> {
    return this.request('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: opts.parse_mode,
      reply_markup: opts.reply_markup,
      disable_web_page_preview: opts.disable_web_page_preview ?? true,
    });
  }

  sendChatAction(chatId: string, action = 'typing', threadId?: number): Promise<unknown> {
    return this.request('sendChatAction', { chat_id: chatId, action, message_thread_id: threadId }, 10_000);
  }

  setMyCommands(commands: TgBotCommand[]): Promise<unknown> {
    return this.request('setMyCommands', { commands }, 10_000);
  }

  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<unknown> {
    return this.request('answerCallbackQuery', { callback_query_id: callbackQueryId, text }, 10_000);
  }

  /**
   * React to a message with a single emoji (replaces the bot's prior reaction).
   * Only emoji from Telegram's fixed allowed set work — callers pick from it.
   */
  setMessageReaction(chatId: string, messageId: number, emoji?: string): Promise<unknown> {
    return this.request('setMessageReaction', {
      chat_id: chatId,
      message_id: messageId,
      reaction: emoji ? [{ type: 'emoji', emoji }] : [],
    }, 10_000);
  }

  // ── Forum topics ──
  createForumTopic(chatId: string, name: string): Promise<TgForumTopic> {
    return this.request<TgForumTopic>('createForumTopic', { chat_id: chatId, name }, 10_000);
  }

  editForumTopic(chatId: string, threadId: number, name: string): Promise<unknown> {
    return this.request('editForumTopic', { chat_id: chatId, message_thread_id: threadId, name }, 10_000);
  }

  closeForumTopic(chatId: string, threadId: number): Promise<unknown> {
    return this.request('closeForumTopic', { chat_id: chatId, message_thread_id: threadId }, 10_000);
  }

  reopenForumTopic(chatId: string, threadId: number): Promise<unknown> {
    return this.request('reopenForumTopic', { chat_id: chatId, message_thread_id: threadId }, 10_000);
  }

  /** Deletes the topic AND its message history — the thread id is dead afterwards. */
  deleteForumTopic(chatId: string, threadId: number): Promise<unknown> {
    return this.request('deleteForumTopic', { chat_id: chatId, message_thread_id: threadId }, 10_000);
  }

  /**
   * Upload a document (multipart/form-data — the one non-JSON request). Used
   * for very long responses that would otherwise arrive as many chunks.
   */
  async sendDocument(
    chatId: string,
    filename: string,
    content: string,
    opts: { caption?: string; message_thread_id?: number } = {},
  ): Promise<TgMessage> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    logger.debug('Telegram API request', { method: 'sendDocument' });
    try {
      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('document', new Blob([content], { type: 'text/markdown' }), filename);
      if (opts.caption) form.append('caption', opts.caption);
      if (opts.message_thread_id) form.append('message_thread_id', String(opts.message_thread_id));
      const res = await fetch(this.url('sendDocument'), {
        method: 'POST',
        body: form,
        signal: controller.signal,
      });
      const json = (await res.json()) as TgResponse<TgMessage>;
      if (!json.ok) {
        throw new Error(`Telegram sendDocument failed: ${json.error_code ?? '?'} ${json.description ?? ''}`.trim());
      }
      return json.result as TgMessage;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new Error('Telegram sendDocument timed out after 60000ms');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
