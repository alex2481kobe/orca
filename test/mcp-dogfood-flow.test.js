import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const serverEntry = path.join(root, 'src', 'server.js');
const mcpServerPath = path.join(root, 'src', 'mcp-server.js');
const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
let importCounter = 0;

async function withRealOrcaServer(callback) {
  const previousCwd = process.cwd();
  const previousEnv = { ...process.env };
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-mcp-dogfood-'));
  process.chdir(tempDir);
  process.env.ORCA_API_TOKEN = 'dogfood-token';
  process.env.ORCA_AUTO_AUDIT = 'false';
  process.env.ORCA_RATE_LIMIT_DISABLED = 'true';
  process.env.ORCA_REPO_ROOTS = tempDir;
  process.env.PORT = '0';
  process.env.ORCA_HOST = '127.0.0.1';
  const moduleUrl = `${pathToFileURL(serverEntry).href}?mcp-dogfood=${Date.now()}-${++importCounter}`;
  const { startServer, stopServer } = await import(moduleUrl);
  const server = await startServer(0, '127.0.0.1');
  const port = server.address().port;
  process.env.PORT = String(port);
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
    await callback({ baseUrl, requestJson, token: process.env.ORCA_API_TOKEN });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (typeof stopServer === 'function') await stopServer();
    for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
    for (const [key, value] of Object.entries(previousEnv)) process.env[key] = value;
    process.chdir(previousCwd);
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
}

function startMcpClient(env) {
  const child = spawn(process.execPath, [mcpServerPath], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let nextId = 1;
  let buffer = '';
  let stderr = '';
  const pending = new Map();

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.on('exit', () => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`MCP server exited early. stderr: ${stderr}`));
    }
    pending.clear();
  });

  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP request timed out: ${method}. stderr: ${stderr}`));
    }, 8000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });

  return {
    request,
    callTool: (name, args = {}) => request('tools/call', { name, arguments: args }),
    close: () => child.kill(),
  };
}

function mcpText(response) {
  return String(response?.result?.content?.[0]?.text || '');
}

function parseMcpJson(response) {
  const text = mcpText(response);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Expected JSON MCP response, got: ${text}`);
  }
}

function runGit(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr?.trim() || result.stdout?.trim() || 'unknown git error'}`);
  }
  return result.stdout.trim();
}

async function realPath(candidate) {
  try {
    return await fs.realpath(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

function pathWithin(child, parent) {
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

async function createGitFixture(baseDir, name = 'fixture-repo') {
  const repoDir = path.join(baseDir, name);
  const originDir = path.join(baseDir, `${name}-origin.git`);
  await fs.mkdir(repoDir, { recursive: true });
  await fs.mkdir(originDir, { recursive: true });
  runGit(['init', '--bare'], originDir);
  runGit(['init'], repoDir);
  runGit(['config', 'user.email', 'orca-dogfood@example.test'], repoDir);
  runGit(['config', 'user.name', 'Orca Dogfood'], repoDir);
  await fs.writeFile(path.join(repoDir, 'README.md'), '# Orca MCP dogfood fixture\n');
  runGit(['add', 'README.md'], repoDir);
  runGit(['commit', '-m', 'Initial fixture commit'], repoDir);
  runGit(['branch', '-M', 'main'], repoDir);
  runGit(['remote', 'add', 'origin', originDir], repoDir);
  runGit(['push', '-u', 'origin', 'main'], repoDir);
  return { repoDir, originDir };
}

async function collectLaneStreamEvents({ baseUrl, sessionId, laneId, leaseToken }) {
  const logPath = await writeLaneTerminalLog(sessionId, laneId, 'DOGFOOD INITIAL OUTPUT\n');

  const events = [];
  const response = await fetch(`${baseUrl}/api/lanes/${laneId}/stream`, {
    headers: { 'x-orca-tool-lease': leaseToken },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type').includes('text/event-stream'), true);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let appended = false;
  const readLoop = (async () => {
    for (let i = 0; i < 50; i += 1) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const event = frame.match(/^event: (.+)$/m)?.[1] || '';
        const rawData = frame.match(/^data: (.+)$/m)?.[1] || '{}';
        if (event) events.push({ event, data: JSON.parse(rawData) });
      }
      if (!appended && events.some((entry) => entry.event === 'snapshot')) {
        appended = true;
        await fs.appendFile(logPath, 'DOGFOOD LIVE OUTPUT\n');
      }
      if (events.some((entry) => entry.event === 'append')) {
        break;
      }
    }
  })();

  const waitForAppend = (async () => {
    for (let i = 0; i < 40; i += 1) {
      if (events.some((entry) => entry.event === 'append')) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  })();
  await Promise.race([readLoop, waitForAppend, new Promise((resolve) => setTimeout(resolve, 4000))]);
  try { await reader.cancel(); } catch { /* ignore stream close races */ }
  return events;
}

async function writeLaneTerminalLog(sessionId, laneId, text) {
  const logPath = path.join(process.cwd(), 'artifacts', sessionId, laneId, 'terminal.log');
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.writeFile(logPath, text);
  return logPath;
}
test('real orchestrator MCP takeover attaches to existing state without duplicate records', async () => {
  await withRealOrcaServer(async ({ requestJson, token }) => {
    const project = await requestJson('/api/projects', {
      method: 'POST',
      body: { name: 'Real MCP Takeover Project', approved: true },
    });
    assert.equal(project.status, 201);
    const session = await requestJson(`/api/projects/${project.body.id}/sessions`, {
      method: 'POST',
      body: { name: 'Real MCP Takeover Session', approved: true },
    });
    assert.equal(session.status, 201);
    const lane = await requestJson(`/api/sessions/${session.body.id}/lanes`, {
      method: 'POST',
      body: { title: 'Existing takeover lane', executorType: 'mock', approved: true },
    });
    assert.equal(lane.status, 201);

    const counts = async () => {
      const projects = await requestJson('/api/projects');
      const sessions = await requestJson(`/api/projects/${project.body.id}/sessions`);
      const lanes = await requestJson(`/api/sessions/${session.body.id}/lanes`);
      assert.equal(projects.status, 200);
      assert.equal(sessions.status, 200);
      assert.equal(lanes.status, 200);
      return {
        projects: projects.body.length,
        sessions: sessions.body.length,
        lanes: lanes.body.length,
      };
    };
    const beforeBootstrap = await counts();

    const bootstrapA = await requestJson('/api/mcp/orchestrator-bootstrap', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'real-mcp-orchestrator-a',
        projectId: project.body.id,
        sessionId: session.body.id,
        ttlMs: 10 * 60 * 1000,
        nodePath: process.execPath,
      },
    });
    assert.equal(bootstrapA.status, 201);
    const bootstrapB = await requestJson('/api/mcp/orchestrator-bootstrap', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'real-mcp-orchestrator-b',
        projectId: project.body.id,
        sessionId: session.body.id,
        ttlMs: 10 * 60 * 1000,
        nodePath: process.execPath,
      },
    });
    assert.equal(bootstrapB.status, 201);
    assert.deepEqual(await counts(), beforeBootstrap);

    const mcpA = startMcpClient(bootstrapA.body.bootstrap.clients.claudeDesktop.config.mcpServers.orca.env);
    const mcpB = startMcpClient(bootstrapB.body.bootstrap.clients.claudeDesktop.config.mcpServers.orca.env);
    try {
      const enrolledA = parseMcpJson(await mcpA.callTool('orchestrator__enroll'));
      assert.equal(enrolledA.activeOrchestrator.actor, 'real-mcp-orchestrator-a');
      assert.deepEqual(await counts(), beforeBootstrap);

      const refusedB = await mcpB.callTool('orchestrator__enroll');
      assert.equal(refusedB.result.isError, true);
      assert.match(mcpText(refusedB), /already has an active orchestrator/i);
      assert.match(mcpText(refusedB), /real-mcp-orchestrator-a/);
      assert.deepEqual(await counts(), beforeBootstrap);

      const takeoverB = parseMcpJson(await mcpB.callTool('orchestrator__enroll', {
        body: { takeover: true },
      }));
      assert.equal(takeoverB.activeOrchestrator.actor, 'real-mcp-orchestrator-b');
      assert.deepEqual(await counts(), beforeBootstrap);

      const staleA = await mcpA.callTool('lane__create', {
        body: { title: 'Former owner must not spawn', executorType: 'mock', approved: true },
      });
      assert.equal(staleA.result.isError, true);
      assert.match(mcpText(staleA), /not the active orchestrator/i);
      assert.deepEqual(await counts(), beforeBootstrap);

      const statusB = parseMcpJson(await mcpB.callTool('orchestrator__status'));
      assert.equal(statusB.activeOrchestrator.actor, 'real-mcp-orchestrator-b');
      assert.equal(String(statusB.tree || '').includes('Existing takeover lane'), true);
    } finally {
      mcpA.close();
      mcpB.close();
    }
  });
});

test('real MCP orchestrator creates repo-backed sessions and worktree lanes', async () => {
  let unsafeRoot = null;
  try {
    await withRealOrcaServer(async ({ requestJson, token }) => {
      const { repoDir } = await createGitFixture(process.cwd(), 'mcp-worktree-repo');
      const repoReal = await realPath(repoDir);
      unsafeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-mcp-outside-repo-'));

    const project = await requestJson('/api/projects', {
      method: 'POST',
      body: { name: 'MCP Worktree Project', approved: true },
    });
    assert.equal(project.status, 201);
    const bootstrap = await requestJson('/api/mcp/orchestrator-bootstrap', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'codex-worktree-dogfood',
        projectId: project.body.id,
        ttlMs: 10 * 60 * 1000,
        nodePath: process.execPath,
      },
    });
    assert.equal(bootstrap.status, 201);
    assert.equal(bootstrap.body.lease.role, 'orchestrator');
    assert.equal(bootstrap.body.lease.projectId, project.body.id);

    const env = bootstrap.body.bootstrap.clients.claudeDesktop.config.mcpServers.orca.env;
    assert.equal(env.ORCA_PROJECT_ID, project.body.id);
    assert.equal(env.ORCA_SESSION_ID || '', '');
    const mcp = startMcpClient(env);
    try {
      const listed = await mcp.request('tools/list');
      const toolNames = listed.result.tools.map((tool) => tool.name);
      assert.ok(toolNames.includes('session__create'));
      assert.ok(toolNames.includes('session__worktree_policy__update'));
      assert.ok(toolNames.includes('lane__create'));

      const unsafeSession = await mcp.callTool('session__create', {
        body: {
          name: 'Unsafe repo session',
          approved: true,
          repoRoot: unsafeRoot,
        },
      });
      assert.equal(unsafeSession.result.isError, true);
      assert.match(mcpText(unsafeSession), /outside the approved repo roots/i);

      const session = parseMcpJson(await mcp.callTool('session__create', {
        body: {
          name: 'MCP Repo Session',
          leader: 'codex',
          approved: true,
          approvedCapacity: 2,
          spawnPolicy: 'within_capacity',
          worktreeMode: 'isolated',
          repoRoot: repoDir,
        },
      }));
      assert.equal(await realPath(session.repoRoot), repoReal);
      assert.equal(session.worktreeMode, 'isolated');

      const enrolled = parseMcpJson(await mcp.callTool('orchestrator__enroll', {
        sessionId: session.id,
        body: { takeover: true },
      }));
      assert.equal(enrolled.activeOrchestrator.active, true);
      assert.equal(enrolled.activeOrchestrator.actor, 'codex-worktree-dogfood');

      const isolatedLane = parseMcpJson(await mcp.callTool('lane__create', {
        sessionId: session.id,
        body: {
          title: 'MCP isolated worktree lane',
          executorType: 'mock',
          approved: true,
          branch: 'origin/main',
          taskPrompt: 'Prove origin/main becomes an isolated workflow branch.',
        },
      }));
      assert.equal(await realPath(isolatedLane.repoRoot), repoReal);
      assert.equal(isolatedLane.worktreeMode, 'isolated');
      assert.match(isolatedLane.branch, /^orca\/lane\//);
      assert.equal(isolatedLane.branch.startsWith('codex/'), false);
      const isolatedWorktreeReal = await realPath(isolatedLane.worktreePath);
      const isolatedBaseReal = await realPath(path.join(process.cwd(), '.orca', 'workspaces', session.id, 'worktrees'));
      assert.equal(pathWithin(isolatedWorktreeReal, isolatedBaseReal), true);
      const remoteHead = runGit(['rev-parse', 'origin/main'], repoDir);
      const isolatedHead = runGit(['rev-parse', 'HEAD'], isolatedLane.worktreePath);
      assert.equal(isolatedHead, remoteHead);

      const policy = parseMcpJson(await mcp.callTool('session__worktree_policy__update', {
        sessionId: session.id,
        body: { worktreeMode: 'shared', approved: true },
      }));
      assert.equal(policy.worktreeMode, 'shared');

      const sharedLane = parseMcpJson(await mcp.callTool('lane__create', {
        sessionId: session.id,
        body: {
          title: 'MCP shared worktree lane',
          executorType: 'mock',
          approved: true,
          branch: 'dogfood/shared-worktree',
          taskPrompt: 'Prove shared worktree mode uses the session repo root.',
        },
      }));
      assert.equal(sharedLane.worktreeMode, 'shared');
      assert.equal(await realPath(sharedLane.worktreePath), repoReal);
      assert.equal(await realPath(sharedLane.workdir), repoReal);
      assert.equal(sharedLane.branch, 'dogfood/shared-worktree');
      assert.equal(sharedLane.warnings.some((warning) => warning.kind === 'shared_worktree'), true);
      } finally {
        mcp.close();
      }
    });
  } finally {
    if (unsafeRoot) await fs.rm(unsafeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});
