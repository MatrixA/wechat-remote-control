/**
 * IM transport abstraction.
 *
 * The bridge core (src/index.js) drives a tmux-hosted coding agent and forwards
 * its output to an instant-messenger. WeChat was hard-coded throughout; this
 * interface lets a second IM (Telegram) plug in without the core knowing which
 * transport it talks to.
 *
 * The single most important idea: a reply destination is an OPAQUE `target`
 * string that only the transport understands. WeChat encodes its
 * `(userId, contextToken)` couple into one string; Telegram uses `String(chatId)`.
 * The core never parses `target` — it just hands it back to the transport.
 */

export interface TransportCapabilities {
  /** Inline tap-able keyboards (Telegram) vs numbered-text menus (WeChat). */
  inlineKeyboards: boolean;
  /** Can edit a previously sent message in place (Telegram). */
  editMessages: boolean;
  /** Supports a typing / chat-action indicator. */
  typingIndicator: boolean;
  /** Supports a persistent command menu (Telegram setMyCommands). */
  commandMenu: boolean;
  /**
   * Max characters per outbound message. Callers chunk with splitMessage() at
   * this size. WeChat 2048; Telegram 4096 (kept conservative for HTML escaping
   * headroom — see telegram/transport.ts).
   */
  maxMessageLen: number;
}

export type InboundKind = 'text' | 'callback' | 'unsupported_media';

/**
 * Normalised inbound message. Both transports map their native payload onto this
 * shape so the core handles one type.
 */
export interface InboundMessage {
  /** Opaque reply target (transport-specific encoding). */
  target: string;
  /** Token needed to acknowledge an interactive callback (Telegram callback_query.id); '' otherwise. */
  replyToken: string;
  /** User text to inject (voice ASR folded in for WeChat). Empty for callbacks / unsupported media. */
  text: string;
  kind: InboundKind;
  /** Present when kind === 'callback': the button's encoded payload. */
  callbackData?: string;
  /** A human-facing notice to send back (unsupported media, or a side-note alongside text). */
  mediaNote?: string;
  /** Stable per-user id, used for first-message welcome dedup and (Telegram) auth. */
  userKey: string;
}

/** One inline-keyboard button. `data` must be <= 64 UTF-8 bytes (Telegram limit). */
export interface Button {
  label: string;
  data: string;
}

/** Result of a send. `messageId` is set only when the transport supports editing. */
export interface SentMessage {
  messageId?: string;
}

/** A command menu entry (Telegram setMyCommands). */
export interface MenuCommand {
  command: string;
  description: string;
}

export type TransportEvent =
  | { type: 'session_expired'; detail?: string }
  | { type: 'ready'; selfName?: string };

export interface Transport {
  readonly name: 'wechat' | 'telegram';
  readonly caps: TransportCapabilities;

  /** Begin receiving. Resolves once the receive loop is wired; runs until stop(). */
  start(
    onMessage: (m: InboundMessage) => void,
    onEvent: (e: TransportEvent) => void,
  ): Promise<void>;
  stop(): void;

  sendText(target: string, text: string): Promise<SentMessage>;

  /** Edit a prior message. Only meaningful when caps.editMessages. */
  editText(target: string, messageId: string, text: string): Promise<void>;

  /** Show/hide a typing indicator. The transport owns its own refresh cadence. */
  sendTyping(target: string, on: boolean): Promise<void>;

  /** Send text with an inline keyboard. Only meaningful when caps.inlineKeyboards. */
  sendButtons(target: string, text: string, rows: Button[][]): Promise<SentMessage>;

  /** Acknowledge a button tap (clears the client spinner). No-op on WeChat. */
  answerCallback(replyToken: string, text?: string): Promise<void>;

  /** Register the bot command menu. No-op on WeChat. */
  setCommandMenu?(commands: MenuCommand[]): Promise<void>;
}
