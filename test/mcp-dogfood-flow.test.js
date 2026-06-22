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

test('real MCP dogfood flow drives orchestrator ownership, live links, backlog, lane creation, and status', async () => {
  await withRealOrcaServer(async ({ baseUrl, requestJson, token }) => {
    const project = await requestJson('/api/projects', {
      method: 'POST',
      body: { name: 'MCP Dogfood Project', approved: true },
    });
    assert.equal(project.status, 201);

    const session = await requestJson(`/api/projects/${project.body.id}/sessions`, {
      method: 'POST',
      body: {
        name: 'MCP Dogfood Session',
        leader: 'mock',
        approvedCapacity: 3,
        approved: true,
      },
    });
    assert.equal(session.status, 201);

    const bootstrap = await requestJson('/api/mcp/orchestrator-bootstrap', {
      method: 'POST',
      headers: { 'x-orca-token': token },
      body: {
        actor: 'codex-dogfood',
        projectId: project.body.id,
        sessionId: session.body.id,
        ttlMs: 10 * 60 * 1000,
        nodePath: process.execPath,
      },
    });
    assert.equal(bootstrap.status, 201);
    const env = bootstrap.body.bootstrap.clients.claudeDesktop.config.mcpServers.orca.env;
    assert.equal(env.ORCA_AGENT_TOOLS_BASE_URL, baseUrl);
    assert.equal(env.ORCA_PROJECT_ID, project.body.id);
    assert.equal(env.ORCA_SESSION_ID, session.body.id);
    assert.equal(env.ORCA_ROLE, 'orchestrator');

    const mcp = startMcpClient(env);
    try {
      const init = await mcp.request('initialize', { protocolVersion: '2024-11-05' });
      assert.equal(init.result.serverInfo.version, packageJson.version);
      assert.match(init.result.instructions, /orchestrator__enroll/);

      const listed = await mcp.request('tools/list');
      const toolNames = listed.result.tools.map((tool) => tool.name);
      assert.ok(toolNames.includes('orchestrator__message__send'));
      assert.ok(toolNames.includes('project__quick_link__upsert'));
      assert.ok(toolNames.includes('task__bulk_add'));

      const before = parseMcpJson(await mcp.callTool('session__next_action'));
      assert.equal(before.projectId, project.body.id);
      assert.equal(before.sessionId, session.body.id);
      assert.equal(before.nextRequiredTool, 'orchestrator.enroll');

      const refused = await mcp.callTool('lane__create', {
        body: { title: 'Too early', executorType: 'mock', approved: true },
      });
      assert.equal(refused.result.isError, true);
      assert.match(mcpText(refused), /No active orchestrator/i);

      const enrolled = parseMcpJson(await mcp.callTool('orchestrator__enroll', {
        body: { takeover: true },
      }));
      assert.equal(enrolled.activeOrchestrator.active, true);
      assert.equal(enrolled.activeOrchestrator.actor, 'codex-dogfood');

      const quickLink = parseMcpJson(await mcp.callTool('project__quick_link__upsert', {
        body: {
          label: 'Dogfood Orca',
          url: `${baseUrl}/`,
          localUrl: `${baseUrl}/`,
          kind: 'dashboard',
          favorite: true,
          approved: true,
        },
      }));
      assert.equal(quickLink.link.label, 'Dogfood Orca');

      const quickHealth = parseMcpJson(await mcp.callTool('project__quick_link__health', {
        linkId: quickLink.link.id,
        body: { approved: true },
      }));
      assert.equal(quickHealth.result.status, 'reachable');

      const tasks = parseMcpJson(await mcp.callTool('task__bulk_add', {
        body: {
          tasks: [
            { title: 'Audit MCP dogfood flow', description: 'Prove the external orchestrator can drive Orca.' },
            { title: 'Check private link', description: 'Verify the server-authoritative live link.' },
          ],
        },
      }));
      assert.equal(tasks.added, 2);

      const lane = parseMcpJson(await mcp.callTool('lane__create', {
        body: {
          title: 'Dogfood executor lane',
          executorType: 'mock',
          targetUrl: `${baseUrl}/`,
          approved: true,
        },
      }));
      assert.equal(lane.title, 'Dogfood executor lane');
      assert.equal(lane.owner, 'executor');

      const status = parseMcpJson(await mcp.callTool('orchestrator__status'));
      assert.equal(status.activeOrchestrator.actor, 'codex-dogfood');
      assert.equal(status.sessionId, session.body.id);
      assert.equal(status.backlog.counts.pending, 2);
      assert.ok(String(status.tree || '').includes('Dogfood executor lane'));
    } finally {
      mcp.close();
    }
  });
});
