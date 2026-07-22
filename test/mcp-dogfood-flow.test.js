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

// v2 orchestrator-native takeover: two external MCP orchestrators drive the REAL
// MCP server. A registers by cwd (implicitly creating the project) and spawns a
// lane; B cannot steal a live holder, but after A resigns B takes over the SAME
// orchestrator record (no duplicate project/orchestrator/lane), and the resigned
// former owner can no longer mutate the container.
test('real orchestrator MCP takeover attaches to existing state without duplicate records', async () => {
  await withRealOrcaServer(async ({ requestJson, token }) => {
    const cwd = await realPath(process.cwd());

    const bootstrapA = await requestJson('/api/mcp/orchestrator-bootstrap', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { actor: 'real-mcp-orchestrator-a', ttlMs: 10 * 60 * 1000, nodePath: process.execPath },
    });
    assert.equal(bootstrapA.status, 201);
    const bootstrapB = await requestJson('/api/mcp/orchestrator-bootstrap', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: { actor: 'real-mcp-orchestrator-b', ttlMs: 10 * 60 * 1000, nodePath: process.execPath },
    });
    assert.equal(bootstrapB.status, 201);

    const mcpA = startMcpClient(bootstrapA.body.bootstrap.clients.claudeDesktop.config.mcpServers.orca.env);
    const mcpB = startMcpClient(bootstrapB.body.bootstrap.clients.claudeDesktop.config.mcpServers.orca.env);
    try {
      // A registers as the orchestrator for the working dir and spawns a lane.
      const registered = parseMcpJson(await mcpA.callTool('orchestrator__register', {
        cwd, title: 'Takeover orchestrator',
      }));
      assert.equal(String(registered.id).startsWith('orc_'), true);
      const orchestratorId = registered.id;

      const lane = parseMcpJson(await mcpA.callTool('lane__create', {
        orchestratorId,
        body: { title: 'Existing takeover lane', executorType: 'mock', approved: true, taskPrompt: 'pre-takeover work' },
      }));
      assert.ok(lane.id, 'A spawned the pre-existing lane');

      // Count durable records: projects + lanes under the orchestrator container.
      const counts = async () => {
        const projects = await requestJson('/api/projects');
        const lanes = await requestJson(`/api/orchestrators/${orchestratorId}/lanes`);
        assert.equal(projects.status, 200);
        assert.equal(lanes.status, 200);
        return { projects: projects.body.length, lanes: lanes.body.length };
      };
      const before = await counts();

      // B cannot steal a LIVE holder — takeover of a non-stale orchestrator is refused.
      const refusedB = await mcpB.callTool('orchestrator__register', {
        cwd, takeoverOrchestratorId: orchestratorId,
      });
      assert.equal(refusedB.result.isError, true);
      assert.match(mcpText(refusedB), /not eligible for takeover/i);
      assert.deepEqual(await counts(), before);

      // A resigns; B takes over the SAME record (id unchanged, no new records).
      const resign = await mcpA.callTool('orchestrator__resign', { orchestratorId });
      assert.equal(resign.result.isError, false, mcpText(resign));
      const takeoverB = parseMcpJson(await mcpB.callTool('orchestrator__register', {
        cwd, takeoverOrchestratorId: orchestratorId,
      }));
      assert.equal(takeoverB.id, orchestratorId, 'takeover attaches to the existing orchestrator record');
      assert.deepEqual(await counts(), before);

      // The resigned former owner may no longer mutate the container.
      const staleA = await mcpA.callTool('lane__create', {
        orchestratorId,
        body: { title: 'Former owner must not spawn', executorType: 'mock', approved: true },
      });
      assert.equal(staleA.result.isError, true);
      assert.match(mcpText(staleA), /not the active orchestrator/i);
      assert.deepEqual(await counts(), before);

      // Status shows B as the active owner and still surfaces A's existing lane.
      const statusB = parseMcpJson(await mcpB.callTool('orchestrator__status', { orchestratorId }));
      assert.equal(statusB.activeOrchestrator.active, true);
      assert.equal(String(statusB.tree || '').includes('Existing takeover lane'), true);
    } finally {
      mcpA.close();
      mcpB.close();
    }
  });
});

// v2 orchestrator-native worktree isolation: an external MCP orchestrator
// registers a git repo by cwd and spawns executor lanes that run in isolated git
// worktrees under the orchestrator container. registerOrchestrator enforces the
// cwd ∈ approved-roots guard the old session repoRoot validation used to.
test('real MCP orchestrator registers a repo by cwd and spawns isolated worktree lanes', async () => {
  let unsafeRoot = null;
  try {
    await withRealOrcaServer(async ({ requestJson, token }) => {
      const { repoDir } = await createGitFixture(process.cwd(), 'mcp-worktree-repo');
      const repoReal = await realPath(repoDir);
      unsafeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-mcp-outside-repo-'));

      // Unscoped orchestrator bootstrap: the agent registers by cwd, not a session.
      const bootstrap = await requestJson('/api/mcp/orchestrator-bootstrap', {
        method: 'POST',
        headers: { 'x-orca-token': token },
        body: { actor: 'codex-worktree-dogfood', ttlMs: 10 * 60 * 1000, nodePath: process.execPath },
      });
      assert.equal(bootstrap.status, 201);
      assert.equal(bootstrap.body.lease.role, 'orchestrator');

      const env = bootstrap.body.bootstrap.clients.claudeDesktop.config.mcpServers.orca.env;
      const mcp = startMcpClient(env);
      try {
        const listed = await mcp.request('tools/list');
        const toolNames = listed.result.tools.map((tool) => tool.name);
        // v2 removed the session.* MCP surface (session.create + worktree-policy);
        // orchestrator registration + lane tools stay callable over MCP.
        assert.equal(toolNames.includes('session__create'), false);
        assert.equal(toolNames.includes('session__worktree_policy__update'), false);
        assert.ok(toolNames.includes('orchestrator__register'));
        assert.ok(toolNames.includes('lane__create'));

        // registerOrchestrator enforces cwd ∈ approved roots (the repoRoot guard).
        const unsafe = await mcp.callTool('orchestrator__register', { cwd: unsafeRoot });
        assert.equal(unsafe.result.isError, true);
        assert.match(mcpText(unsafe), /outside the approved repo roots/i);

        // Register the git repo as the orchestrator container (project keyed by cwd).
        const registered = parseMcpJson(await mcp.callTool('orchestrator__register', {
          cwd: repoReal, title: 'MCP Repo Orchestrator',
        }));
        assert.equal(String(registered.id).startsWith('orc_'), true);
        const orchestratorId = registered.id;
        assert.equal(await realPath((await requestJson('/api/projects')).body
          .find((p) => p.id === registered.projectId).cwd), repoReal);

        // Spawn an executor lane that isolates in its own managed git worktree.
        const isolatedLane = parseMcpJson(await mcp.callTool('lane__create', {
          orchestratorId,
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
        assert.notEqual(isolatedWorktreeReal, repoReal);
        const isolatedBaseReal = await realPath(path.join(process.cwd(), '.orca', 'workspaces', orchestratorId, 'worktrees'));
        assert.equal(pathWithin(isolatedWorktreeReal, isolatedBaseReal), true);
        const remoteHead = runGit(['rev-parse', 'origin/main'], repoDir);
        const isolatedHead = runGit(['rev-parse', 'HEAD'], isolatedLane.worktreePath);
        assert.equal(isolatedHead, remoteHead);
      } finally {
        mcp.close();
      }
    });
  } finally {
    if (unsafeRoot) await fs.rm(unsafeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});
