/**
 * Pure formatting helpers for Telegram (no I/O, unit-tested).
 *
 * Parse mode is HTML, not MarkdownV2: MarkdownV2 reserves 18 characters that each
 * need position-aware backslash escaping, and a single miss returns HTTP 400 (a
 * silent send failure for arbitrary agent output). HTML needs only three escapes
 * (& < >) with no positional special-casing.
 */
import type { Button } from '../transport/types.js';
import type { TgInlineKeyboardMarkup } from './types.js';
/** Escape the three characters that are significant in Telegram HTML text. */
export declare function escapeHtml(s: string): string;
/**
 * Convert plain text (possibly containing ``` fenced code blocks) to Telegram
 * HTML. Fenced blocks become <pre><code>…</code></pre>; everything else is
 * HTML-escaped. Assumes balanced fences within the input (splitMessage()
 * guarantees this per chunk).
 */
export declare function toTelegramHtml(text: string): string;
/**
 * Build a Telegram inline keyboard from generic Button rows. Throws if any
 * callback payload exceeds Telegram's 64-byte limit (callers must index-encode,
 * never embed raw labels/ids).
 */
export declare function buildInlineKeyboard(rows: Button[][]): TgInlineKeyboardMarkup;
