import { test } from 'node:test';
import assert from 'node:assert';

import {
  sessionKeyFor, newSessionState, resetSidCounter,
  resolveSessionForHook, resolveSessionForInbound,
  persistableState, migrateLegacyIlink, planTopicSync,
} from '../sessions.js';
import type { Registry, SessionState } from '../sessions.js';
import { decodeTarget, encodeTarget } from '../telegram/transport.js';

function reg(overrides: Partial<Registry> = {}): Registry {
  return {
    active: 'alpha',
    sessions: {
      alpha: { tmux: 'main:1.0', paneId: '%1', cwd: '/home/u/alpha', transcriptPath: '/t/p-alpha/a.jsonl', kind: 'claude' },
      beta:  { tmux: 'main:2.0', paneId: '%2', cwd: '/home/u/beta',  transcriptPath: '/t/p-beta/b.jsonl',  kind: 'codex'  },
    },
    ...overrides,
  };
}

function state(name: string, patch: Partial<SessionState> = {}): SessionState {
  const s = newSessionState(`key-${name}`, name);
  return Object.assign(s, patch);
}

// ── sessionKeyFor ──

test('sessionKeyFor prefers paneId, falls back to tmux coordinates', () => {
  assert.strictEqual(sessionKeyFor({ paneId: '%7', tmux: 'a:1.0' }), '%7');
  assert.strictEqual(sessionKeyFor({ tmux: 'a:1.0' }), 'tmux:a:1.0');
});

// ── resolveSessionForHook ──

test('hook routing: pane id match is authoritative', () => {
  const r = resolveSessionForHook(reg(), [], { _tmuxPane: '%2', transcript_path: '/t/p-alpha/a.jsonl' });
  assert.deepStrictEqual(r, { name: 'beta', via: 'pane' });
});

test('hook routing: unmatched pane falls through to transcript match', () => {
  // A just-attached entry the scanner has not stamped yet.
  const r = resolveSessionForHook(reg(), [], { _tmuxPane: '%99', transcript_path: '/t/p-beta/b.jsonl' });
  assert.deepStrictEqual(r, { name: 'beta', via: 'transcript' });
});

test('hook routing: in-flight injected transcript beats nothing (scanner flip-flop)', () => {
  const st = state('alpha', { lastInjectedText: 'go', lastInjectedTranscript: '/t/p-alpha/rotated.jsonl' });
  const r = resolveSessionForHook(reg(), [st], { transcript_path: '/t/p-alpha/rotated.jsonl' });
  assert.deepStrictEqual(r, { name: 'alpha', via: 'inflight' });
});

test('hook routing: same-project fallback needs an in-flight Claude turn', () => {
  const idle = state('alpha');
  assert.strictEqual(
    resolveSessionForHook(reg({ active: 'beta' }), [idle], { transcript_path: '/t/p-alpha/new.jsonl' }),
    null,
  );
  const busy = state('alpha', { lastInjectedText: 'go' });
  const r = resolveSessionForHook(reg({ active: 'beta' }), [busy], { transcript_path: '/t/p-alpha/new.jsonl' });
  assert.deepStrictEqual(r, { name: 'alpha', via: 'project' });
});

test('hook routing: codex sessions never match by same-project dir', () => {
  const busy = state('beta', { lastInjectedText: 'go' });
  // /t/p-beta/other.jsonl shares beta's dir, but beta is codex → date dirs are not projects.
  const r = resolveSessionForHook(reg({ active: 'alpha' }), [busy], { transcript_path: '/t/p-beta/other.jsonl' });
  assert.strictEqual(r, null);
});

test('hook routing: payload without pane or transcript falls back to active', () => {
  assert.deepStrictEqual(resolveSessionForHook(reg(), [], {}), { name: 'alpha', via: 'active' });
  assert.strictEqual(resolveSessionForHook({ active: null, sessions: {} }, [], {}), null);
});

test('hook routing: foreign transcript resolves to nothing', () => {
  assert.strictEqual(resolveSessionForHook(reg(), [], { transcript_path: '/t/p-other/x.jsonl' }), null);
});

test('hook routing: duplicate transcript assignment prefers the active session', () => {
  const r = reg();
  r.sessions.beta.transcriptPath = r.sessions.alpha.transcriptPath;
  const hit = resolveSessionForHook(r, [], { transcript_path: '/t/p-alpha/a.jsonl' });
  assert.deepStrictEqual(hit, { name: 'alpha', via: 'transcript' });
});

// ── resolveSessionForInbound ──

test('inbound routing: topic target hits its session, others hit active', () => {
  const r = reg();
  r.sessions.beta.imTarget = '-100123:55';
  assert.deepStrictEqual(resolveSessionForInbound(r, '-100123:55'), { name: 'beta', viaTopic: true });
  assert.deepStrictEqual(resolveSessionForInbound(r, '42'), { name: 'alpha', viaTopic: false });
  assert.strictEqual(resolveSessionForInbound({ active: null, sessions: {} }, '42'), null);
});

// ── persistence & migration ──

test('persistableState round-trips the crash-recovery fields', () => {
  const st = state('alpha', {
    lastInjectedText: 'do it', lastInjectedTranscript: '/t/p-alpha/a.jsonl',
    injectedTarget: '42', injectedMessageId: '10',
  });
  assert.deepStrictEqual(persistableState(st), {
    name: 'alpha',
    lastInjectedText: 'do it',
    lastInjectedTranscript: '/t/p-alpha/a.jsonl',
    injectedTarget: '42',
    injectedMessageId: '10',
  });
});

test('migrateLegacyIlink attaches a legacy in-flight turn to the active session key', () => {
  const out = migrateLegacyIlink(
    { lastInjectedText: 'old turn', lastInjectedTranscript: '/t/p-alpha/a.jsonl', target: '42' },
    reg(),
  );
  assert.deepStrictEqual(Object.keys(out), ['%1']);
  assert.strictEqual(out['%1'].lastInjectedText, 'old turn');
  assert.strictEqual(out['%1'].injectedTarget, '42');
  // No in-flight fields → nothing to migrate.
  assert.deepStrictEqual(migrateLegacyIlink({ target: '42' }, reg()), {});
});

// ── planTopicSync ──

test('planTopicSync creates missing topics, reopens tombstones, renames drifted ones', () => {
  const r = reg({
    closedTopics: { beta: '-100123:55' },
  });
  r.sessions.alpha.imTarget = '-100123:11';
  r.sessions.alpha.topicName = 'alpha-old';
  const ops = planTopicSync(r);
  assert.deepStrictEqual(ops, [
    { op: 'rename', name: 'alpha', imTarget: '-100123:11' },
    { op: 'reopen', name: 'beta', imTarget: '-100123:55' },
  ]);
  // beta reappears bound → no ops for it; alpha in sync → no ops at all.
  r.sessions.alpha.topicName = 'alpha';
  r.sessions.beta.imTarget = '-100123:55';
  assert.deepStrictEqual(planTopicSync(r), []);
});

// ── telegram target codec ──

test('telegram target codec round-trips plain and topic targets', () => {
  assert.deepStrictEqual(decodeTarget('42'), { chatId: '42' });
  assert.deepStrictEqual(decodeTarget('-1001234:55'), { chatId: '-1001234', threadId: 55 });
  assert.strictEqual(encodeTarget('-1001234', 55), '-1001234:55');
  assert.strictEqual(encodeTarget('42'), '42');
  // Garbage after the colon degrades to a plain chat target, never NaN.
  assert.deepStrictEqual(decodeTarget('42:abc'), { chatId: '42:abc' });
});

// keep sid counter deterministic for any later test files sharing the process
resetSidCounter();

test('hook routing consumes a one-shot iterator safely (Map.values() caller)', () => {
  // The daemon passes sessionStates.values(); both the in-flight scan (2b) and
  // the same-project scan (3) must see the states even though the iterator can
  // only be consumed once.
  const busy = state('alpha', { lastInjectedText: 'go' });
  const m = new Map([[busy.key, busy]]);
  const r = resolveSessionForHook(reg({ active: 'beta' }), m.values(), { transcript_path: '/t/p-alpha/new.jsonl' });
  assert.deepStrictEqual(r, { name: 'alpha', via: 'project' });
});
