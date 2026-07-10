/** Escape the three characters that are significant in Telegram HTML text. */
export function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
/**
 * Render one non-fence line: inline code / links / bold from agent markdown
 * become Telegram HTML tags; everything else is escaped. Conservative on
 * purpose — single-asterisk italics are left literal (too many false positives
 * in agent output like "5*7"), and unpaired markers pass through as text, so a
 * miss degrades to the old plain-text look, never to a Telegram 400.
 */
function renderInline(raw) {
    // Pull inline code spans out first (on the raw line) so their contents are
    // never touched by the link/bold passes. NUL sentinels cannot occur in text.
    const codeSpans = [];
    let s = raw.replace(/`([^`]+)`/g, (_, code) => {
        codeSpans.push(`<code>${escapeHtml(code)}</code>`);
        return `\u0000${codeSpans.length - 1}\u0000`;
    });
    s = escapeHtml(s);
    // [label](http…) — escaped '&amp;' inside href is valid HTML.
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => `<a href="${url}">${label}</a>`);
    s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codeSpans[Number(i)]);
}
/**
 * Convert agent markdown (``` fences, `code`, **bold**, [links](url), #
 * headers) to Telegram HTML. Fenced blocks become <pre><code>…</code></pre>;
 * other lines get inline rendering via renderInline().
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
            const h = lines[i].match(/^#{1,6}\s+(.*)$/);
            out.push(h ? `<b>${renderInline(h[1])}</b>` : renderInline(lines[i]));
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
