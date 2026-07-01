import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentEventNormalizer } from '../src/agent-events.js';

test('Codex JSONL output normalizes into assistant and command events', () => {
  const normalizer = createAgentEventNormalizer('codex');
  const events = normalizer.consume('stdout', [
    JSON.stringify({ msg: { type: 'text', content: 'Inspecting repo' } }),
    JSON.stringify({ msg: { type: 'exec_approval_request', command: 'npm test' } }),
    JSON.stringify({ msg: { type: 'turn_complete' } }),
    '',
  ].join('\n'));
  assert.deepEqual(events.map((event) => event.type), ['message.assistant.delta', 'command.started', 'agent.done']);
  assert.equal(events[0].content, 'Inspecting repo');
  assert.equal(events[1].command, 'npm test');
});

test('Codex turn completion content is promoted to a final assistant event', () => {
  const normalizer = createAgentEventNormalizer('codex');
  const events = normalizer.consume('stdout', `${JSON.stringify({
    msg: {
      type: 'turn_complete',
      content: 'Final answer from Codex.',
      usage: { input_tokens: 9, output_tokens: 3 },
    },
  })}\n`);
  assert.deepEqual(events.map((event) => event.type), ['message.assistant.final', 'agent.done']);
  assert.equal(events[0].content, 'Final answer from Codex.');
  assert.deepEqual(events[0].usage, { input_tokens: 9, output_tokens: 3 });
});

test('Claude stream-json text deltas normalize into assistant events', () => {
  const normalizer = createAgentEventNormalizer('claude');
  const events = normalizer.consume('stdout', `${JSON.stringify({
    type: 'stream_event',
    event: {
      delta: {
        type: 'text_delta',
        text: 'Done.',
      },
    },
  })}\n`);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'message.assistant.delta');
  assert.equal(events[0].content, 'Done.');
});

test('Cursor/Composer stream-json tool calls normalize into tool events', () => {
  const normalizer = createAgentEventNormalizer('composer-cli');
  const events = normalizer.consume('stdout', `${JSON.stringify({
    type: 'tool_call',
    subtype: 'started',
    call_id: 'call-1',
    tool_call: {
      terminalToolCall: {
        args: {
          command: 'npm run build',
        },
      },
    },
  })}\n`);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'tool.started');
  assert.equal(events[0].command, 'npm run build');
  assert.equal(events[0].callId, 'call-1');
});

test('Gemini JSON response normalizes into final assistant event', () => {
  const normalizer = createAgentEventNormalizer('gemini-cli');
  const events = normalizer.consume('stdout', `${JSON.stringify({
    response: 'The build is healthy.',
    stats: {
      tools: {
        totalCalls: 2,
      },
    },
  })}\n`);
  assert.deepEqual(events.map((event) => event.type), ['message.assistant.final', 'agent.done']);
  assert.equal(events[0].content, 'The build is healthy.');
  assert.deepEqual(events[0].usage, { tools: { totalCalls: 2 } });
});
