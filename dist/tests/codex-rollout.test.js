import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRollout, codexLatestUserMessage, codexLastAgentMessage, codexResponseToInjected, codexSessionMetaCwd, codexContextReplay, } from '../codex.js';
// A representative two-turn rollout in the verified codex-cli 0.124.0 schema.
const dir = mkdtempSync(join(tmpdir(), 'wrc-rollout-'));
const f = join(dir, 'rollout-test.jsonl');
const lines = [
    { type: 'session_meta', payload: { id: 'abc', cwd: '/work/proj' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'first question' } },
    { type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'xxx' } },
    { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{}' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'first answer', phase: 'final_answer' } },
    { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'first answer', turn_id: 't1' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'second question' } },
    { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'second answer', turn_id: 't2' } },
];
writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
test('parseRollout reads every JSONL line', () => {
    assert.strictEqual(parseRollout(f).length, lines.length);
});
test('codexSessionMetaCwd reads cwd from the session_meta line', () => {
    assert.strictEqual(codexSessionMetaCwd(f), '/work/proj');
});
test('codexLatestUserMessage returns the most recent user message', () => {
    assert.strictEqual(codexLatestUserMessage(parseRollout(f)), 'second question');
});
test('codexLastAgentMessage prefers the last task_complete', () => {
    assert.strictEqual(codexLastAgentMessage(parseRollout(f)), 'second answer');
});
test('codexResponseToInjected matches the response to a specific injected turn', () => {
    const e = parseRollout(f);
    assert.deepStrictEqual(codexResponseToInjected(e, 'first question'), { text: 'first answer', complete: true });
    assert.deepStrictEqual(codexResponseToInjected(e, 'second question'), { text: 'second answer', complete: true });
    assert.strictEqual(codexResponseToInjected(e, 'never injected'), null);
});
test('codexContextReplay formats recent rounds', () => {
    const out = codexContextReplay(parseRollout(f), 3);
    assert.match(out, /first question/);
    assert.match(out, /second answer/);
});
