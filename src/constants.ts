import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export const DATA_DIR = process.env.WCC_DATA_DIR || join(homedir(), '.wechat-remote-control');

// Claude Code reads CLAUDE_CONFIG_DIR to relocate ~/.claude/ (undocumented but
// supported, see anthropics/claude-code#3833). Honour it so transcripts are found.
export const CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
export const CLAUDE_PROJECTS_DIR = join(CLAUDE_CONFIG_DIR, 'projects');

// Claude Code encodes a project's cwd into its transcript dir name by replacing
// every char that is not an ASCII letter/digit or '-' with '-'. It is ASCII-only:
// a non-ASCII (e.g. CJK) path char maps to '-' (verified: ~/Documents/社会实践 →
// ...-Documents-----). Keep this byte-identical to detect.py's encode_cwd and the
// daemon's copy in src/index.js (which imports this very function).
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9-]/g, '-');
}

// Two transcript paths belong to the same project iff they share a parent directory
// (Claude stores all of a project's transcripts in one projects/<encoded-cwd>/ dir).
// This gates onStop's grace / same-project Stop acceptance — a foreign project's
// Stop must NOT be accepted as ours (it would forward another repo's reply to the IM).
export function isSameProjectDir(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return dirname(a) === dirname(b);
}

// OpenAI Codex CLI reads CODEX_HOME to relocate ~/.codex/ (documented). Honour it
// exactly as we honour CLAUDE_CONFIG_DIR so Codex rollout transcripts are found.
export const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), '.codex');
// Codex stores rollout transcripts under <CODEX_HOME>/sessions/YYYY/MM/DD/, named
// rollout-<ISO-ts>-<uuid>.jsonl. Unlike Claude Code there is no cwd-encoded dir.
export const CODEX_SESSIONS_DIR = join(CODEX_HOME, 'sessions');

// The supported coding agents this bridge can drive. Sessions default to 'claude'
// when no kind is recorded (backward compatibility with pre-Codex registries).
export type AgentKind = 'claude' | 'codex';
