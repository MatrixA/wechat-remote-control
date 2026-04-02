import type { Session } from '../session.js';
export interface CommandContext {
    accountId: string;
    session: Session;
    updateSession: (partial: Partial<Session>) => void;
    clearSession: () => Session;
    getChatHistoryText?: (limit?: number) => string;
    rejectPendingPermission?: () => boolean;
    text: string;
}
export interface CommandResult {
    reply?: string;
    handled: boolean;
    claudePrompt?: string;
}
/**
 * Parse and dispatch a slash command.
 *
 * Supported commands:
 *   /help     - Show help text with all available commands
 *   /clear    - Clear the current session
 *   /model <name> - Update the session model
 *   /status   - Show current session info
 *   /skills   - List all installed skills
 *   /<skill>  - Invoke a skill by name (args are forwarded to Claude)
 */
export declare function routeCommand(ctx: CommandContext): CommandResult;
