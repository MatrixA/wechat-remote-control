/**
 * Pure parsers for OpenAI Codex CLI rollout transcripts.
 *
 * Codex stores each session as a JSONL "rollout" file under
 * <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<ISO-ts>-<uuid>.jsonl.
 * Every line is an object { timestamp, type, payload }. The shapes we care
 * about (verified against codex-cli 0.124.0):
 *
 *   { type: 'session_meta',  payload: { id, cwd, cli_version, ... } }
 *   { type: 'event_msg',     payload: { type: 'user_message',  message } }
 *   { type: 'event_msg',     payload: { type: 'agent_message', message, phase } }
 *   { type: 'event_msg',     payload: { type: 'task_complete', last_agent_message, turn_id } }
 *   { type: 'response_item', payload: { type: 'message', role, content: [{ type, text }] } }
 *   { type: 'response_item', payload: { type: 'function_call' | 'reasoning' | ... } }
 *
 * Codex's rollout format is explicitly "not a stable interface" per the hooks
 * docs, so these parsers are defensive: unknown lines are ignored, and the
 * authoritative response is taken from task_complete / final-answer events.
 *
 * NOTE: this module is compiled to dist/codex.js so the plain-JS bridge daemon
 * (src/index.js, run directly by node) can import it like the other dist/ modules.
 */
import { readFileSync } from 'node:fs';

export interface CodexEntry {
  timestamp?: string;
  type?: string;
  payload?: any;
}

/** Read and JSON-parse a rollout file into entries; tolerant of bad lines. */
export function parseRollout(filePath: string): CodexEntry[] {
  try {
    const raw = readFileSync(filePath, 'utf8').trim();
    if (!raw) return [];
    return raw
      .split('\n')
      .map((l) => {
        try {
          return JSON.parse(l) as CodexEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is CodexEntry => e != null);
  } catch {
    return [];
  }
}

function payloadType(e: CodexEntry): string | null {
  const p = e.payload;
  return p && typeof p === 'object' ? (p.type ?? null) : null;
}

/** Extract assistant text from a response_item/message (role assistant). */
function assistantTextFromResponseItem(e: CodexEntry): string | null {
  const p = e.payload;
  if (!p || p.type !== 'message' || p.role !== 'assistant') return null;
  const content = p.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = content
      .filter((b: any) => b && (b.type === 'output_text' || b.type === 'text') && typeof b.text === 'string')
      .map((b: any) => b.text as string)
      .join('');
    return text || null;
  }
  return null;
}

/** The most recent user-typed prompt (event_msg/user_message), or null. */
export function codexLatestUserMessage(entries: CodexEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === 'event_msg' && payloadType(e) === 'user_message') {
      const m = e.payload?.message;
      if (typeof m === 'string') return m;
    }
  }
  return null;
}

/**
 * The latest completed assistant answer in the rollout.
 * Prefers task_complete.last_agent_message, then a final-answer agent_message,
 * then the last assistant response_item/message.
 */
export function codexLastAgentMessage(entries: CodexEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === 'event_msg' && payloadType(e) === 'task_complete') {
      const m = e.payload?.last_agent_message;
      if (typeof m === 'string' && m.trim()) return m;
    }
  }
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === 'event_msg' && payloadType(e) === 'agent_message') {
      const m = e.payload?.message;
      if (typeof m === 'string' && m.trim()) return m;
    }
  }
  for (let i = entries.length - 1; i >= 0; i--) {
    const t = assistantTextFromResponseItem(entries[i]);
    if (t && t.trim()) return t;
  }
  return null;
}

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
export function codexResponseToInjected(
  entries: CodexEntry[],
  injectedText: string | null,
): { text: string; complete: boolean } | null {
  if (!injectedText) return null;

  let userIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === 'event_msg' && payloadType(e) === 'user_message' && e.payload?.message === injectedText) {
      userIdx = i;
      break;
    }
  }
  if (userIdx === -1) return null;

  let lastAgentText: string | null = null;
  let lastCompleteText: string | null = null;
  for (let i = userIdx + 1; i < entries.length; i++) {
    const e = entries[i];
    // A new user_message after ours ends our window.
    if (e.type === 'event_msg' && payloadType(e) === 'user_message') break;

    if (e.type === 'event_msg' && payloadType(e) === 'agent_message') {
      const m = e.payload?.message;
      if (typeof m === 'string' && m.trim()) {
        lastAgentText = m;
        if (e.payload?.phase === 'final_answer') lastCompleteText = m;
      }
    } else if (e.type === 'event_msg' && payloadType(e) === 'task_complete') {
      const m = e.payload?.last_agent_message;
      if (typeof m === 'string' && m.trim()) {
        lastAgentText = m;
        lastCompleteText = m;
      } else if (lastAgentText) {
        // task_complete with no message but we have streamed agent text → complete.
        lastCompleteText = lastAgentText;
      }
    } else {
      const t = assistantTextFromResponseItem(e);
      if (t && t.trim()) lastAgentText = t;
    }
  }

  if (lastCompleteText) return { text: lastCompleteText, complete: true };
  if (lastAgentText) return { text: lastAgentText, complete: false };
  return null;
}

/** The cwd recorded in the rollout's session_meta line, or null. */
export function codexSessionMetaCwd(filePath: string): string | null {
  try {
    const raw = readFileSync(filePath, 'utf8');
    const nl = raw.indexOf('\n');
    const firstLine = nl === -1 ? raw : raw.slice(0, nl);
    const obj = JSON.parse(firstLine) as CodexEntry;
    if (obj.type === 'session_meta' && obj.payload && typeof obj.payload.cwd === 'string') {
      return obj.payload.cwd;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Format the last N user↔assistant rounds for a session-switch context replay.
 * Mirrors the Claude bridge's getContextReplay output shape.
 */
export function codexContextReplay(entries: CodexEntry[], rounds = 3): string {
  const pairs: { user: string | null; assistant: string }[] = [];

  // Walk forward collecting (user_message → following agent answer) pairs.
  let pendingUser: string | null = null;
  for (const e of entries) {
    if (e.type !== 'event_msg') continue;
    const pt = payloadType(e);
    if (pt === 'user_message' && typeof e.payload?.message === 'string') {
      pendingUser = e.payload.message;
    } else if (pt === 'agent_message' && e.payload?.phase === 'final_answer' && typeof e.payload?.message === 'string') {
      pairs.push({ user: pendingUser, assistant: e.payload.message });
      pendingUser = null;
    } else if (pt === 'task_complete' && typeof e.payload?.last_agent_message === 'string' && e.payload.last_agent_message.trim()) {
      pairs.push({ user: pendingUser, assistant: e.payload.last_agent_message });
      pendingUser = null;
    }
  }

  const tail = pairs.slice(-rounds);
  if (tail.length === 0) return '（暂无对话记录）';
  const lines = [`📜 最近 ${tail.length} 轮对话:`];
  for (const { user, assistant } of tail) {
    if (user) lines.push(`\n👤 ${user.slice(0, 150)}`);
    lines.push(`🤖 ${assistant.slice(0, 400)}`);
  }
  return lines.join('\n');
}
