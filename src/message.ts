/**
 * Pure message / transcript helpers shared by the bridge (src/index.js) and unit
 * tests. Everything here is side-effect free (no I/O, no module state) so it can
 * be exercised directly. File reading stays in index.js; this module only
 * operates on already-parsed transcript entries and plain strings.
 */

export const MAX_MSG_LEN = 2048;

type TranscriptEntry = any;

/** Extract plain text from a Claude message `content` (string or block array). */
export function textFromContent(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b && b.type === 'text' && b.text)
      .map((b: any) => b.text)
      .join('');
  }
  return null;
}

/**
 * Find the assistant response to an injected user message in the transcript.
 * Returns { text, complete } where complete=true means the last assistant turn
 * had stop_reason==='end_turn' (natural completion), or null if no response found.
 * complete=false means CC was interrupted mid-loop and the text is partial.
 */
export function findResponseToInjected(
  entries: TranscriptEntry[],
  injectedText: string | null,
): { text: string; complete: boolean } | null {
  if (!injectedText) return null;
  let userIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === 'user') {
      const text = textFromContent(e.message?.content);
      if (text === injectedText) { userIdx = i; break; }
    }
  }
  if (userIdx === -1) return null;

  // In a multi-turn agentic loop the LAST end_turn entry holds the final response.
  let lastEndTurnText: string | null = null;
  let lastText: string | null = null;
  for (let i = userIdx + 1; i < entries.length; i++) {
    const e = entries[i];
    if (e.type === 'user' && typeof e.message?.content === 'string') break;
    if (e.type === 'assistant') {
      const t = textFromContent(e.message?.content);
      if (t) lastText = t;
      if (e.message?.stop_reason === 'end_turn' && t) lastEndTurnText = t;
    }
  }

  if (lastEndTurnText) return { text: lastEndTurnText, complete: true };
  if (lastText) return { text: lastText, complete: false };
  return null;
}

/**
 * Post-compaction fallback: the last complete (end_turn) assistant response in
 * the transcript. Used when the injected text was summarized away by compaction.
 */
export function findLastCompleteResponse(
  entries: TranscriptEntry[],
): { text: string; complete: boolean } | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === 'assistant' && e.message?.stop_reason === 'end_turn') {
      const t = textFromContent(e.message.content);
      if (t) return { text: t, complete: true };
    }
  }
  return null;
}

/** Does the transcript contain a user message whose text === `injectedText`? */
export function transcriptHasUserText(
  entries: TranscriptEntry[],
  injectedText: string | null,
): boolean {
  if (!injectedText) return false;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === 'user' && textFromContent(e.message?.content) === injectedText) return true;
  }
  return false;
}

/**
 * Split a long response into WeChat-sized chunks. Guarantees each chunk fits
 * within `maxLen` (with headroom for the caller's [i/n] prefix), prefers newline
 * boundaries, and balances ``` code fences across boundaries so neither half
 * renders as broken markdown.
 */
export function splitMessage(text: string, maxLen: number = MAX_MSG_LEN): string[] {
  if (text.length <= maxLen) return [text];
  // Reserve headroom for the fence markers added below and the caller's [i/n] prefix.
  const limit = Math.max(64, maxLen - 16);
  const chunks: string[] = [];
  let rem = text;
  while (rem.length > 0) {
    if (rem.length <= limit) { chunks.push(rem); break; }
    let idx = rem.lastIndexOf('\n', limit);
    if (idx < limit * 0.3) idx = limit;   // no nearby newline → hard split (guarantees ≤ limit)
    chunks.push(rem.slice(0, idx));
    rem = rem.slice(idx).replace(/^\n+/, '');
  }
  // If a chunk ends inside an open ``` fence, close it here and reopen at the
  // start of the next chunk, so neither half renders as a half-open code block.
  let inFence = false;
  for (let i = 0; i < chunks.length; i++) {
    let chunk = chunks[i];
    if (inFence) chunk = '```\n' + chunk;
    const endsInFence = ((chunk.match(/^```/gm) || []).length % 2) === 1;
    if (endsInFence) chunk = chunk + '\n```';
    chunks[i] = chunk;
    inFence = endsInFence;
  }
  return chunks;
}
