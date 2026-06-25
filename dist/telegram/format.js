/** Escape the three characters that are significant in Telegram HTML text. */
export function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
/**
 * Convert plain text (possibly containing ``` fenced code blocks) to Telegram
 * HTML. Fenced blocks become <pre><code>…</code></pre>; everything else is
 * HTML-escaped. Assumes balanced fences within the input (splitMessage()
 * guarantees this per chunk).
 */
export function toTelegramHtml(text) {
    const lines = text.split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
        if (/^```/.test(lines[i])) {
            i++; // skip opening fence (and any language tag on it)
            const code = [];
            while (i < lines.length && !/^```/.test(lines[i])) {
                code.push(lines[i]);
                i++;
            }
            if (i < lines.length && /^```/.test(lines[i]))
                i++; // skip closing fence
            out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
        }
        else {
            out.push(escapeHtml(lines[i]));
            i++;
        }
    }
    return out.join('\n');
}
const MAX_CALLBACK_BYTES = 64;
/**
 * Build a Telegram inline keyboard from generic Button rows. Throws if any
 * callback payload exceeds Telegram's 64-byte limit (callers must index-encode,
 * never embed raw labels/ids).
 */
export function buildInlineKeyboard(rows) {
    for (const row of rows) {
        for (const b of row) {
            if (Buffer.byteLength(b.data, 'utf8') > MAX_CALLBACK_BYTES) {
                throw new Error(`callback_data exceeds ${MAX_CALLBACK_BYTES} bytes: ${b.data}`);
            }
        }
    }
    return {
        inline_keyboard: rows.map((row) => row.map((b) => ({ text: b.label, callback_data: b.data }))),
    };
}
