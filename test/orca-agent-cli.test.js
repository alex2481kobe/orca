import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const serverEntry = path.join(root, 'src', 'server.js');
const orcaAgentPath = path.join(root, 'scripts', 'orca-agent.mjs');
let importCounter = 0;

async function withRealOrcaServer(callback) {
  const previousCwd = process.cwd();
  const previousEnv = { ...process.env };
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-agent-cli-'));
  process.chdir(tempDir);
  process.env.ORCA_API_TOKEN = 'orca-agent-cli-token';
  process.env.ORCA_AUTO_AUDIT = 'false';
  process.env.ORCA_RATE_LIMIT_DISABLED = 'true';
  process.env.PORT = '0';
  process.env.ORCA_HOST = '127.0.0.1';
  const moduleUrl = `${pathToFileURL(serverEntry).href}?orca-agent-cli=${Date.now()}-${++importCounter}`;
  const { startServer, stopServer } = await import(moduleUrl);
  const server = await startServer(0, '127.0.0.1');
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const requestJson = async (requestPath, { method = 'GET', token = process.env.ORCA_API_TOKEN, headers = {}, body } = {}) => {
    const nextHeaders = { accept: 'application/json', ...headers };
    if (token) nextHeaders['x-orca-token'] = token;
    const init = { method, headers: nextHeaders };
    if (body !== undefined) {
      nextHeaders['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const response = await fetch(`${baseUrl}${requestPath}`, init);
    const raw = await response.text();
    let parsed = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = { raw }; }
    return { status: response.status, body: parsed };
  };

  try {
    await callback({ baseUrl, requestJson, token: process.env.ORCA_API_TOKEN, tempDir });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (typeof stopServer === 'function') await stopServer();
    for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
    for (const [key, value] of Object.entries(previousEnv)) process.env[key] = value;
    process.chdir(previousCwd);
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
}

function runOrcaAgent(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [orcaAgentPath, ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`orca-agent timed out: ${args.join(' ')}`));
    }, 8000);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

test('orca-agent tail reads bounded lane output and enforces session-scoped leases', async () => {
  await withRealOrcaServer(async ({ baseUrl, requestJson, token, tempDir }) => {
    const project = await requestJson('/api/projects', {
      method: 'POST',
      body: { name: 'Orca Agent CLI Project', approved: true },
    });
    assert.equal(project.status, 201);
    const session = await requestJson(`/api/projects/${project.body.id}/sessions`, {
      method: 'POST',
      body: { name: 'Orca Agent CLI Session', approved: true },
    });
    assert.equal(session.status, 201);
    const otherSession = await requestJson(`/api/projects/${project.body.id}/sessions`, {
      method: 'POST',
      body: { name: 'Other CLI Session', approved: true },
    });
    assert.equal(otherSession.status, 201);
    const lane = await requestJson(`/api/sessions/${session.body.id}/lanes`, {
      method: 'POST',
      body: { title: 'CLI visible lane', executorType: 'mock', approved: true },
    });
    assert.equal(lane.status, 201);

    const logDir = path.join(process.cwd(), 'artifacts', session.body.id, lane.body.id);
    await fs.mkdir(logDir, { recursive: true });
    await fs.writeFile(path.join(logDir, 'terminal.log'), 'CLI INITIAL OUTPUT\nCLI LIVE OUTPUT\n');

    const lease = await requestJson('/api/agent-tools/leases', {
      method: 'POST',
      body: {
        actor: 'orca-agent-cli-supervisor',
        role: 'supervisor',
        projectId: project.body.id,
        sessionId: session.body.id,
        ttlMs: 10 * 60 * 1000,
      },
    });
    assert.equal(lease.status, 201);

    const env = {
      HOME: tempDir,
      ORCA_AGENT_TOOLS_BASE_URL: baseUrl,
      ORCA_TOOL_LEASE_TOKEN: lease.body.leaseToken,
      ORCA_API_TOKEN: token,
    };
    const result = await runOrcaAgent(['tail', lane.body.id, '--max-bytes', '4096'], env);
    assert.equal(result.code, 0, result.stderr);
    const tail = JSON.parse(result.stdout);
    assert.equal(tail.laneId, lane.body.id);
    assert.equal(tail.text.includes('CLI LIVE OUTPUT'), true);
    assert.equal(tail.eof, true);

    const incremental = await runOrcaAgent(['tail', lane.body.id, '--offset', '4', '--max-bytes', '7'], env);
    assert.equal(incremental.code, 0, incremental.stderr);
    assert.equal(JSON.parse(incremental.stdout).text, 'INITIAL');

    const wrongLease = await requestJson('/api/agent-tools/leases', {
      method: 'POST',
      body: {
        actor: 'wrong-cli-supervisor',
        role: 'supervisor',
        projectId: project.body.id,
        sessionId: otherSession.body.id,
        ttlMs: 10 * 60 * 1000,
      },
    });
    assert.equal(wrongLease.status, 201);
    const denied = await runOrcaAgent(['tail', lane.body.id, '--max-bytes', '4096'], {
      ...env,
      ORCA_TOOL_LEASE_TOKEN: wrongLease.body.leaseToken,
    });
    assert.equal(denied.code, 2);
    assert.match(denied.stderr, /Tool lease session mismatch/);
  });
});
