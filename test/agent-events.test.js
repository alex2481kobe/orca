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

test('Codex current item.completed agent_message output becomes a chat response', () => {
  const normalizer = createAgentEventNormalizer('codex');
  const events = normalizer.consume('stdout', [
    JSON.stringify({ type: 'item.started', item: { id: 'call-1', type: 'mcp_tool_call', tool: 'orchestrator__status' } }),
    JSON.stringify({ type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: 'Final answer from current Codex JSONL.' } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 4 } }),
    '',
  ].join('\n'));
  assert.deepEqual(events.map((event) => event.type), ['tool.started', 'message.assistant.final', 'agent.done']);
  assert.equal(events[1].content, 'Final answer from current Codex JSONL.');
  assert.deepEqual(events[2].usage, { input_tokens: 10, output_tokens: 4 });
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

test('a single newline-free multi-MB chunk flushes a truncated event and never accumulates', () => {
  const MAX_EVENT_CONTENT = 12000;
  const MAX_PARTIAL_LINE = 64 * 1024;
  const normalizer = createAgentEventNormalizer('codex');

  // ~10MB with NO newline: previously this grew buffers[stream] unbounded.
  const giant = 'x'.repeat(10 * 1024 * 1024);
  const events = normalizer.consume('stdout', giant);

  // A truncated command.output event is emitted for the over-ceiling partial line...
  const outputs = events.filter((e) => e.type === 'command.output');
  assert.ok(outputs.length >= 1, 'expected a flushed command.output event');
  // ...and every emitted event's content respects the downstream MAX_EVENT_CONTENT cap
  // (proving no multi-MB payload leaked through, i.e. the buffer never exceeded the ceiling).
  for (const e of events) {
    assert.ok((e.content || '').length <= MAX_EVENT_CONTENT);
  }

  // Feeding another giant newline-free chunk produces its own bounded flush rather than
  // stacking on top of the first — the internal buffer was reset, not accumulated.
  const events2 = normalizer.consume('stdout', giant);
  assert.ok(events2.filter((e) => e.type === 'command.output').length >= 1);
  for (const e of events2) {
    assert.ok((e.content || '').length <= MAX_EVENT_CONTENT);
  }

  // The retained buffer was reset: a following newline-terminated marker flushes as ITSELF,
  // not prefixed by the previously-buffered megabytes.
  const marker = JSON.stringify({ msg: { type: 'text', content: 'still-here' } });
  const events3 = normalizer.consume('stdout', `${marker}\n`);
  assert.deepEqual(events3.map((e) => e.type), ['message.assistant.delta']);
  assert.equal(events3[0].content, 'still-here');

  // Cross-chunk accumulation is also capped: many sub-ceiling pieces that together exceed
  // the ceiling get flushed rather than retained forever.
  const piece = 'y'.repeat(20 * 1024); // < ceiling on its own
  let accumulated = [];
  for (let i = 0; i < 8; i += 1) {
    accumulated = accumulated.concat(normalizer.consume('stdout', piece));
  }
  assert.ok(accumulated.filter((e) => e.type === 'command.output').length >= 1);
  for (const e of accumulated) {
    assert.ok((e.content || '').length <= MAX_EVENT_CONTENT);
  }
  assert.ok(MAX_PARTIAL_LINE > 0);
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
