#!/usr/bin/env node
/*
 * End-to-end proof that an external chat can attach to an already-running Orca
 * as SUPERVISOR through the real stdio MCP server:
 *   existing project/session/lane/orchestrator -> supervisor bootstrap ->
 *   MCP initialize/tools/list -> supervisor.overview -> lane.terminal.tail ->
 *   session.supervisor_audit -> scoped supervisor boundary denial.
 *
 * This mirrors Claude Code CLI / Codex app / Claude Desktop MCP transport while
 * keeping execution deterministic through the mock executor and local HTTP API.
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
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-supervisor-flow-'));
const token = 'supervisor-flow-smoke-token';
let server = null;
let stopServer = null;
let base = '';
const clients = [];

const log = (label, info = '') => console.log(`[mcp-supervisor] ${label}${info ? ' - ' + info : ''}`);
const fail = (label, info = '') => {
  console.error(`[mcp-supervisor FAIL] ${label}${info ? ' - ' + info : ''}`);
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
  constructor(role, config) {
    this.role = role;
    const launcher = config?.command
      ? config
      : { command: process.execPath, args: [MCP_SERVER], env: config || {} };
    this.child = spawn(launcher.command, launcher.args || [], {
      env: { ...process.env, ...(launcher.env || {}) },
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
    return (res.result?.tools || []).map((tool) => tool.name);
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

async function writeLaneTerminalLog(sessionId, laneId, text) {
  const logPath = path.join(process.cwd(), 'artifacts', sessionId, laneId, 'terminal.log');
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.writeFile(logPath, text);
}

async function cleanup() {
  for (const client of clients) client.close();
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
  process.env.ORCA_AUTO_AUDIT = 'false';

  const serverModule = await import('../src/server.js');
  server = await serverModule.startServer(0, '127.0.0.1');
  stopServer = serverModule.stopServer;
  process.env.PORT = String(server.address().port);
  base = `http://127.0.0.1:${server.address().port}`;
  log('server', base);

  const project = await req('POST', '/api/projects', { actor: 'dashboard', approved: true, name: 'Supervisor Flow Project' });
  if (project.status !== 201) fail('project create', JSON.stringify(project));
  const session = await req('POST', `/api/projects/${project.body.id}/sessions`, {
    actor: 'dashboard',
    approved: true,
    name: 'Supervisor Flow Session',
    leader: 'mock',
    approvedCapacity: 2,
    spawnPolicy: 'within_capacity',
  });
  if (session.status !== 201) fail('session create', JSON.stringify(session));
  const lane = await req('POST', `/api/sessions/${session.body.id}/lanes`, {
    actor: 'dashboard',
    approved: true,
    title: 'Existing executor lane',
    executorType: 'mock',
  });
  if (lane.status !== 201) fail('lane create', JSON.stringify(lane));
  const enroll = await req('POST', `/api/sessions/${session.body.id}/orchestrator/enroll`, {});
  if (enroll.status !== 200 || enroll.body?.activeOrchestrator?.actor !== 'dashboard') fail('existing orchestrator enroll', JSON.stringify(enroll));
  const task = await req('POST', `/api/sessions/${session.body.id}/tasks`, {
    actor: 'dashboard',
    approved: true,
    title: 'Pending supervised backlog item',
    executorType: 'mock',
  });
  if (task.status !== 201) fail('task create', JSON.stringify(task));

  const hiddenProject = await req('POST', '/api/projects', { actor: 'dashboard', approved: true, name: 'Hidden Supervisor Flow Project' });
  if (hiddenProject.status !== 201) fail('hidden project create', JSON.stringify(hiddenProject));
  const hiddenSession = await req('POST', `/api/projects/${hiddenProject.body.id}/sessions`, {
    actor: 'dashboard',
    approved: true,
    name: 'Hidden Supervisor Flow Session',
  });
  if (hiddenSession.status !== 201) fail('hidden session create', JSON.stringify(hiddenSession));
  const hiddenLane = await req('POST', `/api/sessions/${hiddenSession.body.id}/lanes`, {
    actor: 'dashboard',
    approved: true,
    title: 'Hidden executor lane',
    executorType: 'mock',
  });
  if (hiddenLane.status !== 201) fail('hidden lane create', JSON.stringify(hiddenLane));

  const counts = async () => {
    const projects = await req('GET', '/api/projects');
    const sessions = await Promise.all([
      req('GET', `/api/projects/${project.body.id}/sessions`),
      req('GET', `/api/projects/${hiddenProject.body.id}/sessions`),
    ]);
    const lanes = await Promise.all([
      req('GET', `/api/sessions/${session.body.id}/lanes`),
      req('GET', `/api/sessions/${hiddenSession.body.id}/lanes`),
    ]);
    return {
      projects: projects.body.length,
      sessions: sessions.reduce((sum, item) => sum + item.body.length, 0),
      lanes: lanes.reduce((sum, item) => sum + item.body.length, 0),
    };
  };
  const beforeBootstrap = await counts();

  const supervisorBootstrap = await req('POST', '/api/mcp/supervisor-bootstrap', {
    actor: 'supervisor-flow-chat',
    ttlMs: 120_000,
    nodePath: process.execPath,
  });
  if (supervisorBootstrap.status !== 201) fail('supervisor bootstrap', JSON.stringify(supervisorBootstrap));
  if (JSON.stringify(supervisorBootstrap.body).includes(token)) fail('supervisor bootstrap leaked admin token');
  const afterBootstrap = await counts();
  if (JSON.stringify(afterBootstrap) !== JSON.stringify(beforeBootstrap)) fail('supervisor bootstrap duplicated state', JSON.stringify({ beforeBootstrap, afterBootstrap }));

  const supervisor = new McpClient('supervisor', supervisorBootstrap.body.bootstrap.clients.claudeDesktop.config.mcpServers.orca);
  const init = await supervisor.initialize();
  if (!/supervisor__overview/.test(init.instructions || '')) fail('supervisor instructions missing overview');
  const tools = await supervisor.listToolNames();
  for (const need of ['supervisor__overview', 'session__supervisor_audit', 'lane__get', 'lane__terminal__tail']) {
    if (!tools.includes(need)) fail('supervisor tools/list missing', need);
  }
  for (const denied of ['lane__create', 'orchestrator__enroll', 'session__plan__update']) {
    if (tools.includes(denied)) fail('supervisor tools/list exposed mutating tool', denied);
  }
  const deniedSpawn = await supervisor.call('lane__create', {
    sessionId: session.body.id,
    body: { actor: 'supervisor-flow-chat', approved: true, title: 'Should not spawn', executorType: 'mock' },
  });
  if (!deniedSpawn.isError || !/Unknown or unavailable tool/.test(deniedSpawn.text)) fail('supervisor denied lane__create', deniedSpawn.text);

  const overview = await supervisor.call('supervisor__overview');
  if (overview.isError) fail('supervisor__overview', overview.text);
  const overviewProject = overview.data.projects.find((item) => item.id === project.body.id);
  const overviewHiddenProject = overview.data.projects.find((item) => item.id === hiddenProject.body.id);
  if (!overviewProject || !overviewHiddenProject) fail('global supervisor did not see all projects', JSON.stringify(overview.data.projects.map((item) => item.name)));
  const overviewSession = overviewProject.sessions.find((item) => item.id === session.body.id);
  if (!overviewSession) fail('supervisor overview missing session');
  if (overviewSession.activeOrchestrator?.actor !== 'dashboard') fail('supervisor overview missing active orchestrator', JSON.stringify(overviewSession.activeOrchestrator));
  if (overviewSession.nextRequiredTool !== 'lane.create') fail('supervisor overview wrong next action', overviewSession.nextRequiredTool);
  if (overviewSession.backlog?.counts?.pending !== 1) fail('supervisor overview missing backlog pending count', JSON.stringify(overviewSession.backlog));
  if (!overviewSession.lanes.some((item) => item.id === lane.body.id)) fail('supervisor overview missing executor lane');
  if (!overview.data.activeSupervisors.some((item) => item.actor === 'supervisor-flow-chat')) fail('supervisor overview missing active supervisor');
  log('overview', 'attached supervisor sees projects, active orchestrator, backlog, lanes, next action');

  await writeLaneTerminalLog(session.body.id, lane.body.id, 'SUPERVISOR FLOW LIVE OUTPUT\n');
  const tail = await supervisor.call('lane__terminal__tail', { laneId: lane.body.id, maxBytes: 4096 });
  if (tail.isError || tail.data?.text !== 'SUPERVISOR FLOW LIVE OUTPUT\n') fail('supervisor lane__terminal__tail', tail.text);
  log('terminal tail', `nextOffset=${tail.data.nextOffset}`);

  const audit = await supervisor.call('session__supervisor_audit', {
    sessionId: session.body.id,
    body: {
      verdict: 'request_fix',
      summary: 'Supervisor flow smoke requested a concrete fix.',
      findings: ['Real stdio supervisor MCP attached to existing Orca state.'],
      nextTask: 'Address the supervisor finding.',
    },
  });
  if (audit.isError || audit.data?.supervisorReview?.status !== 'fix_requested') fail('session__supervisor_audit', audit.text);
  const afterAudit = await counts();
  if (JSON.stringify(afterAudit) !== JSON.stringify(beforeBootstrap)) fail('supervisor audit duplicated state', JSON.stringify({ beforeBootstrap, afterAudit }));
  log('audit', 'recorded supervisor fix request without project/session/lane duplication');

  const scopedBootstrap = await req('POST', '/api/mcp/supervisor-bootstrap', {
    actor: 'scoped-supervisor-flow-chat',
    projectId: project.body.id,
    sessionId: session.body.id,
    ttlMs: 120_000,
    nodePath: process.execPath,
  });
  if (scopedBootstrap.status !== 201) fail('scoped supervisor bootstrap', JSON.stringify(scopedBootstrap));
  const scopedSupervisor = new McpClient('scoped-supervisor', scopedBootstrap.body.bootstrap.clients.claudeDesktop.config.mcpServers.orca);
  await scopedSupervisor.initialize();
  const scopedOverview = await scopedSupervisor.call('supervisor__overview');
  if (scopedOverview.isError) fail('scoped supervisor__overview', scopedOverview.text);
  if (scopedOverview.data.projects.length !== 1 || scopedOverview.data.projects[0].id !== project.body.id) {
    fail('scoped supervisor crossed project boundary', JSON.stringify(scopedOverview.data.projects.map((item) => item.id)));
  }
  if (scopedOverview.data.projects[0].sessions.length !== 1 || scopedOverview.data.projects[0].sessions[0].id !== session.body.id) {
    fail('scoped supervisor crossed session boundary', JSON.stringify(scopedOverview.data.projects[0].sessions.map((item) => item.id)));
  }
  await writeLaneTerminalLog(hiddenSession.body.id, hiddenLane.body.id, 'HIDDEN SUPERVISOR FLOW OUTPUT\n');
  const deniedTail = await scopedSupervisor.call('lane__terminal__tail', { laneId: hiddenLane.body.id, maxBytes: 4096 });
  if (!deniedTail.isError || !/Tool lease (project|session) mismatch/.test(deniedTail.text)) fail('scoped supervisor hidden tail denial', deniedTail.text);
  log('scope', 'scoped supervisor sees only allowed session and cannot tail hidden lane');

  log('done', 'real MCP supervisor attach -> overview -> terminal tail -> audit -> scoped denial');
} finally {
  await cleanup();
}
