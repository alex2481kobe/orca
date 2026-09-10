// Stage 5 end to end: a real daemon process on temp state (temp working
// directory, temp HOME, random port, an API token so loopback is NOT admin) and
// real bridge processes started from the config the daemon hands out.
//
// Walks the agent's day: two sessions connect from one config; one works while
// the other goes idle past its lease; the idle one comes back with a mutation;
// the daemon stops and comes back underneath both; the credential is revoked.
//
// When a step would need a manual recovery, this test performs the recovery
// Orca documents (mint another bootstrap with the same actor, rewrite the
// config, restart the session) and counts it. The requirement is that the count
// stays zero -- and doing the documented recovery is what reproduces the real
// knock-off: it revokes the other session's lease.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ROOT, cleanChildEnv, freePort, startBridge } from './helpers/bridge-client.js';

const SERVER = path.join(ROOT, 'src', 'server.js');
const ADMIN = 'e2e-admin-token';
const ACTOR = 'e2e-shared-config';
const TTL_MS = 30_000; // the shortest lease Orca mints
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startDaemon({ cwd, home, port }) {
  const child = spawn(process.execPath, [SERVER], {
    cwd,
    env: {
      ...cleanChildEnv(),
      HOME: home,
      PORT: String(port),
      ORCA_HOST: '127.0.0.1',
      ORCA_API_TOKEN: ADMIN,
      ORCA_REPO_ROOTS: cwd,
      // Pinned: the daemon resolves its state dir without looking at its cwd.
      ORCA_STATE_DIR: path.join(cwd, '.orca'),
      ORCA_RATE_LIMIT_DISABLED: 'true',
      ORCA_AUTO_AUDIT: 'false',
      ORCA_CREDENTIAL_BACKEND: 'memory',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`daemon did not start:\n${output}`)), 20000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes(`Orca listening at http://127.0.0.1:${port}`)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`daemon exited (${code}) before listening:\n${output}`));
    });
  });
  const stop = () => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
  });
  return { child, stop, output: () => output };
}

function adminClient(base) {
  return async (method, route, body) => {
    const init = { method, headers: { 'x-orca-token': ADMIN, accept: 'application/json' } };
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(`${base}${route}`, init);
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

test('e2e: an agent day on one shared config needs no manual step', { timeout: 240_000 }, async (t) => {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orca-e2e-leases-')));
  const work = path.join(tmp, 'work');
  const home = path.join(tmp, 'home');
  await fs.mkdir(work);
  await fs.mkdir(home);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const admin = adminClient(base);
  let daemon = await startDaemon({ cwd: work, home, port });
  const bridges = new Set();
  const open = (env) => {
    const bridge = startBridge({ ...env, HOME: home });
    bridges.add(bridge);
    return bridge;
  };

  const state = { manualRecoveries: 0, recoveries: [] };
  const boot = await admin('POST', '/api/mcp/orchestrator-bootstrap', { actor: ACTOR, ttlMs: TTL_MS });
  assert.equal(boot.status, 201, JSON.stringify(boot.body));
  const configEnv = boot.body.bootstrap.clients.claudeDesktop.config.mcpServers.orca.env;
  let sessionA = open(configEnv);
  let sessionB = open(configEnv);
  let orchestratorId = null;

  // The documented manual recovery for a session whose lease is gone.
  const recoverManually = async (reason) => {
    state.manualRecoveries += 1;
    state.recoveries.push(reason);
    const again = await admin('POST', '/api/mcp/orchestrator-bootstrap', { actor: ACTOR, ttlMs: TTL_MS });
    sessionB.close();
    bridges.delete(sessionB);
    sessionB = open(again.body.bootstrap.clients.claudeDesktop.config.mcpServers.orca.env);
  };
  // Leases the bridges obtained with the credential. The bootstrap response's own
  // lease (for direct HTTP use) is issued by the same credential but belongs to
  // no session, so it is left out.
  const childLeases = async () => {
    const listed = await admin('GET', '/api/agent-tools/leases?activeOnly=false');
    const credentialId = boot.body.credential?.id;
    return (listed.body?.leases || []).filter((lease) => credentialId
      && lease.parentId === credentialId
      && lease.kind !== 'refresh'
      && lease.id !== boot.body.lease?.id);
  };

  try {
    await t.test('two sessions connect from one config and act as one orchestrator', async () => {
      const a = await sessionA.callTool('orchestrator__register', { body: { cwd: work, title: 'e2e A' } });
      assert.equal(a.isError, false, a.text);
      const b = await sessionB.callTool('orchestrator__register', { body: { cwd: work, title: 'e2e B' } });
      assert.equal(b.isError, false, b.text);
      orchestratorId = a.json.id;
      assert.equal(b.json.id, orchestratorId, 'one config is one orchestrator identity');
    });

    await t.test('an active session keeps its lease; an idle one lapses and its next mutation succeeds', async () => {
      // A works every 6 s for 36 s; B sits idle past its 30 s lease.
      const startedAt = Date.now();
      while (Date.now() - startedAt < TTL_MS + 6000) {
        const status = await sessionA.callTool('orchestrator__status', { orchestratorId });
        assert.equal(status.isError, false, `active session lost access after ${Date.now() - startedAt} ms: ${status.text}`);
        assert.equal(status.json.activeOrchestrator.active, true);
        await sleep(6000);
      }
      let back = await sessionB.callTool('orchestrator__register', { body: { cwd: work, title: 'e2e B, back' } });
      if (back.isError) {
        await recoverManually(`idle session: ${back.text}`);
        back = await sessionB.callTool('orchestrator__register', { body: { cwd: work, title: 'e2e B, back' } });
      }
      assert.equal(back.isError, false, back.text);
      assert.equal(back.json.id, orchestratorId, 'same orchestrator, same lanes');
      assert.equal(state.manualRecoveries, 0, `needed a manual step: ${state.recoveries.join(' | ')}`);
      // A never re-minted: exactly A's first lease, B's first, and B's one re-mint.
      assert.equal((await childLeases()).length, 3, 'only the idle session minted a new lease');
    });

    await t.test('the idle session re-minting did not knock the active one off', async () => {
      const status = await sessionA.callTool('orchestrator__status', { orchestratorId });
      assert.equal(status.isError, false, status.text);
      assert.deepEqual((await childLeases()).filter((lease) => lease.revokedAt), [], 'no lease was revoked');
    });

    await t.test('a stopped daemon: the error names the URL, the cause and the fix', async () => {
      await daemon.stop();
      const down = await sessionA.callTool('orchestrator__status', { orchestratorId });
      assert.equal(down.isError, true);
      assert.ok(down.text.includes(base), down.text);
      assert.match(down.text, /not running|connection refused/i);
      assert.match(down.text, /Fix: .*npm start/);
    });

    await t.test('the daemon comes back on the same port: both sessions carry on with no restart', async () => {
      daemon = await startDaemon({ cwd: work, home, port });
      for (const [name, session] of [['A', sessionA], ['B', sessionB]]) {
        const status = await session.callTool('orchestrator__status', { orchestratorId });
        assert.equal(status.isError, false, `session ${name} after restart: ${status.text}`);
      }
    });

    await t.test('revoking the credential cuts every session off, and the error names the fix', async () => {
      const credentialId = boot.body.credential?.id;
      assert.ok(credentialId, 'bootstrap reports the credential it issued');
      assert.equal((await admin('DELETE', `/api/agent-tools/leases/${credentialId}`)).status, 200);
      for (const session of [sessionA, sessionB]) {
        const refused = await session.callTool('orchestrator__status', { orchestratorId });
        assert.equal(refused.isError, true);
        assert.match(refused.text, /revoked/);
        assert.match(refused.text, /Fix: .*connect claude/);
      }
    });

    await t.test('the client config holds only a refresh credential: no admin token, no lease', () => {
      assert.equal(Object.values(configEnv).includes(ADMIN), false);
      assert.ok(configEnv.ORCA_REFRESH_TOKEN, 'config carries a refresh credential');
      assert.equal(configEnv.ORCA_TOOL_LEASE_TOKEN, undefined, 'config carries no lease');
    });
  } finally {
    for (const bridge of bridges) bridge.close();
    await daemon.stop();
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});
