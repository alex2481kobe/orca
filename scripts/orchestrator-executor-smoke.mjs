#!/usr/bin/env node
/*
 * Proves the live orchestrator-to-executor lane flow against an isolated
 * Orca server.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const previousCwd = process.cwd();
const previousEnv = { ...process.env };
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-orch-exec-'));
const token = 'orchestrator-executor-smoke-token';
let server = null;
let stopServer = null;
let base = '';

const log = (label, info = '') => console.log(`[orchestrator-executor-smoke] ${label}${info ? ' — ' + info : ''}`);
const fail = (label, info = '') => {
  console.error(`[orchestrator-executor-smoke FAIL] ${label}${info ? ' — ' + info : ''}`);
  throw new Error(label);
};

function detectClaudeBinary() {
  const candidates = [
    process.env.ORCA_CLAUDE_BINARY,
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    'claude',
  ].filter(Boolean);

  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 4000 });
    if (result.status === 0 && /\d+\.\d+/.test(result.stdout || '')) return candidate;
  }
  return null;
}

async function req(method, route, body, extraHeaders = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-orca-token': token,
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-json */ }
  return { status: response.status, body: data, text };
}
const withLease = (leaseToken) => ({ 'x-orca-tool-lease': leaseToken });

async function waitForLaneTerminal(laneId, label, { timeoutMs = 25000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await req('GET', `/api/lanes/${laneId}`);
    const state = latest.body?.state;
    if (['done', 'failed', 'stopped'].includes(state)) {
      if (state !== 'done') {
        fail(`${label} terminal state`, JSON.stringify({
          state,
          exitReason: latest.body?.exitReason,
          processMeta: latest.body?.processMeta,
        }));
      }
      return latest.body;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  fail(`${label} did not reach terminal state`, JSON.stringify(latest?.body || null));
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
  const claudeBinary = detectClaudeBinary();
  process.chdir(tempDir);
  const realTempDir = await fs.realpath(tempDir);
  process.env.PORT = '0';
  process.env.ORCA_HOST = '127.0.0.1';
  process.env.ORCA_API_TOKEN = token;
  process.env.ORCA_CREDENTIAL_BACKEND = 'memory';
  process.env.ORCA_REPO_ROOTS = realTempDir;
  if (claudeBinary) {
    process.env.ORCA_CLAUDE_BINARY = claudeBinary;
    process.env.ORCA_CLAUDE_ALLOWED_BINARIES = claudeBinary;
    process.env.ORCA_CLAUDE_WORKDIR_ROOTS = [tempDir, realTempDir].join(',');
  }

  const serverModule = await import('../src/server.js');
  server = await serverModule.startServer(0, '127.0.0.1');
  stopServer = serverModule.stopServer;
  const address = server.address();
  base = `http://127.0.0.1:${address.port}`;
  log('server', base);

  // v2: no session container. An orchestrator lease registers by cwd (implicitly
  // creating the project) and spawns executor lanes under the orchestrator record.
  // (/api/agent-tools/discovery and /next-action are gone — the lease-mint
  // response below carries the nextAction envelope.)

  // Mint an (unscoped) orchestrator lease — the orchestrator identity.
  const lease = await req('POST', '/api/agent-tools/leases', {
    actor: 'orchestrator-smoke',
    role: 'orchestrator',
    ttlMs: 60_000,
  });
  if (lease.status !== 201) fail('tool lease', JSON.stringify(lease));
  if (!lease.body?.leaseToken || lease.body?.lease?.allowedTools?.includes('executor.spawn') !== true) {
    fail('tool lease grants', JSON.stringify(lease.body));
  }
  // A fresh orchestrator's next required tool is register.
  if (lease.body?.nextAction?.nextRequiredTool !== 'orchestrator.register') {
    fail('orchestrator next required tool', JSON.stringify(lease.body?.nextAction));
  }
  const leaseToken = lease.body.leaseToken;
  log('lease', `${lease.body.lease.id} grants executor.spawn`);

  // Register as the orchestrator for the working dir (creates project-by-cwd).
  const register = await req('POST', '/api/orchestrators', {
    cwd: realTempDir,
    actor: 'orchestrator-smoke',
    title: 'Orchestrator Smoke',
  }, withLease(leaseToken));
  if (register.status !== 200 || !String(register.body?.id || '').startsWith('orc_')) {
    fail('orchestrator register', JSON.stringify(register.body));
  }
  const orchestratorId = register.body.id;
  log('orchestrator', `${orchestratorId} registered (project=${register.body.projectId})`);

  // Spawn an executor lane under the orchestrator (executor.spawn).
  const mockLane = await req('POST', `/api/orchestrators/${orchestratorId}/executors`, {
    actor: 'orchestrator',
    approved: true,
    title: 'Executor mock lane from orchestrator',
    owner: 'executor-smoke',
    role: 'executor',
    executorType: 'mock',
    taskPrompt: 'Prove orchestrator-created executor lane reaches done.',
  }, withLease(leaseToken));
  if (mockLane.status !== 201) fail('mock executor lane create', JSON.stringify(mockLane));
  if (mockLane.body.orchestratorId !== orchestratorId) fail('lane not grouped under orchestrator', JSON.stringify(mockLane.body));
  const mockDone = await waitForLaneTerminal(mockLane.body.id, 'mock executor lane');
  log('mock executor', `${mockDone.id} ${mockDone.state}`);

  if (claudeBinary) {
    const claudeLane = await req('POST', `/api/orchestrators/${orchestratorId}/executors`, {
      actor: 'orchestrator',
      approved: true,
      title: 'Claude executor version lane from orchestrator',
      owner: 'claude-smoke',
      role: 'executor',
      executorType: 'claude',
      commandArgs: ['--version'],
    }, withLease(leaseToken));
    if (claudeLane.status !== 201) fail('claude executor lane create', JSON.stringify(claudeLane));
    const claudeDone = await waitForLaneTerminal(claudeLane.body.id, 'claude executor lane');
    if (claudeDone.processMeta?.exitCode !== 0) fail('claude exit code', JSON.stringify(claudeDone.processMeta));
    log('claude executor', `${claudeDone.id} exit=${claudeDone.processMeta.exitCode} binary=${claudeBinary}`);
  } else {
    log('claude executor', 'skipped: Claude CLI not executable on this host');
  }

  // (GET /api/audit/events is gone with the audit.log.read tool; the durable log
  // is still written, it just has no agent-facing reader.)
  log('done');
} finally {
  await cleanup();
}
