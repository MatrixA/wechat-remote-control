/**
 * Pure message / transcript helpers shared by the bridge (src/index.js) and unit
 * tests. Everything here is side-effect free (no I/O, no module state) so it can
 * be exercised directly. File reading stays in index.js; this module only
 * operates on already-parsed transcript entries and plain strings.
 */
export const MAX_MSG_LEN = 2048;
/** Extract plain text from a Claude message `content` (string or block array). */
export function textFromContent(content) {
    if (typeof content === 'string')
        return content;
    if (Array.isArray(content)) {
        return content
            .filter((b) => b && b.type === 'text' && b.text)
            .map((b) => b.text)
            .join('');
    }
    return null;
}
/** Index of the LAST user entry whose text === injectedText, or -1. */
function findInjectedUserIdx(entries, injectedText) {
    if (!injectedText)
        return -1;
    for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (e.type === 'user' && textFromContent(e.message?.content) === injectedText)
            return i;
    }
    return -1;
}
/**
 * Find the assistant response to an injected user message in the transcript.
 * Returns { text, complete } where complete=true means the last assistant turn
 * had stop_reason==='end_turn' (natural completion), or null if no response found.
 * complete=false means CC was interrupted mid-loop and the text is partial.
 */
export function findResponseToInjected(entries, injectedText) {
    const userIdx = findInjectedUserIdx(entries, injectedText);
    if (userIdx === -1)
        return null;
    // In a multi-turn agentic loop the LAST end_turn entry holds the final response.
    let lastEndTurnText = null;
    let lastText = null;
    for (let i = userIdx + 1; i < entries.length; i++) {
        const e = entries[i];
        if (e.type === 'user' && typeof e.message?.content === 'string')
            break;
        if (e.type === 'assistant') {
            const t = textFromContent(e.message?.content);
            if (t)
                lastText = t;
            if (e.message?.stop_reason === 'end_turn' && t)
                lastEndTurnText = t;
        }
    }
    if (lastEndTurnText)
        return { text: lastEndTurnText, complete: true };
    if (lastText)
        return { text: lastText, complete: false };
    return null;
}
/**
 * Interim assistant text blocks of the injected turn: entries after the
 * injected-user anchor that carry text with stop_reason === 'tool_use' — i.e.
 * prose emitted before a tool call, which findResponseToInjected drops. The
 * strict comparison keeps the final response out (end_turn) and refuses
 * still-streaming lines (null). Adjacent lines of the same API message
 * (shared message.id) merge into one block.
 */
export function findInterimTexts(entries, injectedText) {
    const userIdx = findInjectedUserIdx(entries, injectedText);
    if (userIdx === -1)
        return [];
    const blocks = [];
    // A text line joins the previous block only when BOTH belong to the same API
    // message AND every line in between did too — a thinking line of message N
    // must not glue N's text onto message N-1's block.
    let lastBlockMsgId = null;
    let runMsgId = null; // message.id of the uninterrupted assistant run
    for (let i = userIdx + 1; i < entries.length; i++) {
        const e = entries[i];
        if (e.type === 'user' && typeof e.message?.content === 'string')
            break;
        if (e.type !== 'assistant' || e.isSidechain === true) {
            runMsgId = null;
            continue;
        }
        const msgId = e.message?.id ?? null;
        if (msgId !== runMsgId) {
            runMsgId = msgId;
            if (msgId !== lastBlockMsgId)
                lastBlockMsgId = null;
        }
        const t = textFromContent(e.message?.content);
        if (!t || e.message?.stop_reason !== 'tool_use')
            continue;
        const last = blocks[blocks.length - 1];
        if (last && msgId && msgId === lastBlockMsgId) {
            last.text += t;
            last.uuids.push(e.uuid || msgId);
        }
        else {
            blocks.push({ uuids: [e.uuid || msgId || `idx:${i}`], text: t });
            lastBlockMsgId = msgId;
        }
    }
    return blocks;
}
/**
 * Post-compaction fallback: the last complete (end_turn) assistant response in
 * the transcript. Used when the injected text was summarized away by compaction.
 */
export function findLastCompleteResponse(entries) {
    for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (e.type === 'assistant' && e.message?.stop_reason === 'end_turn') {
            const t = textFromContent(e.message.content);
            if (t)
                return { text: t, complete: true };
        }
    }
    return null;
}
/** Does the transcript contain a user message whose text === `injectedText`? */
export function transcriptHasUserText(entries, injectedText) {
    if (!injectedText)
        return false;
    for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (e.type === 'user' && textFromContent(e.message?.content) === injectedText)
            return true;
    }
    return false;
}
/**
 * Split a long response into WeChat-sized chunks. Guarantees each chunk fits
 * within `maxLen` (with headroom for the caller's [i/n] prefix), prefers newline
 * boundaries, and balances ``` code fences across boundaries so neither half
 * renders as broken markdown.
 */
export function splitMessage(text, maxLen = MAX_MSG_LEN) {
    if (text.length <= maxLen)
        return [text];
    // Reserve headroom for the fence markers added below and the caller's [i/n] prefix.
    const limit = Math.max(64, maxLen - 16);
    const chunks = [];
    let rem = text;
    while (rem.length > 0) {
        if (rem.length <= limit) {
            chunks.push(rem);
            break;
        }
        let idx = rem.lastIndexOf('\n', limit);
        if (idx < limit * 0.3)
            idx = limit; // no nearby newline → hard split (guarantees ≤ limit)
        chunks.push(rem.slice(0, idx));
        rem = rem.slice(idx).replace(/^\n+/, '');
    }
    // If a chunk ends inside an open ``` fence, close it here and reopen at the
    // start of the next chunk, so neither half renders as a half-open code block.
    let inFence = false;
    for (let i = 0; i < chunks.length; i++) {
        let chunk = chunks[i];
        if (inFence)
            chunk = '```\n' + chunk;
        const endsInFence = ((chunk.match(/^```/gm) || []).length % 2) === 1;
        if (endsInFence)
            chunk = chunk + '\n```';
        chunks[i] = chunk;
        inFence = endsInFence;
    }
    return chunks;
}
