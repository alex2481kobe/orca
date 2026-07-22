#!/usr/bin/env node
/*
 * End-to-end verification of the built-in Orca MCP server and the agent
 * workflow flows, driven THROUGH the real MCP server (src/mcp-server.js) over
 * stdio against a real in-process Orca server.
 *
 * Covers, for both orchestrator and executor roles:
 *  - MCP initialize + role-filtered tools/list
 *  - Orchestrator spawning executor agents via lane.create (mock + real Codex + real Claude)
 *  - Stopping/deactivating a running agent via lane.shutdown
 *  - Executor heartbeat + submit (summary/diff handoff)
 *  - Authoritative state-gate refusal surfaced through MCP (isError + nextAction)
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER = path.join(here, '..', 'src', 'mcp-server.js');
const previousCwd = process.cwd();
const previousEnv = { ...process.env };
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-mcp-flow-'));
const token = 'mcp-flow-smoke-token';
let server = null;
let stopServer = null;
let base = '';
const clients = [];

const log = (label, info = '') => console.log(`[mcp-flow] ${label}${info ? ' — ' + info : ''}`);
const fail = (label, info = '') => {
  console.error(`[mcp-flow FAIL] ${label}${info ? ' — ' + info : ''}`);
  throw new Error(label);
};

function detectBinary(envVar, candidates) {
  for (const candidate of [process.env[envVar], ...candidates].filter(Boolean)) {
    const result = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 4000 });
    if (result.status === 0 && /\d+\.\d+/.test(result.stdout || '')) return candidate;
  }
  return null;
}

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

// A persistent MCP client speaking JSON-RPC over stdio to a spawned MCP server.
class McpClient {
  constructor(role, env) {
    this.role = role;
    this.child = spawn('node', [MCP_SERVER], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = '';
    this.child.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString();
      let idx;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          this.pending.get(msg.id)(msg);
          this.pending.delete(msg.id);
        }
      }
    });
    clients.push(this);
  }

  rpc(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP ${method} timed out`)), 30000);
      this.pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async initialize() {
    const res = await this.rpc('initialize', { protocolVersion: '2024-11-05' });
    if (res.result?.serverInfo?.name !== 'orca') fail(`${this.role} initialize`, JSON.stringify(res));
    return res.result;
  }

  async listToolNames() {
    const res = await this.rpc('tools/list');
    return (res.result?.tools || []).map((t) => t.name);
  }

  async call(name, args = {}) {
    const res = await this.rpc('tools/call', { name, arguments: args });
    const text = res.result?.content?.[0]?.text ?? '';
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* non-json */ }
    return { isError: Boolean(res.result?.isError), text, data };
  }

  close() {
    try { this.child.kill(); } catch { /* ignore */ }
  }
}

async function waitForLaneState(laneId, predicate, label, { timeoutMs = 25000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await req('GET', `/api/lanes/${laneId}`);
    if (predicate(latest.body?.state, latest.body)) return latest.body;
    await new Promise((r) => setTimeout(r, 250));
  }
  fail(`${label} did not reach expected state`, JSON.stringify(latest?.body || null));
}

async function mintLease(role, extra = {}) {
  const lease = await req('POST', '/api/agent-tools/leases', {
    actor: `${role}-mcp-flow`,
    role,
    ttlMs: 120_000,
    ...extra,
  });
  if (lease.status !== 201) fail(`${role} lease`, JSON.stringify(lease));
  return lease.body.leaseToken;
}

async function cleanup() {
  for (const c of clients) c.close();
  if (stopServer) await stopServer();
  if (server) await new Promise((resolve) => server.close(resolve));
  process.chdir(previousCwd);
  await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  for (const [key, value] of Object.entries(previousEnv)) process.env[key] = value;
}

try {
  const codexBinary = detectBinary('ORCA_CODEX_BINARY', ['/opt/homebrew/bin/codex', '/usr/local/bin/codex', 'codex']);
  const claudeBinary = detectBinary('ORCA_CLAUDE_BINARY', ['/opt/homebrew/bin/claude', '/usr/local/bin/claude', 'claude']);

  process.chdir(tempDir);
  const realTempDir = await fs.realpath(tempDir);
  process.env.PORT = '0';
  process.env.ORCA_HOST = '127.0.0.1';
  process.env.ORCA_API_TOKEN = token;
  process.env.ORCA_CREDENTIAL_BACKEND = 'memory';
  process.env.ORCA_REPO_ROOTS = realTempDir;
  const roots = [tempDir, realTempDir].join(',');
  for (const [bin, prefix] of [[codexBinary, 'CODEX'], [claudeBinary, 'CLAUDE']]) {
    if (!bin) continue;
    process.env[`ORCA_${prefix}_BINARY`] = bin;
    process.env[`ORCA_${prefix}_ALLOWED_BINARIES`] = bin;
    process.env[`ORCA_${prefix}_WORKDIR_ROOTS`] = roots;
  }

  const serverModule = await import('../src/server.js');
  server = await serverModule.startServer(0, '127.0.0.1');
  stopServer = serverModule.stopServer;
  base = `http://127.0.0.1:${server.address().port}`;
  log('server', base);

  const baseEnv = { ORCA_AGENT_TOOLS_BASE_URL: base };

  // ---- ORCHESTRATOR ROLE -------------------------------------------------
  // v2: no session container. The orchestrator lease registers by cwd (implicitly
  // creating the project) and spawns executor lanes under the orchestrator record.
  const orchToken = await mintLease('orchestrator');
  const orch = new McpClient('orchestrator', {
    ...baseEnv, ORCA_ROLE: 'orchestrator', ORCA_TOOL_LEASE_TOKEN: orchToken,
  });
  await orch.initialize();
  const orchTools = await orch.listToolNames();
  for (const need of ['orchestrator__register', 'lane__create', 'lane__shutdown', 'audit__queue_one', 'project__list',
    'lane__integrate', 'lane__worktree__discard', 'orchestrator__heartbeat']) {
    if (!orchTools.includes(need)) fail('orchestrator tools/list missing', need);
  }
  if (orchTools.includes('orchestrator__enroll')) fail('orchestrator tools/list still exposes removed enroll tool');
  log('orchestrator tools', `${orchTools.length} tools incl. lane__create/shutdown/audit`);

  // Register as the orchestrator for the working dir (creates project-by-cwd).
  const reg = await orch.call('orchestrator__register', { cwd: realTempDir, actor: 'orchestrator-mcp-flow', title: 'MCP Flow' });
  if (reg.isError || !String(reg.data?.id || '').startsWith('orc_')) fail('orchestrator orchestrator__register', reg.text);
  const orchestratorId = reg.data.id;
  const projectId = reg.data.projectId;
  log('workspace', `project=${projectId} orchestrator=${orchestratorId}`);

  // Heartbeat refreshes the lease owner's lastSeenAt (keeps ownership from going
  // stale during read-only monitoring).
  const beat = await orch.call('orchestrator__heartbeat', { orchestratorId, body: { actor: 'orchestrator-mcp-flow' } });
  if (beat.isError || !beat.data?.lastSeenAt) fail('orchestrator orchestrator__heartbeat', beat.text);
  log('orchestrator heartbeat', 'lastSeenAt refreshed');

  // project.list via MCP returns our (implicitly created) project.
  const projList = await orch.call('project__list', {});
  if (projList.isError) fail('orchestrator project__list', projList.text);
  log('orchestrator project__list', 'ok');

  // Spawn an executor agent (mock) via the MCP tool, run to completion.
  const spawn1 = await orch.call('lane__create', {
    orchestratorId,
    body: { actor: 'orchestrator', approved: true, title: 'MCP-spawned mock lane', owner: 'orchestrator', role: 'executor', executorType: 'mock', taskPrompt: 'spawned via MCP', runProfile: { autoCompleteMs: 800 } },
  });
  if (spawn1.isError || !spawn1.data?.id) fail('orchestrator lane__create (mock)', spawn1.text);
  await waitForLaneState(spawn1.data.id, (s) => s === 'done', 'MCP-spawned mock lane');
  log('orchestrator spawn+complete', `${spawn1.data.id} done`);

  // Spawn a long-running agent and STOP it in progress (deactivate).
  const spawn2 = await orch.call('lane__create', {
    orchestratorId,
    body: { actor: 'orchestrator', approved: true, title: 'MCP long-running lane', owner: 'orchestrator', role: 'executor', executorType: 'mock', taskPrompt: 'long', runProfile: { autoCompleteMs: 60000 } },
  });
  if (spawn2.isError || !spawn2.data?.id) fail('orchestrator lane__create (long)', spawn2.text);
  await waitForLaneState(spawn2.data.id, (s) => s === 'running', 'long lane running');
  const stopRes = await orch.call('lane__shutdown', { laneId: spawn2.data.id, body: { actor: 'orchestrator', approved: true } });
  if (stopRes.isError) fail('orchestrator lane__shutdown', stopRes.text);
  await waitForLaneState(spawn2.data.id, (s) => s === 'stopped', 'stopped-in-progress lane');
  log('orchestrator stop-in-progress', `${spawn2.data.id} stopped while running`);

  // Spawn real Codex + Claude executor lanes via MCP (version command).
  for (const [bin, type] of [[codexBinary, 'codex'], [claudeBinary, 'claude']]) {
    if (!bin) { log(`orchestrator spawn ${type}`, 'skipped: CLI not available'); continue; }
    const laneRes = await orch.call('lane__create', {
      orchestratorId,
      body: { actor: 'orchestrator', approved: true, title: `MCP ${type} lane`, owner: 'orchestrator', role: 'executor', executorType: type, commandArgs: ['--version'] },
    });
    if (laneRes.isError || !laneRes.data?.id) fail(`orchestrator lane__create (${type})`, laneRes.text);
    const done = await waitForLaneState(laneRes.data.id, (s) => ['done', 'failed', 'stopped'].includes(s), `${type} lane`);
    if (done.state !== 'done' || done.processMeta?.exitCode !== 0) fail(`${type} lane exit`, JSON.stringify(done.processMeta || done.state));
    log(`orchestrator spawn ${type}`, `${laneRes.data.id} done exit=0 (real ${type})`);
  }

  // ---- EXECUTOR ROLE -----------------------------------------------------
  // Create a running lane (under the orchestrator container) the executor operates on.
  const execLane = await req('POST', `/api/orchestrators/${orchestratorId}/lanes`, {
    actor: 'dashboard', approved: true, title: 'Executor MCP lane', owner: 'executor', role: 'executor',
    executorType: 'mock', taskPrompt: 'executor work', runProfile: { autoCompleteMs: 60000 },
  });
  if (execLane.status !== 201) fail('executor lane create', JSON.stringify(execLane));
  await waitForLaneState(execLane.body.id, (s) => s === 'running', 'executor lane running');

  // Authoritative state gate (orchestrator path): audit.accept is illegal while
  // the lane is running -> refused via MCP with a nextAction envelope.
  const illegalAudit = await orch.call('audit__accept', { laneId: execLane.body.id, body: { actor: 'orchestrator' } });
  if (!illegalAudit.isError || !/not allowed while lane is "running"|nextRequiredTool/i.test(illegalAudit.text)) {
    fail('authoritative gate did not refuse out-of-order audit.accept', illegalAudit.text);
  }
  log('authoritative gate (orchestrator)', 'audit.accept refused while running (nextAction returned)');

  const execToken = await mintLease('executor', { projectId, sessionId: orchestratorId, laneId: execLane.body.id });
  const exec = new McpClient('executor', {
    ...baseEnv, ORCA_ROLE: 'executor', ORCA_TOOL_LEASE_TOKEN: execToken,
    ORCA_PROJECT_ID: projectId, ORCA_SESSION_ID: orchestratorId, ORCA_LANE_ID: execLane.body.id,
  });
  await exec.initialize();
  const execTools = await exec.listToolNames();
  for (const need of ['lane__submit', 'lane__heartbeat']) {
    if (!execTools.includes(need)) fail('executor tools/list missing', need);
  }
  if (execTools.includes('provider__configure')) fail('executor tools/list leaks dashboard tool', 'provider__configure');
  if (execTools.includes('audit__accept')) fail('executor tools/list leaks auditor tool', 'audit__accept');
  log('executor tools', `${execTools.length} tools; dashboard/auditor tools hidden`);

  // heartbeat
  const hb = await exec.call('lane__heartbeat', { laneId: execLane.body.id, body: { actor: 'executor' } });
  if (hb.isError) fail('executor lane__heartbeat', hb.text);
  log('executor heartbeat', 'ok');

  // Authoritative state gate (executor path): critique.findings.record is only
  // legal in needs_critique -> refused while running via MCP with nextAction.
  if (execTools.includes('critique__findings__record')) {
    const illegalCritique = await exec.call('critique__findings__record', { laneId: execLane.body.id, body: { actor: 'executor', ready: true } });
    if (!illegalCritique.isError || !/not allowed while lane is "running"|nextRequiredTool/i.test(illegalCritique.text)) {
      fail('authoritative gate did not refuse out-of-order critique.findings.record', illegalCritique.text);
    }
    log('authoritative gate (executor)', 'critique.findings.record refused while running');
  }

  // Permission-approval loop via MCP: executor requests, orchestrator approves.
  const reqApproval = await exec.call('approval__request', {
    laneId: execLane.body.id,
    body: { actor: 'executor', kind: 'command', detail: 'run build script' },
  });
  if (reqApproval.isError || !reqApproval.data?.approval?.id) fail('executor approval__request', reqApproval.text);
  const approvalId = reqApproval.data.approval.id;
  const pending = await req('GET', `/api/lanes/${execLane.body.id}/approvals`);
  if (!pending.body?.awaitingApproval) fail('approval not surfaced as pending', JSON.stringify(pending.body));
  const respond = await orch.call('approval__respond', {
    laneId: execLane.body.id, approvalId,
    body: { actor: 'orchestrator', decision: 'approve' },
  });
  if (respond.isError || respond.data?.approval?.status !== 'approved') fail('orchestrator approval__respond', respond.text);
  log('approval loop', `executor requested -> orchestrator approved (${approvalId.slice(0, 8)})`);

  // Claude permission-prompt-tool bridge: permission_prompt records an approval
  // and BLOCKS until decided; orchestrator approves while it waits -> behavior:allow.
  const promptPromise = exec.call('permission_prompt', { tool_name: 'Bash', input: { command: 'ls -la' } });
  let pendingTool = null;
  for (let i = 0; i < 50 && !pendingTool; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const list = await req('GET', `/api/lanes/${execLane.body.id}/approvals`);
    pendingTool = (list.body?.approvals || []).find((a) => a.kind === 'tool' && a.status === 'pending');
  }
  if (!pendingTool) fail('permission_prompt did not create a pending approval');
  await orch.call('approval__respond', { laneId: execLane.body.id, approvalId: pendingTool.id, body: { actor: 'orchestrator', decision: 'approve' } });
  const promptResult = await promptPromise;
  const behavior = JSON.parse(promptResult.text);
  if (behavior.behavior !== 'allow') fail('permission_prompt allow', promptResult.text);
  log('claude permission-prompt bridge', 'permission_prompt -> approved -> behavior:allow');

  // submit (summary + changed files) -> ready_for_audit
  const submit = await exec.call('lane__submit', {
    laneId: execLane.body.id,
    body: { actor: 'executor', summary: 'Did the work', changedFiles: ['src/x.js', 'src/y.js'] },
  });
  if (submit.isError) fail('executor lane__submit', submit.text);
  const submitted = await waitForLaneState(execLane.body.id, (s) => s === 'ready_for_audit', 'submitted lane');
  if (submitted.summary !== 'Did the work') fail('executor submit summary', JSON.stringify(submitted.summary));
  log('executor submit', `ready_for_audit summary+${(submitted.changedFiles || []).length} files`);

  log('done', 'MCP tools + flows verified for orchestrator and executor roles (mock + real Codex + Claude)');
} finally {
  await cleanup();
}
