/**
 * Pure message / transcript helpers shared by the bridge (src/index.js) and unit
 * tests. Everything here is side-effect free (no I/O, no module state) so it can
 * be exercised directly. File reading stays in index.js; this module only
 * operates on already-parsed transcript entries and plain strings.
 */
export declare const MAX_MSG_LEN = 2048;
type TranscriptEntry = any;
/** Extract plain text from a Claude message `content` (string or block array). */
export declare function textFromContent(content: unknown): string | null;
/**
 * Find the assistant response to an injected user message in the transcript.
 * Returns { text, complete } where complete=true means the last assistant turn
 * had stop_reason==='end_turn' (natural completion), or null if no response found.
 * complete=false means CC was interrupted mid-loop and the text is partial.
 */
export declare function findResponseToInjected(entries: TranscriptEntry[], injectedText: string | null): {
    text: string;
    complete: boolean;
} | null;
/** One mid-turn assistant text block; `uuids` are the transcript-line dedup keys. */
export interface InterimBlock {
    uuids: string[];
    text: string;
}
/**
 * Interim assistant text blocks of the injected turn: entries after the
 * injected-user anchor that carry text with stop_reason === 'tool_use' — i.e.
 * prose emitted before a tool call, which findResponseToInjected drops. The
 * strict comparison keeps the final response out (end_turn) and refuses
 * still-streaming lines (null). Adjacent lines of the same API message
 * (shared message.id) merge into one block.
 */
export declare function findInterimTexts(entries: TranscriptEntry[], injectedText: string | null): InterimBlock[];
/**
 * Post-compaction fallback: the last complete (end_turn) assistant response in
 * the transcript. Used when the injected text was summarized away by compaction.
 */
export declare function findLastCompleteResponse(entries: TranscriptEntry[]): {
    text: string;
    complete: boolean;
} | null;
/** Does the transcript contain a user message whose text === `injectedText`? */
export declare function transcriptHasUserText(entries: TranscriptEntry[], injectedText: string | null): boolean;
/**
 * Split a long response into WeChat-sized chunks. Guarantees each chunk fits
 * within `maxLen` (with headroom for the caller's [i/n] prefix), prefers newline
 * boundaries, and balances ``` code fences across boundaries so neither half
 * renders as broken markdown.
 */
export declare function splitMessage(text: string, maxLen?: number): string[];
export {};
