#!/usr/bin/env node
/*
 * HONEST real-executor smoke: spawn a real codex/claude executor lane and drive it
 * to `done` (exit 0) with a DEFAULT deployment env — only ORCA_API_TOKEN +
 * ORCA_REPO_ROOTS are set. It deliberately does NOT set ORCA_*_WORKDIR_ROOTS or
 * ORCA_*_BINARY, because those env vars are exactly what masked real bugs:
 *   - "workdir is outside allowed execution roots" (exec roots vs repo roots)
 *   - codex hanging forever on an inherited open stdin
 *   - codex `exec --mcp-config` exit 2 / the 15s heartbeat reaper
 * Binaries are auto-discovered from PATH. Skips (exit 0) if neither CLI is present.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const previousCwd = process.cwd();
const previousEnv = { ...process.env };
const log = (m, i = '') => console.log(`[real-executor] ${m}${i ? ' — ' + i : ''}`);
const fail = (m, i = '') => { console.error(`[real-executor FAIL] ${m}${i ? ' — ' + i : ''}`); throw new Error(m); };

function onPath(bin) {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0;
}

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-real-exec-'));
const repo = path.join(tempDir, 'project');
let server = null; let stopServer = null;

try {
  await fs.mkdir(repo, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: repo });
  await fs.writeFile(path.join(repo, 'README.md'), '# demo\n');
  spawnSync('git', ['add', '-A'], { cwd: repo });
  spawnSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: repo });
  const realRepo = await fs.realpath(repo);

  const executors = ['codex', 'claude'].filter(onPath);
  if (!executors.length) { log('skipped', 'neither codex nor claude on PATH'); process.exit(0); }

  // Isolated cwd so we never touch the real .orca; DEFAULT env only.
  process.chdir(tempDir);
  process.env.PORT = '0';
  process.env.ORCA_HOST = '127.0.0.1';
  process.env.ORCA_API_TOKEN = 'real-exec-token';
  process.env.ORCA_CREDENTIAL_BACKEND = 'memory';
  process.env.ORCA_RATE_LIMIT_DISABLED = 'true';
  process.env.ORCA_AUTO_AUDIT = 'false'; // verify the executor lane itself, no audit churn
  process.env.ORCA_REPO_ROOTS = `${tempDir},${realRepo},${repo}`;
  // NOTE: intentionally NOT setting ORCA_*_WORKDIR_ROOTS or ORCA_*_BINARY.

  const sm = await import('../src/server.js');
  server = await sm.startServer(0, '127.0.0.1');
  stopServer = sm.stopServer;
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = process.env.ORCA_API_TOKEN;
  const api = async (p, b) => {
    const r = await fetch(`${base}${p}`, { method: b ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-orca-token': token }, body: b ? JSON.stringify(b) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  const project = await api('/api/projects', { actor: 'd', approved: true, name: 'Real Exec' });
  if (project.status !== 201) fail('project create', JSON.stringify(project));
  const session = await api(`/api/projects/${project.body.id}/sessions`, { actor: 'd', approved: true, name: 'S', leader: 'codex', repoRoot: realRepo });
  if (session.status !== 201) fail('session create', JSON.stringify(session));
  log('workspace', `repoRoot=${realRepo} executors=${executors.join(',')}`);

  for (const executorType of executors) {
    const lane = await api(`/api/sessions/${session.body.id}/lanes`, {
      actor: 'd', approved: true, title: `real ${executorType}`, owner: 'executor', executorType,
      permissionsProfile: 'plan', // read-only sandbox: safe + fast
      taskPrompt: 'Reply with the single word READY and then stop. Do not modify any files.',
    });
    if (lane.status !== 201) fail(`${executorType} lane create`, JSON.stringify(lane));
    const laneId = lane.body.id;
    const deadline = Date.now() + 90_000;
    let last = null;
    while (Date.now() < deadline) {
      last = (await api(`/api/lanes/${laneId}`)).body;
      if (['done', 'failed', 'stopped'].includes(last.state)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (last.state !== 'done') {
      fail(`${executorType} lane did not reach done`, `state=${last.state} reason=${(last.exitReason || '').slice(0, 120)}`);
    }
    if (last.processMeta && last.processMeta.exitCode !== 0) {
      fail(`${executorType} non-zero exit`, JSON.stringify(last.processMeta));
    }
    log(`${executorType} lane`, `done exit=${last.processMeta?.exitCode ?? 'n/a'} (real ${executorType}, default env)`);
  }

  log('done', 'real codex/claude executor lanes reached done with default env (no WORKDIR_ROOTS/BINARY)');
} finally {
  if (stopServer) await stopServer();
  if (server) await new Promise((r) => server.close(r));
  process.chdir(previousCwd);
  await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }).catch(() => {});
  for (const k of Object.keys(process.env)) if (!(k in previousEnv)) delete process.env[k];
  for (const [k, v] of Object.entries(previousEnv)) process.env[k] = v;
}
