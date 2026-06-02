#!/usr/bin/env node
/*
 * End-to-end proof of the external-orchestrator -> session -> executor lifecycle
 * against an isolated Orca server, exercising the same routes the orchestrator
 * MCP tools call:
 *   1. External orchestrator bootstrap (lease + paste-ready MCP config; no raw
 *      API token) — the "act as the orchestrator for Orca" entry point.
 *   2. Session config: orchestrator CLI (leader) + executor capacity (cap).
 *   3. Spawn: orchestrator-created executor lanes appear as tracked session lanes.
 *   4. Read-only monitor: each lane exposes structured agent events (the
 *      read-only "what the executor is doing" feed).
 *   5. Despawn (stop) + respawn (retry) of an executor lane.
 *   6. Pause/deactivate new spawns via session spawnPolicy='never'.
 *   7. Dashboard tracking: project/session/lanes are all queryable.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const previousCwd = process.cwd();
const previousEnv = { ...process.env };
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-orch-lifecycle-'));
const token = 'orchestrator-lifecycle-smoke-token';
let server = null;
let stopServer = null;
let base = '';

const log = (label, info = '') => console.log(`[orchestrator-lifecycle] ${label}${info ? ' — ' + info : ''}`);
const fail = (label, info = '') => {
  console.error(`[orchestrator-lifecycle FAIL] ${label}${info ? ' — ' + info : ''}`);
  throw new Error(label);
};

async function req(method, route, body) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-orca-token': token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-json */ }
  return { status: response.status, body: data, text };
}

async function waitForState(laneId, predicate, label, { timeoutMs = 20000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await req('GET', `/api/lanes/${laneId}`);
    if (predicate(latest.body?.state, latest.body)) return latest.body;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  fail(`${label} not reached`, JSON.stringify({ state: latest?.body?.state }));
  return null;
}

async function cleanup() {
  if (stopServer) await stopServer();
  if (server) await new Promise((resolve) => server.close(resolve));
  process.chdir(previousCwd);
  await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  for (const key of Object.keys(process.env)) {
    if (!(key in previousEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(previousEnv)) process.env[key] = value;
}

try {
  process.chdir(tempDir);
  process.env.PORT = '0';
  process.env.ORCA_HOST = '127.0.0.1';
  process.env.ORCA_API_TOKEN = token;
  process.env.ORCA_CREDENTIAL_BACKEND = 'memory';

  const serverModule = await import('../src/server.js');
  server = await serverModule.startServer(0, '127.0.0.1');
  stopServer = serverModule.stopServer;
  base = `http://127.0.0.1:${server.address().port}`;
  log('server', base);

  // 1. External orchestrator bootstrap — what a Codex app / Claude Desktop /
  //    Gemini CLI receives to "act as the orchestrator" via MCP, scoped by lease.
  const bootstrap = await req('POST', '/api/mcp/orchestrator-bootstrap', { actor: 'desktop-app' });
  if (bootstrap.status !== 200 && bootstrap.status !== 201) fail('orchestrator bootstrap', JSON.stringify(bootstrap));
  if (!bootstrap.body?.leaseToken) fail('bootstrap missing lease token');
  if (!bootstrap.body?.bootstrap) fail('bootstrap missing MCP config');
  if (bootstrap.text.includes(token)) fail('bootstrap leaked the raw API token');
  log('bootstrap', `lease=${bootstrap.body.lease?.id} role=${bootstrap.body.lease?.role}`);

  // 2. Project + session with orchestrator CLI (leader) + executor capacity cap.
  const project = await req('POST', '/api/projects', { actor: 'dashboard', approved: true, name: 'Lifecycle Project' });
  if (project.status !== 201) fail('project create', JSON.stringify(project));
  const session = await req('POST', `/api/projects/${project.body.id}/sessions`, {
    actor: 'dashboard',
    approved: true,
    name: 'Lifecycle Session',
    leader: 'codex',
    laneConcurrencyLimit: 2,
    approvedCapacity: 2,
    spawnPolicy: 'within_capacity',
  });
  if (session.status !== 201) fail('session create', JSON.stringify(session));
  const sessionId = session.body.id;
  if (session.body.leader !== 'codex') fail('session leader (orchestrator CLI) not recorded', JSON.stringify(session.body));
  log('session', `${sessionId} leader=${session.body.leader} cap=${session.body.approvedCapacity}`);

  // 3. Spawn two executor lanes (what lane.create does for the orchestrator).
  const laneIds = [];
  for (const i of [1, 2]) {
    const lane = await req('POST', `/api/sessions/${sessionId}/lanes`, {
      actor: 'orchestrator',
      approved: true,
      title: `Executor lane ${i}`,
      owner: 'orchestrator',
      role: 'executor',
      executorType: 'mock',
      taskPrompt: `Prove executor lane ${i} lifecycle.`,
    });
    if (lane.status !== 201) fail(`spawn executor lane ${i}`, JSON.stringify(lane));
    laneIds.push(lane.body.id);
  }
  log('spawn', `${laneIds.length} executor lanes created`);

  // Dashboard tracking: both lanes are listed under the session.
  const listed = await req('GET', `/api/sessions/${sessionId}/lanes`);
  if (!laneIds.every((id) => listed.body.some((lane) => lane.id === id))) {
    fail('spawned lanes not tracked under session');
  }
  log('tracked', `${listed.body.length} lanes under session`);

  // 4. Read-only monitor: a lane reaches running/done and exposes agent events.
  const advanced = await waitForState(
    laneIds[0],
    (state, lane) => ['running', 'needs_critique', 'ready_for_audit', 'done'].includes(state) && (lane.agentEvents || []).length > 0,
    'executor running with agent events',
  );
  if (!Array.isArray(advanced.agentEvents) || !advanced.agentEvents.length) fail('no read-only agent events');
  log('read-only monitor', `${advanced.agentEvents.length} agent event(s) on lane 1`);

  // 5. Despawn (stop) then respawn (retry) the second lane.
  const stopped = await req('POST', `/api/lanes/${laneIds[1]}/stop`, { actor: 'dashboard', approved: true, reason: 'lifecycle test' });
  if (stopped.status !== 200) fail('stop lane', JSON.stringify(stopped));
  await waitForState(laneIds[1], (state) => state === 'stopped', 'lane stopped');
  log('despawn', `lane 2 stopped`);

  const retried = await req('POST', `/api/lanes/${laneIds[1]}/retry`, { actor: 'dashboard', approved: true });
  if (retried.status !== 200) fail('retry lane', JSON.stringify(retried));
  await waitForState(laneIds[1], (state) => ['queued', 'starting', 'running', 'needs_critique', 'ready_for_audit', 'done'].includes(state), 'lane respawned');
  log('respawn', `lane 2 retried`);

  // 6. Pause/deactivate new spawns: spawnPolicy='never' keeps a new lane queued.
  const paused = await req('PATCH', `/api/sessions/${sessionId}`, { actor: 'dashboard', approved: true, spawnPolicy: 'never' });
  if (paused.status !== 200) fail('pause session spawns', JSON.stringify(paused));
  const queuedLane = await req('POST', `/api/sessions/${sessionId}/lanes`, {
    actor: 'orchestrator', approved: true, title: 'Should stay queued', owner: 'orchestrator', role: 'executor', executorType: 'mock',
  });
  if (queuedLane.status !== 201) fail('create lane while paused', JSON.stringify(queuedLane));
  // Give the scheduler a couple of ticks; it must NOT start the lane.
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const stillQueued = await req('GET', `/api/lanes/${queuedLane.body.id}`);
  if (stillQueued.body?.state !== 'queued') fail('paused session still spawned a lane', JSON.stringify(stillQueued.body?.state));
  log('pause', `new lane held in queued under spawnPolicy=never`);
  await req('PATCH', `/api/sessions/${sessionId}`, { actor: 'dashboard', approved: true, spawnPolicy: 'within_capacity' });

  log('done', 'external orchestrator -> session -> spawn/stop/retry/pause executor lifecycle proven');
  await cleanup();
  process.exit(0);
} catch (error) {
  console.error(error?.stack || String(error));
  await cleanup().catch(() => {});
  process.exit(1);
}
