import { randomBytes } from 'node:crypto';
import type {
  GetUpdatesResp,
  SendMessageReq,
} from './types.js';
import { logger } from '../logger.js';

/** Generate a random uint32 and return its base64 representation. */
function generateUin(): string {
  const buf = randomBytes(4);
  return buf.toString('base64');
}

export class WeChatApi {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly uin: string;

  constructor(token: string, baseUrl: string = 'https://ilinkai.weixin.qq.com') {
    if (baseUrl) {
      try {
        const url = new URL(baseUrl);
        const allowedHosts = ['weixin.qq.com', 'wechat.com'];
        const isAllowed = allowedHosts.some(h => url.hostname === h || url.hostname.endsWith('.' + h));
        if (url.protocol !== 'https:' || !isAllowed) {
          logger.warn('Untrusted baseUrl, using default', { baseUrl });
          baseUrl = 'https://ilinkai.weixin.qq.com';
        }
      } catch {
        logger.warn('Invalid baseUrl, using default', { baseUrl });
        baseUrl = 'https://ilinkai.weixin.qq.com';
      }
    }
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.uin = generateUin();
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.token}`,
      'AuthorizationType': 'ilink_bot_token',
      'X-WECHAT-UIN': this.uin,
    };
  }

  private async request<T>(
    path: string,
    body: unknown,
    timeoutMs: number = 15_000,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const url = `${this.baseUrl}/${path}`;

    logger.debug('API request', { url, body });

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
      }

      const json = (await res.json()) as T;
      logger.debug('API response', json);
      return json;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new Error(`Request to ${url} timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Long-poll for new messages. Timeout 35s for long-polling. */
  async getUpdates(buf?: string): Promise<GetUpdatesResp> {
    return this.request<GetUpdatesResp>(
      'ilink/bot/getupdates',
      buf ? { get_updates_buf: buf } : {},
      35_000,
    );
  }

  /** Send a message to a user. */
  async sendMessage(req: SendMessageReq): Promise<void> {
    await this.request('ilink/bot/sendmessage', req);
  }

  /** Fetch bot config (includes typing_ticket) for a given user. */
  async getConfig(
    ilinkUserId: string,
    contextToken: string,
  ): Promise<{ ret?: number; typing_ticket?: string }> {
    return this.request(
      'ilink/bot/getconfig',
      { ilink_user_id: ilinkUserId, context_token: contextToken },
      10_000,
    );
  }

  /** Send a typing indicator to a user. status=1 for typing, status=2 to cancel. */
  async sendTyping(
    toUserId: string,
    typingTicket: string,
    status: 1 | 2 = 1,
  ): Promise<void> {
    await this.request(
      'ilink/bot/sendtyping',
      {
        ilink_user_id: toUserId,
        typing_ticket: typingTicket,
        status,
      },
      10_000,
    );
  }
}
