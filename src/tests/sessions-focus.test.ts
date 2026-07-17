import { test } from 'node:test';
import assert from 'node:assert';

import {
  tmuxSessionOf, effectiveFocus, orderedSessionNames, sanitizeSessionName, planTopicSync,
} from '../sessions.js';
import type { Registry } from '../sessions.js';

// Two tmux sessions: alpha (2 panes) and bravo (1 pane).
function reg(overrides: Partial<Registry> = {}): Registry {
  return {
    active: 'a1',
    sessions: {
      a1: { tmux: 'alpha:1.0', paneId: '%1', cwd: '/h/a1', kind: 'claude' },
      a2: { tmux: 'alpha:2.0', paneId: '%2', cwd: '/h/a2', kind: 'claude' },
      b1: { tmux: 'bravo:1.0', paneId: '%3', cwd: '/h/b1', kind: 'codex' },
    },
    ...overrides,
  };
}

// ── pure helpers ──

test('tmuxSessionOf takes the segment before the first colon', () => {
  assert.strictEqual(tmuxSessionOf({ tmux: 'alpha:2.0' }), 'alpha');
});

test('effectiveFocus degrades to null when the focused tmux session has no live entries', () => {
  assert.strictEqual(effectiveFocus(reg()), null);
  assert.strictEqual(effectiveFocus(reg({ focusedTmuxSession: 'bravo' })), 'bravo');
  assert.strictEqual(effectiveFocus(reg({ focusedTmuxSession: 'gone' })), null);
});

test('orderedSessionNames groups by tmux session, focused group first', () => {
  assert.deepStrictEqual(orderedSessionNames(reg()), ['a1', 'a2', 'b1']);
  assert.deepStrictEqual(orderedSessionNames(reg({ focusedTmuxSession: 'bravo' })), ['b1', 'a1', 'a2']);
});

test('sanitizeSessionName swaps tmux separators for dashes, collapses and trims', () => {
  assert.strictEqual(sanitizeSessionName('a:b.c'), 'a-b-c');
  assert.strictEqual(sanitizeSessionName('  ok name  '), 'ok name');
  assert.strictEqual(sanitizeSessionName('a: '), 'a');
  assert.strictEqual(sanitizeSessionName('..::'), '');
});

// ── planTopicSync focus matrix ──

test('planTopicSync with focus: creates focused topics, removes out-of-focus ones, skips busy', () => {
  const r = reg({ focusedTmuxSession: 'alpha' });
  r.sessions.a1.imTarget = '-100:11'; r.sessions.a1.topicName = 'a1';
  r.sessions.b1.imTarget = '-100:33'; r.sessions.b1.topicName = 'b1';
  assert.deepStrictEqual(planTopicSync(r), [
    { op: 'create', name: 'a2', replay: false },
    { op: 'remove', name: 'b1', imTarget: '-100:33' },
  ]);
  // A busy out-of-focus session keeps its topic this pass (removal deferred).
  assert.deepStrictEqual(planTopicSync(r, new Set(['b1'])), [
    { op: 'create', name: 'a2', replay: false },
  ]);
});

test('planTopicSync with focus: hidden sessions get no topic and tombstones stay put', () => {
  const r = reg({ focusedTmuxSession: 'alpha', closedTopics: { b1: '-100:99' } });
  r.sessions.a1.imTarget = '-100:11'; r.sessions.a1.topicName = 'a1';
  r.sessions.a2.imTarget = '-100:22'; r.sessions.a2.topicName = 'a2';
  assert.deepStrictEqual(planTopicSync(r), []);
  assert.deepStrictEqual(r.closedTopics, { b1: '-100:99' });
});

test('planTopicSync flags a purged session for context replay on recreate', () => {
  const r = reg();
  r.sessions.a1.imTarget = '-100:11'; r.sessions.a1.topicName = 'a1';
  r.sessions.a2.imTarget = '-100:22'; r.sessions.a2.topicName = 'a2';
  r.sessions.b1.topicPurged = true;
  assert.deepStrictEqual(planTopicSync(r), [
    { op: 'create', name: 'b1', replay: true },
  ]);
});

test('planTopicSync never renames a hidden session\'s drifted topic', () => {
  const r = reg({ focusedTmuxSession: 'bravo' });
  r.sessions.a1.imTarget = '-100:11'; r.sessions.a1.topicName = 'stale';
  r.sessions.b1.imTarget = '-100:33'; r.sessions.b1.topicName = 'b1';
  // a1 busy → removal deferred, and its rename must NOT fire while hidden;
  // a2 hidden without a topic → nothing; b1 focused and in sync → nothing.
  assert.deepStrictEqual(planTopicSync(r, new Set(['a1'])), []);
});

test('planTopicSync treats a vanished focus as no filter at all', () => {
  const r = reg({ focusedTmuxSession: 'gone' });
  r.sessions.a1.imTarget = '-100:11'; r.sessions.a1.topicName = 'stale';
  r.sessions.a2.imTarget = '-100:22'; r.sessions.a2.topicName = 'a2';
  r.sessions.b1.imTarget = '-100:33'; r.sessions.b1.topicName = 'b1';
  assert.deepStrictEqual(planTopicSync(r), [
    { op: 'rename', name: 'a1', imTarget: '-100:11' },
  ]);
});
