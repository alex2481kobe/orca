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
