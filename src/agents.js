/**
 * Agent-kind profiles for the wrc-bridge daemon.
 *
 * The bridge can drive two coding agents: Claude Code ('claude') and OpenAI
 * Codex CLI ('codex'). This module centralises the per-agent differences —
 * process name, config-dir resolution (env-aware), transcript discovery for
 * Codex, model lists, and slash-command classification — so src/index.js can
 * branch on `kind` without scattering agent-specific constants.
 *
 * Claude-specific transcript discovery (fd-scan, process-start-time matching)
 * stays in index.js untouched; this module only adds the Codex equivalents and
 * the static profile data. Sessions without a recorded `kind` default to
 * 'claude' for backward compatibility (see sessionKind).
 *
 * Pure Codex rollout parsers are imported from ../dist/codex.js (compiled from
 * src/codex.ts), matching the existing dist/ import pattern in index.js.
 */
import { readdirSync, readlinkSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  parseRollout,
  codexResponseToInjected,
  codexLastAgentMessage,
  codexLatestUserMessage,
  codexSessionMetaCwd,
  codexContextReplay,
} from '../dist/codex.js';

// ── Config-dir resolvers (env-aware, mirrors detect.py) ──────────────
const CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const CLAUDE_PROJECTS   = join(CLAUDE_CONFIG_DIR, 'projects');
const CODEX_HOME        = process.env.CODEX_HOME || join(homedir(), '.codex');
const CODEX_SESSIONS    = join(CODEX_HOME, 'sessions');

export { CLAUDE_PROJECTS, CODEX_SESSIONS };

// ── Model lists ──────────────────────────────────────────────────────
// Claude model identifiers (last verified 2026-06-18). Opus 4.8 is the current
// flagship; Sonnet 4.6 balances speed/intelligence; Haiku 4.5 is the fast tier.
export const CLAUDE_MODELS = [
  { id: 'claude-opus-4-8',           display: 'Opus 4.8',   short: 'opus'   },
  { id: 'claude-sonnet-4-6',         display: 'Sonnet 4.6', short: 'sonnet' },
  { id: 'claude-haiku-4-5-20251001', display: 'Haiku 4.5',  short: 'haiku'  },
];

// Codex model identifiers (developers.openai.com/codex/models). The picker also
// sets a reasoning effort; users can append one (e.g. "gpt-5.5 high").
export const CODEX_MODELS = [
  { id: 'gpt-5.5',             display: 'GPT-5.5',          short: '5.5'   },
  { id: 'gpt-5.4',             display: 'GPT-5.4',          short: '5.4'   },
  { id: 'gpt-5.4-mini',        display: 'GPT-5.4 mini',     short: 'mini'  },
  { id: 'gpt-5.3-codex-spark', display: 'GPT-5.3 Codex Spark', short: 'spark' },
];

export const CODEX_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'];

// ── Codex slash-command classification ───────────────────────────────
// Built-in Codex slash commands (handled by the codex CLI itself, never produce
// a forwardable transcript turn). Intercepted at bridge level like Claude's.
export const CODEX_BUILTIN_SLASH = new Set([
  'model', 'permissions', 'approve', 'compact', 'clear', 'new', 'archive',
  'copy', 'diff', 'exit', 'quit', 'experimental', 'memories', 'skills',
  'feedback', 'init', 'logout', 'mcp', 'mention', 'fast', 'plan', 'goal',
  'personality', 'ps', 'stop', 'clean', 'fork', 'side', 'btw', 'raw', 'resume',
  'review', 'status', 'debug-config', 'statusline', 'title', 'theme', 'ide',
  'keymap', 'vim', 'agent', 'apps', 'plugins', 'hooks', 'sandbox-add-read-dir',
]);

// Codex slash commands that require interactive TUI navigation (arrow keys /
// pickers) — cannot be driven meaningfully by injecting text from WeChat.
export const CODEX_TUI_ONLY = new Set([
  'permissions', 'experimental', 'memories', 'skills', 'personality', 'resume',
  'statusline', 'title', 'theme', 'keymap', 'agent', 'apps', 'plugins', 'hooks',
  'ide',
]);

// ── Codex transcript discovery ───────────────────────────────────────

/** Collect descendant PIDs via pgrep (works on Linux and macOS). */
import { execFileSync } from 'node:child_process';
function collectDescendants(rootPid) {
  const visited = new Set();
  const queue = [String(rootPid)];
  while (queue.length) {
    const pid = queue.shift();
    if (visited.has(pid)) continue;
    visited.add(pid);
    try {
      const children = execFileSync('pgrep', ['-P', pid], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim().split('\n').filter(Boolean);
      for (const c of children) queue.push(c);
    } catch {}
  }
  return visited;
}

/**
 * Find the rollout .jsonl held open by the codex process in a tmux pane, by
 * scanning open file descriptors: /proc/<pid>/fd on Linux, `lsof` on macOS.
 * Returns null when nothing matches — callers fall back to findLatestCodexRollout.
 */
function lsofCodexRollout(pid) {
  try {
    const out = execFileSync('lsof', ['-p', String(pid), '-Fn'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const line of out.split('\n')) {
      if (line[0] !== 'n') continue;          // -Fn prefixes file paths with 'n'
      const path = line.slice(1);
      if (path.endsWith('.jsonl') && path.startsWith(CODEX_SESSIONS)) return path;
    }
  } catch {}
  return null;
}

export function findCodexTranscriptByPid(panePid) {
  for (const pid of collectDescendants(panePid)) {
    let procFdReadable = false;
    try {
      const fds = readdirSync(`/proc/${pid}/fd`);
      procFdReadable = true;
      for (const fd of fds) {
        try {
          const target = readlinkSync(join(`/proc/${pid}/fd`, fd));
          if (target.endsWith('.jsonl') && target.startsWith(CODEX_SESSIONS)) {
            return target;
          }
        } catch {}
      }
    } catch {}
    if (!procFdReadable) {
      const viaLsof = lsofCodexRollout(pid);
      if (viaLsof) return viaLsof;
    }
  }
  return null;
}

/**
 * Newest rollout-*.jsonl under <CODEX_HOME>/sessions/ whose session_meta cwd
 * matches `cwd`. Avoids blindly picking the latest rollout when several codex
 * sessions share a date directory.
 */
export function findLatestCodexRollout(cwd) {
  let candidates = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
        try { candidates.push({ path: full, mtime: statSync(full).mtimeMs }); } catch {}
      }
    }
  };
  walk(CODEX_SESSIONS);
  candidates.sort((a, b) => b.mtime - a.mtime);
  for (const { path } of candidates) {
    if (!cwd || codexSessionMetaCwd(path) === cwd) return path;
  }
  // When a cwd was given but nothing matched, return null rather than mis-assign
  // an unrelated session's rollout (mirrors detect.py find_codex_transcript).
  return cwd ? null : (candidates[0]?.path ?? null);
}

// ── Profiles ─────────────────────────────────────────────────────────
const PROFILES = {
  claude: {
    kind: 'claude',
    comm: 'claude',
    transcriptRoot: CLAUDE_PROJECTS,
    models: CLAUDE_MODELS,
    hasStatusLine: true,
    hasNotification: true,
    hasQuiz: true,
  },
  codex: {
    kind: 'codex',
    comm: 'codex',
    transcriptRoot: CODEX_SESSIONS,
    models: CODEX_MODELS,
    builtinSlash: CODEX_BUILTIN_SLASH,
    tuiOnly: CODEX_TUI_ONLY,
    hasStatusLine: false,
    hasNotification: false,
    hasQuiz: false,
    // Pure parsers (from dist/codex.js)
    parseRollout,
    responseToInjected: codexResponseToInjected,
    lastAgentMessage: codexLastAgentMessage,
    latestUserMessage: codexLatestUserMessage,
    contextReplay: codexContextReplay,
    findTranscriptByPid: findCodexTranscriptByPid,
    findLatestTranscript: findLatestCodexRollout,
  },
};

/** Normalise a session entry's kind, defaulting to 'claude'. */
export function sessionKind(s) {
  return (s && s.kind) || 'claude';
}

/** Return the profile for a kind (defaults to claude for unknown values). */
export function getAgent(kind) {
  return PROFILES[kind] || PROFILES.claude;
}

/** Resolve a model selection string against a kind's model list. */
export function resolveModelFor(kind, input) {
  const models = getAgent(kind).models;
  const s = String(input).trim().toLowerCase();
  const num = parseInt(s, 10);
  if (!isNaN(num) && num >= 1 && num <= models.length) return models[num - 1];
  return models.find((m) =>
    m.short === s || m.id === s || m.id.includes(s) || m.display.toLowerCase().includes(s),
  ) ?? null;
}
