import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, '..', 'src', 'mcp-server.js');

// Minimal stub of the Orca HTTP API: records the last request and echoes a body.
function startStubApi() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      calls.push({
        method: req.method,
        url: req.url,
        lease: req.headers['x-orca-tool-lease'] || null,
        body: body || null,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, echoedUrl: req.url }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, calls, port: server.address().port });
    });
  });
}

// Drive the MCP server: write JSON-RPC lines, collect responses keyed by id.
function runMcp(env, requests) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [serverPath], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const responses = new Map();
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined && msg.id !== null) responses.set(msg.id, msg);
        } catch { /* ignore */ }
        const expectedIds = requests.filter((r) => r.id !== undefined).map((r) => r.id);
        if (expectedIds.every((id) => responses.has(id))) {
          child.kill();
          resolve(responses);
        }
      }
    });
    child.on('error', reject);
    setTimeout(() => { child.kill(); reject(new Error('mcp server timeout')); }, 8000);
    for (const req of requests) child.stdin.write(`${JSON.stringify(req)}\n`);
  });
}

function firstMcpResponseLine(input, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [serverPath], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const idx = buffer.indexOf('\n');
      if (idx >= 0) {
        child.kill();
        resolve(buffer.slice(0, idx).trim());
      }
    });
    child.on('error', reject);
    setTimeout(() => { child.kill(); reject(new Error('mcp response timeout')); }, 8000);
    child.stdin.write(`${input}\n`);
  });
}

test('Orca MCP server: initialize, tools/list, and a proxied tools/call', async () => {
  const { server, calls, port } = await startStubApi();
  const env = {
    ORCA_AGENT_TOOLS_BASE_URL: `http://127.0.0.1:${port}`,
    ORCA_TOOL_LEASE_TOKEN: 'lease-abc',
    ORCA_ROLE: 'executor',
    ORCA_LANE_ID: 'lane-123',
    ORCA_SESSION_ID: 'sess-9',
  };

  const responses = await runMcp(env, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' }, // notification, no reply
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'evidence__capture_screenshot',
        arguments: { body: { url: 'http://localhost:5173', modes: ['screenshot'] } },
      },
    },
  ]);

  server.close();

  // initialize
  const init = responses.get(1);
  assert.equal(init.result.serverInfo.name, 'orca');
  assert.equal(init.result.protocolVersion, '2024-11-05');
  assert.ok(init.result.capabilities.tools);

  // tools/list contains executor-role tools, names underscored, not dotted
  const tools = responses.get(2).result.tools;
  const names = tools.map((t) => t.name);
  assert.ok(names.includes('evidence__capture_screenshot'), 'screenshot tool exposed');
  assert.ok(names.includes('lane__heartbeat'), 'heartbeat tool exposed');
  assert.ok(!names.some((n) => n.includes('.')), 'no dotted MCP tool names');
  // executor role must NOT see dashboard-only tools like provider.configure
  assert.ok(!names.includes('provider__configure'), 'dashboard-only tool hidden from executor');

  // tools/call proxied to the API with the lease header and resolved laneId
  const callResult = responses.get(3).result;
  assert.equal(callResult.isError, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, '/api/lanes/lane-123/evidence'); // {laneId} from env
  assert.equal(calls[0].lease, 'lease-abc');
  assert.match(calls[0].body, /localhost:5173/);
});

test('Orca MCP server: supervisor role exposes inspection tools but no takeover or spawn tools', async () => {
  const { server, calls, port } = await startStubApi();
  const env = {
    ORCA_AGENT_TOOLS_BASE_URL: `http://127.0.0.1:${port}`,
    ORCA_TOOL_LEASE_TOKEN: 'lease-supervisor',
    ORCA_ROLE: 'supervisor',
    ORCA_PROJECT_ID: 'proj-1',
    ORCA_SESSION_ID: 'sess-1',
    ORCA_LANE_ID: 'lane-1',
  };

  try {
    const responses = await runMcp(env, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'lane__create',
          arguments: { body: { title: 'blocked', executorType: 'mock' } },
        },
      },
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'orchestrator__enroll',
          arguments: { body: { takeover: true } },
        },
      },
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'session__plan__update',
          arguments: { body: { goal: 'blocked' } },
        },
      },
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'orchestrator__thread__get',
          arguments: {},
        },
      },
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: {
          name: 'lane__terminal__tail',
          arguments: { laneId: 'lane-1', offset: 3, maxBytes: 128 },
        },
      },
      {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: {
          name: 'supervisor__resign',
          arguments: {},
        },
      },
    ]);

    const init = responses.get(1).result;
    assert.match(init.instructions, /SUPERVISOR/);
    assert.match(init.instructions, /lane__list \/ lane__get/);
    assert.match(init.instructions, /lane__terminal__tail/);

    const names = responses.get(2).result.tools.map((tool) => tool.name);
    for (const name of [
      'supervisor__overview',
      'supervisor__resign',
      'orchestrator__thread__get',
      'orchestrator__status',
      'lane__list',
      'lane__get',
      'lane__terminal__tail',
      'approval__list',
      'evidence__list',
      'evidence__latest',
      'session__supervisor_audit',
      'tailscale__status',
      'orca__setup_guide',
    ]) {
      assert.ok(names.includes(name), `${name} exposed to supervisor`);
    }
    for (const name of [
      'lane__create',
      'orchestrator__enroll',
      'orchestrator__message__send',
      'session__plan__update',
      'session__create',
      'capacity__set_policy',
      'session__worktree_policy__update',
      'settings__update',
      'task__add',
      'task__bulk_add',
      'task__update',
      'task__delete',
      'lane__heartbeat',
      'lane__submit',
      'approval__request',
      'tailscale__serve__configure',
    ]) {
      assert.equal(names.includes(name), false, `${name} hidden from supervisor`);
    }

    assert.equal(responses.get(3).result.isError, true);
    assert.match(responses.get(3).result.content[0].text, /Unknown or unavailable tool for role supervisor: lane\.create/);
    assert.equal(responses.get(4).result.isError, true);
    assert.match(responses.get(4).result.content[0].text, /Unknown or unavailable tool for role supervisor: orchestrator\.enroll/);
    assert.equal(responses.get(5).result.isError, true);
    assert.match(responses.get(5).result.content[0].text, /Unknown or unavailable tool for role supervisor: session\.plan\.update/);
    assert.equal(responses.get(6).result.isError, false);
    assert.equal(responses.get(7).result.isError, false);
    assert.equal(responses.get(8).result.isError, false);
    assert.equal(calls.length, 3);
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].url, '/api/sessions/sess-1/orchestrator');
    assert.equal(calls[0].lease, 'lease-supervisor');
    assert.equal(calls[1].method, 'GET');
    assert.equal(calls[1].url, '/api/lanes/lane-1/terminal-tail?offset=3&maxBytes=128');
    assert.equal(calls[1].lease, 'lease-supervisor');
    assert.equal(calls[2].method, 'POST');
    assert.equal(calls[2].url, '/api/supervisor/resign');
    assert.equal(calls[2].lease, 'lease-supervisor');
  } finally {
    server.close();
  }
});

test('Orca MCP server: initialize delivers role-specific operating rules', async () => {
  const { server, port } = await startStubApi();
  try {
    // Orchestrator connection (what a Codex/Claude desktop app gets when told to
    // "act as the orchestrator"): the rulebook must arrive at connect time.
    const orchResponses = await runMcp(
      { ORCA_AGENT_TOOLS_BASE_URL: `http://127.0.0.1:${port}`, ORCA_TOOL_LEASE_TOKEN: 'l', ORCA_ROLE: 'orchestrator' },
      [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }],
    );
    const orchInstr = orchResponses.get(1).result.instructions;
    assert.match(orchInstr, /ORCHESTRATOR/);
    assert.match(orchInstr, /session__next_action FIRST/);
    assert.match(orchInstr, /lane__create/);
    assert.match(orchInstr, /evidence/);
    assert.match(orchInstr, /nextAction/);

    // Executor connection gets executor rules, not orchestrator ones.
    const execResponses = await runMcp(
      { ORCA_AGENT_TOOLS_BASE_URL: `http://127.0.0.1:${port}`, ORCA_TOOL_LEASE_TOKEN: 'l', ORCA_ROLE: 'executor' },
      [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }],
    );
    const execInstr = execResponses.get(1).result.instructions;
    assert.match(execInstr, /EXECUTOR/);
    assert.match(execInstr, /lane__submit/);
    assert.ok(!/you own project\/session direction/i.test(execInstr), 'executor must not get orchestrator ownership rules');
  } finally {
    server.close();
  }
});

test('Orca MCP server: refusal body (with nextAction envelope) is surfaced as isError', async () => {
  // Stub that returns 409 with an envelope-shaped body.
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      calls.push(req.url);
      res.writeHead(409, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'out of order', nextAction: { nextRequiredTool: 'lane.heartbeat' } }));
    });
  });
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

  const responses = await runMcp(
    {
      ORCA_AGENT_TOOLS_BASE_URL: `http://127.0.0.1:${port}`,
      ORCA_TOOL_LEASE_TOKEN: 'lease-x',
      ORCA_ROLE: 'executor',
      ORCA_LANE_ID: 'lane-1',
      ORCA_SESSION_ID: 'sess-1',
    },
    [{ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'lane__heartbeat', arguments: {} } }],
  );
  server.close();

  const result = responses.get(7).result;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /nextRequiredTool/);
  assert.match(result.content[0].text, /lane\.heartbeat/);
});

test('Orca MCP server: a JSON-RPC batch gets a single array response (notifications omitted)', async () => {
  const firstLine = await new Promise((resolve, reject) => {
    const child = spawn('node', [serverPath], { env: { ...process.env, ORCA_ROLE: 'orchestrator' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const idx = buffer.indexOf('\n');
      if (idx >= 0) { child.kill(); resolve(buffer.slice(0, idx).trim()); }
    });
    child.on('error', reject);
    setTimeout(() => { child.kill(); reject(new Error('batch timeout')); }, 8000);
    // One line: a batch of two requests + one notification (no id).
    child.stdin.write(`${JSON.stringify([
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'ping' },
    ])}\n`);
  });
  const parsed = JSON.parse(firstLine);
  assert.ok(Array.isArray(parsed), 'batch response must be a single JSON array');
  assert.equal(parsed.length, 2, 'notification contributes no response');
  assert.deepEqual(parsed.map((r) => r.id).sort(), [1, 2]);
});

test('Orca MCP server: malformed JSON-RPC input returns protocol errors', async () => {
  const parseError = JSON.parse(await firstMcpResponseLine('{not-json'));
  assert.equal(parseError.id, null);
  assert.equal(parseError.error.code, -32700);

  const emptyBatch = JSON.parse(await firstMcpResponseLine('[]'));
  assert.equal(emptyBatch.id, null);
  assert.equal(emptyBatch.error.code, -32600);

  const nullId = JSON.parse(await firstMcpResponseLine(JSON.stringify({ jsonrpc: '2.0', id: null, method: 'ping' })));
  assert.equal(nullId.id, null);
  assert.deepEqual(nullId.result, {});
});
