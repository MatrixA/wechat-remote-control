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
 * Convert agent markdown (``` fences, `code`, **bold**, [links](url), #
 * headers) to Telegram HTML. Fenced blocks become <pre><code>…</code></pre>;
 * other lines get inline rendering via renderInline().
 */
export declare function toTelegramHtml(text: string): string;
/**
 * Find a safe split point for a long message: the end of the last line that
 * (a) keeps at least `headChars` characters in the head and (b) does not sit
 * inside a ``` fence. Returns -1 when no such boundary exists (short text, or
 * everything past headChars is inside one giant fence).
 */
export declare function findExpandableSplit(text: string, headChars: number): number;
/**
 * Render a long message so only a head stays visible and the remainder is
 * wrapped in an expandable blockquote (collapsed by default in the client).
 * Falls back to plain toTelegramHtml when no safe split point exists.
 */
export declare function toExpandableHtml(text: string, headChars?: number): string;
/**
 * Build a Telegram inline keyboard from generic Button rows. Callback buttons
 * throw if the payload exceeds Telegram's 64-byte limit (callers must
 * index-encode, never embed raw labels/ids); URL buttons pass through.
 */
export declare function buildInlineKeyboard(rows: Button[][]): TgInlineKeyboardMarkup;
