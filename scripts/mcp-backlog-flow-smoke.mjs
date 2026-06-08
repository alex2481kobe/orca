#!/usr/bin/env node
/*
 * End-to-end proof that a chat can drive a WHOLE project headless over MCP:
 *   connect (orchestrator lease) -> session.create -> orchestrator.enroll ->
 *   task.bulk_add (a backlog) -> the scheduler fans the tasks out across executor
 *   lanes up to capacity (spawnPolicy:auto), refilling as they finish -> the
 *   orchestrator audits each finished lane to accepted -> backlog.status reports
 *   complete + the batch-completion signal fires -> orchestrator.resign.
 *
 * Everything below the HTTP layer is exercised THROUGH the real stdio MCP server
 * (src/mcp-server.js), exactly as Claude Code CLI / Codex app / Claude Desktop
 * would. The mock executor keeps it deterministic and free (no agent tokens);
 * the sibling smoke:mcp-cli-handshake proves real claude/codex binaries connect.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER = path.join(here, '..', 'src', 'mcp-server.js');
const previousCwd = process.cwd();
const previousEnv = { ...process.env };
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-backlog-'));
const token = 'backlog-smoke-token';
let server = null;
let stopServer = null;
let base = '';
const clients = [];

const log = (label, info = '') => console.log(`[backlog] ${label}${info ? ' — ' + info : ''}`);
const fail = (label, info = '') => {
  console.error(`[backlog FAIL] ${label}${info ? ' — ' + info : ''}`);
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

class McpClient {
  constructor(role, env) {
    this.role = role;
    this.child = spawn('node', [MCP_SERVER], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
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

  close() { try { this.child.kill(); } catch { /* ignore */ } }
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
  process.chdir(tempDir);
  process.env.PORT = '0';
  process.env.ORCA_HOST = '127.0.0.1';
  process.env.ORCA_API_TOKEN = token;
  process.env.ORCA_CREDENTIAL_BACKEND = 'memory';
  process.env.ORCA_RATE_LIMIT_DISABLED = 'true';
  // Drive the orchestrator's audits ourselves (deterministic), and run fast.
  process.env.ORCA_AUTO_AUDIT = 'false';
  process.env.ORCA_HEARTBEAT_MS = '150';
  process.env.ORCA_AUTO_COMPLETE_MS = '250';

  const serverModule = await import('../src/server.js');
  server = await serverModule.startServer(0, '127.0.0.1');
  stopServer = serverModule.stopServer;
  base = `http://127.0.0.1:${server.address().port}`;
  log('server', base);

  // A project exists out of band; everything else is done over MCP by the chat.
  const project = await req('POST', '/api/projects', { actor: 'dashboard', approved: true, name: 'Backlog Flow Project' });
  if (project.status !== 201) fail('project create', JSON.stringify(project));
  const projectId = project.body.id;

  // Mint a project-scoped orchestrator lease (this is what the dashboard's
  // "Generate config" hands an external chat). It is NOT yet bound to a session.
  const lease = await req('POST', '/api/agent-tools/leases', { actor: 'claude-cli', role: 'orchestrator', projectId, ttlMs: 120_000 });
  if (lease.status !== 201) fail('orchestrator lease', JSON.stringify(lease));
  const orchToken = lease.body.leaseToken;

  const orch = new McpClient('orchestrator', {
    ORCA_AGENT_TOOLS_BASE_URL: base,
    ORCA_ROLE: 'orchestrator',
    ORCA_TOOL_LEASE_TOKEN: orchToken,
    ORCA_PROJECT_ID: projectId,
  });
  await orch.initialize();
  const tools = await orch.listToolNames();
  for (const need of ['session__create', 'orchestrator__enroll', 'task__bulk_add', 'backlog__status', 'orchestrator__status', 'lane__list']) {
    if (!tools.includes(need)) fail('orchestrator tools/list missing', need);
  }
  log('connect', `orchestrator lease, ${tools.length} tools incl. session/backlog/orchestrator`);

  // 1) Create a session entirely over MCP, with auto fan-out + capacity 2.
  const created = await orch.call('session__create', {
    projectId,
    body: { actor: 'claude-cli', approved: true, name: 'Headless Backlog', leader: 'mock', approvedCapacity: 2, spawnPolicy: 'auto' },
  });
  if (created.isError || !created.data?.id) fail('session__create over MCP', created.text);
  const sessionId = created.data.id;
  log('session__create', `${sessionId} (spawnPolicy=auto cap=2)`);

  // 2) Become the active orchestrator for it.
  const enroll = await orch.call('orchestrator__enroll', { sessionId, body: {} });
  if (enroll.isError || enroll.data?.activeOrchestrator?.actor !== 'claude-cli') fail('orchestrator__enroll', enroll.text);
  log('orchestrator__enroll', `active=${enroll.data.activeOrchestrator.actor}`);

  // 3) Load a backlog of 5 tasks in one call.
  const TASKS = ['Add header nav', 'Fix footer links', 'Write unit tests', 'Update README', 'Tune cache TTL'];
  const bulk = await orch.call('task__bulk_add', {
    sessionId,
    body: { actor: 'claude-cli', tasks: TASKS.map((title) => ({ title, executorType: 'mock' })) },
  });
  if (bulk.isError || bulk.data?.added !== TASKS.length) fail('task__bulk_add', bulk.text);
  log('task__bulk_add', `${bulk.data.added} tasks queued`);

  // 4) Auto fan-out: the scheduler spawns mock lanes up to capacity and refills.
  //    Drive each finished ('done') lane to accepted via the audit tools. Watch
  //    that in-flight tasks never exceed capacity (capacity-as-target).
  let maxExecuting = 0;
  const acceptedLanes = new Set();
  const deadline = Date.now() + 40_000;
  let status = null;
  while (Date.now() < deadline) {
    const backlog = await orch.call('backlog__status', { sessionId });
    if (backlog.isError) fail('backlog__status', backlog.text);
    status = backlog.data;

    // Capacity-as-target is about concurrently EXECUTING lanes (queued/starting/
    // running), not tasks awaiting audit — a done-but-unaudited lane frees its slot.
    const lanesRes = await orch.call('lane__list', { sessionId });
    const executing = (lanesRes.data || []).filter((l) => ['queued', 'starting', 'running'].includes(l.state)).length;
    maxExecuting = Math.max(maxExecuting, executing);

    // Accept any lane sitting at 'done' (its task is in_lane awaiting audit).
    for (const lane of (lanesRes.data || [])) {
      if (lane.state === 'done' && !acceptedLanes.has(lane.id)) {
        await orch.call('audit__queue_one', { laneId: lane.id, body: { actor: 'claude-cli', approved: true } });
        const accept = await orch.call('audit__accept', { laneId: lane.id, body: { actor: 'claude-cli', findings: ['looks good'] } });
        if (!accept.isError) acceptedLanes.add(lane.id);
      }
    }
    if (status.complete && status.allAccepted) break;
    await new Promise((r) => setTimeout(r, 150));
  }

  if (!status || !status.allAccepted) fail('backlog did not reach allAccepted', JSON.stringify(status));
  if (status.counts.total !== TASKS.length) fail('task count drift', JSON.stringify(status.counts));
  if (maxExecuting > 2) fail('capacity-as-target violated (executing lanes exceeded 2)', String(maxExecuting));
  log('fan-out', `${status.counts.accepted}/${status.counts.total} accepted; peak executing lanes=${maxExecuting} (cap 2)`);

  // 5) Batch-completion signal latched on the session.
  if (!status.completedAt) fail('batch-completion not latched', JSON.stringify(status));
  const events = await req('GET', `/api/sessions/${sessionId}/audit-events`);
  const completed = (events.body || []).filter((e) => e.type === 'session_backlog_completed');
  log('batch signal', `completedAt set; session_backlog_completed events=${completed.length}`);

  // 6) The tree view renders the accepted lanes.
  const statusView = await orch.call('orchestrator__status', { sessionId });
  if (statusView.isError || typeof statusView.data?.tree !== 'string') fail('orchestrator__status tree', statusView.text);
  log('orchestrator__status', `tree ${statusView.data.tree.split('\n').length} lines; nextRequiredTool=${statusView.data.nextRequiredTool}`);

  // 7) Hand off.
  const resign = await orch.call('orchestrator__resign', { sessionId, body: {} });
  if (resign.isError || resign.data?.released !== true) fail('orchestrator__resign', resign.text);
  const after = await orch.call('orchestrator__status', { sessionId });
  if (after.data?.activeOrchestrator?.active !== false) fail('resign did not clear ownership', after.text);
  log('orchestrator__resign', 'ownership released');

  log('done', 'headless MCP: session.create -> enroll -> backlog -> auto fan-out -> audit -> accepted -> resign');
} finally {
  await cleanup();
}
