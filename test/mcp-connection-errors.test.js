// Stage 5 requirement 5: every failure a bridge can hit says what it tried, why
// it failed, and the one command that fixes it -- and the bridge re-mints and
// retries only a call the server refused before running it.
//
// Each case drives a real bridge process against a stub HTTP server (or a
// closed port) on loopback. No real Orca is involved.
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { ROOT, freePort, startBridge } from './helpers/bridge-client.js';

function startStub(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const entry = {
        method: req.method,
        url: req.url,
        lease: req.headers['x-orca-tool-lease'] || null,
        refresh: req.headers['x-orca-refresh-token'] || null,
        body,
      };
      seen.push(entry);
      handler(entry, req, res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({ base, seen, close: () => new Promise((done) => server.close(done)) });
    });
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const orchestratorEnv = (base, extra = {}) => ({ ORCA_AGENT_TOOLS_BASE_URL: base, ORCA_ROLE: 'orchestrator', ...extra });

test('R5: a stopped daemon names the URL it tried, the cause, and the command that starts it', async () => {
  const base = `http://127.0.0.1:${await freePort()}`;
  const bridge = startBridge(orchestratorEnv(base, { ORCA_REFRESH_TOKEN: 'refresh-x' }));
  try {
    const result = await bridge.callTool('orchestrator__list');
    assert.equal(result.isError, true);
    assert.ok(result.text.includes(base), `names the URL it tried:\n${result.text}`);
    assert.match(result.text, /not running|connection refused/i);
    assert.match(result.text, /Fix: .*orca-cli\.js'? start/);
    assert.ok(result.text.includes(ROOT), 'the fix names the Orca checkout to start from');
    assert.notEqual(result.text.trim(), 'Orca tool call failed: fetch failed');
  } finally {
    bridge.close();
  }
});

test('R5: something that is not Orca at the configured URL is named as such, with the fix', async () => {
  const stub = await startStub((entry, req, res) => {
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end('<html><body>Not Found</body></html>');
  });
  const bridge = startBridge(orchestratorEnv(stub.base, { ORCA_TOOL_LEASE_TOKEN: 'lease-x' }));
  try {
    const result = await bridge.callTool('orchestrator__list');
    assert.equal(result.isError, true);
    assert.ok(result.text.includes(stub.base), result.text);
    assert.match(result.text, /not Orca/i);
    assert.match(result.text, /Fix: .*connect/);
  } finally {
    bridge.close();
    await stub.close();
  }
});

test('R5: an expired fixed lease with no refresh credential says it cannot renew, and names the command', async () => {
  const stub = await startStub((entry, req, res) => json(res, 401, { error: 'Tool lease has expired.' }));
  const bridge = startBridge(orchestratorEnv(stub.base, { ORCA_TOOL_LEASE_TOKEN: 'old-fixed-lease' }));
  try {
    const result = await bridge.callTool('orchestrator__list');
    assert.equal(result.isError, true);
    assert.match(result.text, /Tool lease has expired\./, 'keeps the server\'s reason');
    assert.match(result.text, /ORCA_REFRESH_TOKEN/);
    assert.match(result.text, /Fix: .*orca-cli\.js'? connect claude/);
  } finally {
    bridge.close();
    await stub.close();
  }
});

test('R5: a revoked client credential says so and names the command that reconnects', async () => {
  const stub = await startStub((entry, req, res) => {
    if (entry.url === '/api/agent-tools/leases/refresh') return json(res, 401, { error: 'Refresh credential has been revoked.' });
    return json(res, 401, { error: 'Tool lease not found.' });
  });
  const bridge = startBridge(orchestratorEnv(stub.base, { ORCA_REFRESH_TOKEN: 'revoked-credential' }));
  try {
    const result = await bridge.callTool('orchestrator__list');
    assert.equal(result.isError, true);
    assert.match(result.text, /revoked/);
    assert.match(result.text, /Fix: .*connect claude/);
    assert.equal(result.text.includes('revoked-credential'), false, 'never prints the credential');
  } finally {
    bridge.close();
    await stub.close();
  }
});

test('R2/R5: a call refused for a lapsed lease is re-minted and repeated exactly once, with the same payload', async () => {
  let minted = 0;
  const stub = await startStub((entry, req, res) => {
    if (entry.url === '/api/agent-tools/leases/refresh') {
      minted += 1;
      return json(res, 201, { lease: { id: `lease-${minted}` }, leaseToken: `L${minted}` });
    }
    if (entry.lease === 'L2') return json(res, 200, { id: 'orc_ok' });
    return json(res, 401, { error: 'Tool lease has expired.' });
  });
  const bridge = startBridge(orchestratorEnv(stub.base, { ORCA_REFRESH_TOKEN: 'R' }));
  try {
    const result = await bridge.callTool('orchestrator__register', { body: { cwd: '/work', title: 'once' } });
    assert.equal(result.isError, false, result.text);
    const posts = stub.seen.filter((entry) => entry.url === '/api/orchestrators');
    assert.equal(posts.length, 2, 'the refused call, then one repeat');
    assert.deepEqual(posts.map((entry) => entry.lease), ['L1', 'L2']);
    assert.equal(posts[0].body, posts[1].body);
    assert.equal(stub.seen.filter((entry) => entry.url === '/api/agent-tools/leases/refresh').length, 2);
    assert.ok(stub.seen.every((entry) => entry.refresh === null || entry.url === '/api/agent-tools/leases/refresh'),
      'the refresh credential is sent only to the refresh route');
  } finally {
    bridge.close();
    await stub.close();
  }
});

test('R5: the repeat happens at most once; a second refusal is reported, not retried', async () => {
  let minted = 0;
  const stub = await startStub((entry, req, res) => {
    if (entry.url === '/api/agent-tools/leases/refresh') {
      minted += 1;
      return json(res, 201, { lease: { id: `lease-${minted}` }, leaseToken: `L${minted}` });
    }
    return json(res, 401, { error: 'Tool lease has expired.' });
  });
  const bridge = startBridge(orchestratorEnv(stub.base, { ORCA_REFRESH_TOKEN: 'R' }));
  try {
    const result = await bridge.callTool('orchestrator__register', { body: { cwd: '/work' } });
    assert.equal(result.isError, true);
    assert.equal(stub.seen.filter((entry) => entry.url === '/api/orchestrators').length, 2);
    assert.match(result.text, /Fix: /);
  } finally {
    bridge.close();
    await stub.close();
  }
});

test('R5: a mutation whose connection drops is never replayed, and the outcome is called unknown', async () => {
  const stub = await startStub((entry, req, res) => {
    if (entry.url === '/api/agent-tools/leases/refresh') return json(res, 201, { lease: { id: 'l1' }, leaseToken: 'L1' });
    req.socket.destroy();
  });
  const bridge = startBridge(orchestratorEnv(stub.base, { ORCA_REFRESH_TOKEN: 'R' }));
  try {
    const result = await bridge.callTool('orchestrator__register', { body: { cwd: '/work' } });
    assert.equal(result.isError, true);
    assert.equal(stub.seen.filter((entry) => entry.url === '/api/orchestrators').length, 1, 'never replayed');
    assert.ok(result.text.includes(stub.base), result.text);
    assert.match(result.text, /outcome is unknown/i);
    assert.match(result.text, /orchestrator__status|orchestrator__list/);
  } finally {
    bridge.close();
    await stub.close();
  }
});

test('R5: a daemon that is still starting says to try again', async () => {
  const stub = await startStub((entry, req, res) => json(res, 503, { error: 'Orca is starting.' }));
  const bridge = startBridge(orchestratorEnv(stub.base, { ORCA_TOOL_LEASE_TOKEN: 'lease-x' }));
  try {
    const result = await bridge.callTool('orchestrator__list');
    assert.equal(result.isError, true);
    assert.match(result.text, /Orca is starting\./);
    assert.match(result.text, /try again/i);
  } finally {
    bridge.close();
    await stub.close();
  }
});

test('R5: the permission relay shares the same explanation when the daemon is down', async () => {
  const base = `http://127.0.0.1:${await freePort()}`;
  const bridge = startBridge({
    ORCA_AGENT_TOOLS_BASE_URL: base,
    ORCA_ROLE: 'executor',
    ORCA_TOOL_LEASE_TOKEN: 'lane-lease',
    ORCA_LANE_ID: 'lane-1',
  });
  try {
    const result = await bridge.callTool('permission_prompt', { tool_name: 'Bash', input: { command: 'ls' } });
    const decision = JSON.parse(result.text);
    assert.equal(decision.behavior, 'deny');
    assert.ok(decision.message.includes(base), decision.message);
    assert.match(decision.message, /not running|connection refused/i);
  } finally {
    bridge.close();
  }
});
