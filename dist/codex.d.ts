export interface CodexEntry {
    timestamp?: string;
    type?: string;
    payload?: any;
}
/** Read and JSON-parse a rollout file into entries; tolerant of bad lines. */
export declare function parseRollout(filePath: string): CodexEntry[];
/** The most recent user-typed prompt (event_msg/user_message), or null. */
export declare function codexLatestUserMessage(entries: CodexEntry[]): string | null;
/**
 * The latest completed assistant answer in the rollout.
 * Prefers task_complete.last_agent_message, then a final-answer agent_message,
 * then the last assistant response_item/message.
 */
export declare function codexLastAgentMessage(entries: CodexEntry[]): string | null;
/**
 * Find the assistant response to a specific injected user message.
 * Mirrors the Claude bridge's findResponseToInjected: locate the latest
 * user_message whose text equals injectedText, then take the last completed
 * agent answer after it.
 *
 * Returns { text, complete } or null. complete=true when a task_complete (or a
 * final-answer agent_message) was seen after the matched user message — i.e. the
 * turn finished naturally rather than being mid-flight.
 */
export declare function codexResponseToInjected(entries: CodexEntry[], injectedText: string | null): {
    text: string;
    complete: boolean;
} | null;
/** The cwd recorded in the rollout's session_meta line, or null. */
export declare function codexSessionMetaCwd(filePath: string): string | null;
/**
 * Format the last N user↔assistant rounds for a session-switch context replay.
 * Mirrors the Claude bridge's getContextReplay output shape.
 */
export declare function codexContextReplay(entries: CodexEntry[], rounds?: number): string;
