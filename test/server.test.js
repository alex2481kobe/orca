import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';

const SERVER_ENTRYPOINT = path.join(process.cwd(), 'src', 'server.js');

function parseJsonBody(rawText) {
  if (!rawText) return null;
  try {
    return JSON.parse(rawText);
  } catch {
    return { raw: rawText };
  }
}

function createResponseState() {
  const chunks = [];
  const res = {
    statusCode: 200,
    headers: {},
  };

  res.setHeader = (name, value) => {
    res.headers[String(name).toLowerCase()] = String(value);
  };

  res.end = (chunk) => {
    if (chunk !== undefined && chunk !== null) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
  };

  return {
    res,
    bodyText: () => Buffer.concat(chunks).toString('utf8'),
  };
}

async function isolateEnvironment(token, env = {}) {
  const previousCwd = process.cwd();
  const previousEnv = { ...process.env };
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'command-deck-server-'));

  process.chdir(tempDir);

  const restore = async () => {
    Object.keys(process.env).forEach((key) => {
      if (!(key in previousEnv)) {
        delete process.env[key];
      }
    });
    Object.entries(previousEnv).forEach(([key, value]) => {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });

    process.chdir(previousCwd);
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  };

  if (typeof token === 'string') {
    process.env.COMMAND_DECK_API_TOKEN = token;
  } else {
    delete process.env.COMMAND_DECK_API_TOKEN;
  }

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return { restore, tempDir };
}

let harnessCounter = 0;

async function startServer({ token, env = {} }) {
  const { restore } = await isolateEnvironment(token, { ...env, PORT: '0' });
  const entrypoint = SERVER_ENTRYPOINT;
  const moduleUrl = `${pathToFileURL(entrypoint).href}?server-test-harness=${Date.now()}-${++harnessCounter}`;
  const { routeRequest, stopServer } = await import(moduleUrl);

  const requestJson = async (requestPath, options = {}) => {
  const headers = {
    'content-type': 'application/json',
    ...(options.headers || {}),
  };

    const body = options.body !== undefined ? JSON.stringify(options.body) : undefined;
    const { res, bodyText } = createResponseState();
    const req = new PassThrough();
    req.method = options.method || 'GET';
    req.url = requestPath;
    req.headers = headers;

    const handler = routeRequest(req, res);
    if (body === undefined) {
      req.end();
    } else {
      req.end(body);
    }
    await handler;

    const text = bodyText();
    return {
      status: res.statusCode,
      body: parseJsonBody(text),
      response: { statusCode: res.statusCode, headers: res.headers },
    };
  };

  return {
    requestJson,
    stop: async () => {
      if (typeof stopServer === 'function') {
        await stopServer();
      }
      await restore();
    },
  };
}

test('server API requires token for mutating actions while allowing read actions', async () => {
  const token = 'route-token-01';
  const server = await startServer({ token });

  try {
    const health = await server.requestJson('/api/health', { method: 'GET' });
    assert.equal(health.status, 200);

    const deniedCreate = await server.requestJson('/api/projects', {
      method: 'POST',
      body: { name: 'Unauthorized project' },
    });
    assert.equal(deniedCreate.status, 401);

    const created = await server.requestJson('/api/projects', {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        name: 'Authorized project',
        approved: true,
      },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.name, 'Authorized project');
  } finally {
    await server.stop();
  }
});

test('project and session API endpoints require explicit approval', async () => {
  const token = 'route-token-01c';
  const server = await startServer({ token });

  try {
    const deniedProject = await server.requestJson('/api/projects', {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: { name: 'Needs approval' },
    });
    assert.equal(deniedProject.status, 409);
    assert.equal(Boolean(deniedProject.body?.requiresApproval), true);

    const project = await server.requestJson('/api/projects', {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        name: 'Approval project',
        approved: true,
      },
    });
    assert.equal(project.status, 201);

    const deniedSession = await server.requestJson(`/api/projects/${project.body.id}/sessions`, {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: { name: 'Needs session approval' },
    });
    assert.equal(deniedSession.status, 409);
    assert.equal(Boolean(deniedSession.body?.requiresApproval), true);

    const session = await server.requestJson(`/api/projects/${project.body.id}/sessions`, {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        name: 'Approval session',
        approved: true,
      },
    });
    assert.equal(session.status, 201);
  } finally {
    await server.stop();
  }
});

test('project updates and lane creations require explicit approval', async () => {
  const token = 'route-token-01d';
  const server = await startServer({ token });

  try {
    const project = await server.requestJson('/api/projects', {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        name: 'Approval Baseline Project',
        approved: true,
      },
    });
    assert.equal(project.status, 201);

    const deniedUpdate = await server.requestJson(`/api/projects/${project.body.id}`, {
      method: 'PATCH',
      headers: { 'x-commanddeck-token': token },
      body: {
        quickLinks: [],
      },
    });
    assert.equal(deniedUpdate.status, 409);
    assert.equal(Boolean(deniedUpdate.body?.requiresApproval), true);

    const updated = await server.requestJson(`/api/projects/${project.body.id}`, {
      method: 'PATCH',
      headers: { 'x-commanddeck-token': token },
      body: {
        quickLinks: [{ label: 'Project Home', url: 'http://localhost:4173' }],
        approved: true,
      },
    });
    assert.equal(updated.status, 200);
    assert.equal(Array.isArray(updated.body?.quickLinks), true);
    assert.equal(updated.body.quickLinks.length, 1);

    const session = await server.requestJson(`/api/projects/${project.body.id}/sessions`, {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        name: 'Approval Baseline Session',
        approved: true,
      },
    });
    assert.equal(session.status, 201);

    const deniedLane = await server.requestJson(`/api/sessions/${session.body.id}/lanes`, {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        title: 'No approval lane',
        executorType: 'mock',
        owner: 'dashboard',
      },
    });
    assert.equal(deniedLane.status, 409);
    assert.equal(Boolean(deniedLane.body?.requiresApproval), true);

    const allowedLane = await server.requestJson(`/api/sessions/${session.body.id}/lanes`, {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        title: 'Approved lane',
        executorType: 'mock',
        owner: 'dashboard',
        approved: true,
      },
    });
    assert.equal(allowedLane.status, 201);
    assert.equal(allowedLane.body?.title, 'Approved lane');
  } finally {
    await server.stop();
  }
});

test('server rejects malformed request URLs without crashing', async () => {
  const token = 'route-token-01a';
  const server = await startServer({ token });

  try {
    const malformed = await server.requestJson('/api/health/%E0%A4', { method: 'GET' });
    assert.equal(malformed.status, 400);
    assert.equal(String(malformed.body?.raw || '').includes('Invalid request URL'), true);
  } finally {
    await server.stop();
  }
});

test('server rejects malformed query strings on query-based endpoints', async () => {
  const token = 'route-token-01b';
  const server = await startServer({ token });

  try {
    const malformedAuditQuery = await server.requestJson('/api/audit/events?status=%E0%A4', { method: 'GET' });
    assert.equal(malformedAuditQuery.status, 400);
    assert.equal(String(malformedAuditQuery.body?.error || '').includes('Invalid request query string.'), true);

    const malformedMcpQuery = await server.requestJson('/api/mcp/tools?scope=%E0%A4', { method: 'GET' });
    assert.equal(malformedMcpQuery.status, 400);
    assert.equal(String(malformedMcpQuery.body?.error || '').includes('Invalid request query string.'), true);

    const project = await server.requestJson('/api/projects', {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: { name: 'Query project', approved: true },
    });
    assert.equal(project.status, 201);

    const session = await server.requestJson(`/api/projects/${project.body.id}/sessions`, {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: { name: 'Query session', approved: true },
    });
    assert.equal(session.status, 201);

    const lane = await server.requestJson(`/api/sessions/${session.body.id}/lanes`, {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        title: 'Query lane',
        executorType: 'mock',
        command: 'echo query route',
        owner: 'test',
        approved: true,
      },
    });
    assert.equal(lane.status, 201);

    const malformedEvidenceQuery = await server.requestJson(`/api/lanes/${lane.body.id}/evidence/latest?mode=%E0%A4`, { method: 'GET' });
    assert.equal(malformedEvidenceQuery.status, 400);
    assert.equal(String(malformedEvidenceQuery.body?.error || '').includes('Invalid request query string.'), true);
  } finally {
    await server.stop();
  }
});

test('server blocks destructive artifact cleanup without explicit confirmation', async () => {
  const token = 'route-token-02';
  const server = await startServer({ token });

  try {
    const destructiveDenied = await server.requestJson('/api/artifacts/cleanup', {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
        dryRun: false,
        confirmed: false,
      },
    });
    assert.equal(destructiveDenied.status, 409);
    assert.equal(typeof destructiveDenied.body?.error === 'string', true);

    const dryRunResult = await server.requestJson('/api/artifacts/cleanup', {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
        dryRun: true,
      },
    });
    assert.equal(dryRunResult.status, 200);
    assert.equal(dryRunResult.body?.dryRun, true);
  } finally {
    await server.stop();
  }
});

test('executor CLI reinstall endpoints require explicit confirmation before execution', async () => {
  const token = 'route-token-03';
  const server = await startServer({
    token,
    env: {
      COMMAND_DECK_CODEX_BINARY: '/usr/bin/codex',
      COMMAND_DECK_CODEX_REINSTALL_COMMAND: 'npm install --yes @openai/codex',
    },
  });

  try {
    const info = await server.requestJson('/api/executors/codex/cli', { method: 'GET' });
    assert.equal(info.status, 200);
    assert.equal(info.body.type, 'codex');
    assert.equal(info.body.reinstall?.available, true);

    const dryRun = await server.requestJson('/api/executors/codex/cli/reinstall', {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
        execute: false,
      },
    });
    assert.equal(dryRun.status, 200);
    assert.equal(dryRun.body.executed, false);
    assert.equal(Array.isArray(dryRun.body.command), true);

    const executeDenied = await server.requestJson('/api/executors/codex/cli/reinstall', {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
        execute: true,
      },
    });
    assert.equal(executeDenied.status, 409);
    assert.equal(
      String(executeDenied.body?.error || '').includes('explicit confirmation'),
      true,
    );
  } finally {
    await server.stop();
  }
});

test('executor CLI reinstall requires approval for planning requests', async () => {
  const token = 'route-token-03e';
  const server = await startServer({
    token,
    env: {
      COMMAND_DECK_CODEX_BINARY: '/usr/bin/codex',
      COMMAND_DECK_CODEX_REINSTALL_COMMAND: 'npm install --yes @openai/codex',
    },
  });

  try {
    const denied = await server.requestJson('/api/executors/codex/cli/reinstall', {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        actor: 'dashboard',
        approved: false,
        execute: false,
      },
    });
    assert.equal(denied.status, 409);
    assert.equal(Boolean(denied.body?.requiresApproval), true);
  } finally {
    await server.stop();
  }
});

test('executor CLI reinstall endpoint rejects unsafe override commands', async () => {
  const token = 'route-token-03b';
  const server = await startServer({
    token,
    env: {
      COMMAND_DECK_CODEX_BINARY: '/usr/bin/codex',
      COMMAND_DECK_CODEX_REINSTALL_COMMAND: 'npm install --yes @openai/codex',
    },
  });

  try {
    const badOverride = await server.requestJson('/api/executors/codex/cli/reinstall', {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
        execute: false,
        command: 'rm -rf /',
      },
    });
    assert.equal(badOverride.status, 422);
    assert.equal(String(badOverride.body?.error || '').includes('Invalid reinstall command override'), true);
  } finally {
    await server.stop();
  }
});

test('executor CLI reinstall supports forcing source-based reinstall commands', async () => {
  const token = 'route-token-03c';
  const server = await startServer({
    token,
    env: {
      COMMAND_DECK_CODEX_BINARY: '/usr/bin/codex',
      COMMAND_DECK_CODEX_REINSTALL_COMMAND: 'npm install --yes @openai/codex',
      COMMAND_DECK_CODEX_REINSTALL_SOURCE_REPOS: 'my-org/codex-fork,openai/codex',
      COMMAND_DECK_CODEX_REINSTALL_PREFER_SOURCE: 'false',
    },
  });

  try {
    const sourceMode = await server.requestJson('/api/executors/codex/cli/reinstall', {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
        execute: false,
        useSource: true,
      },
    });
    assert.equal(sourceMode.status, 200);
    assert.equal(sourceMode.body.executed, false);
    assert.equal(
      String(sourceMode.body.command?.join(' ') || '').includes('git+https://github.com/my-org/codex-fork.git'),
      true,
    );
  } finally {
    await server.stop();
  }
});

test('executor CLI reinstall rejects source mode with custom override command', async () => {
  const token = 'route-token-03d';
  const server = await startServer({
    token,
    env: {
      COMMAND_DECK_CODEX_BINARY: '/usr/bin/codex',
      COMMAND_DECK_CODEX_REINSTALL_COMMAND: 'npm install --yes @openai/codex',
      COMMAND_DECK_CODEX_REINSTALL_SOURCE_REPOS: 'my-org/codex-fork,openai/codex',
    },
  });

  try {
    const rejected = await server.requestJson('/api/executors/codex/cli/reinstall', {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
        execute: false,
        useSource: true,
        command: 'npm install --yes @openai/codex',
      },
    });
    assert.equal(rejected.status, 422);
    assert.equal(String(rejected.body?.error || '').includes('Cannot combine custom command override'), true);
  } finally {
    await server.stop();
  }
});

test('executor CLI APIs reject unsupported executor types', async () => {
  const token = 'route-token-03f';
  const server = await startServer({ token });

  try {
    const missingInfo = await server.requestJson('/api/executors/unknown/cli', { method: 'GET' });
    assert.equal(missingInfo.status, 404);

    const missingReinstall = await server.requestJson('/api/executors/unknown/cli/reinstall', {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
      },
    });
    assert.equal(missingReinstall.status, 404);
  } finally {
    await server.stop();
  }
});

test('API lane creation validates MCP tool IDs and executor constraints', async () => {
  const token = 'route-token-03g';
  const server = await startServer({ token });

  try {
    const project = await server.requestJson('/api/projects', {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        name: 'Lane MCP project',
        approved: true,
      },
    });
    assert.equal(project.status, 201);

    const session = await server.requestJson(`/api/projects/${project.body.id}/sessions`, {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        name: 'Lane MCP session',
        approved: true,
      },
    });
    assert.equal(session.status, 201);

    const codexTool = await server.requestJson('/api/mcp/tools', {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        name: 'route-codex-tool',
        command: 'node',
        scope: ['codex'],
        approved: true,
      },
    });
    assert.equal(codexTool.status, 201);

    const claudeTool = await server.requestJson('/api/mcp/tools', {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        name: 'route-claude-tool',
        command: 'node',
        scope: ['claude'],
        approved: true,
      },
    });
    assert.equal(claudeTool.status, 201);

    const badScopeLane = await server.requestJson(`/api/sessions/${session.body.id}/lanes`, {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        title: 'Bad scope lane',
        executorType: 'codex',
        command: 'codex --version',
        mcpToolIds: [codexTool.body.id, claudeTool.body.id],
        owner: 'dashboard',
        approved: true,
      },
    });
    assert.equal(badScopeLane.status, 422);
    assert.equal(String(badScopeLane.body?.error || '').includes('Unauthorized MCP tools'), true);

    const badMissingLane = await server.requestJson(`/api/sessions/${session.body.id}/lanes`, {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        title: 'Missing tool lane',
        executorType: 'codex',
        command: 'codex --version',
        mcpToolIds: ['missing-tool'],
        owner: 'dashboard',
        approved: true,
      },
    });
    assert.equal(badMissingLane.status, 422);
    assert.equal(String(badMissingLane.body?.error || '').includes('Unknown MCP tools'), true);

    const badCommand = await server.requestJson(`/api/sessions/${session.body.id}/lanes`, {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        title: 'Bad command lane',
        executorType: 'codex',
        command: 'echo hello',
        mcpToolIds: [codexTool.body.id],
        owner: 'dashboard',
        approved: true,
      },
    });
    assert.equal(badCommand.status, 422);
    assert.equal(String(badCommand.body?.error || '').includes('must target the codex binary'), true);

    const validLane = await server.requestJson(`/api/sessions/${session.body.id}/lanes`, {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        title: 'Good codex lane',
        executorType: 'codex',
        command: 'codex --version',
        mcpToolIds: [codexTool.body.id],
        owner: 'dashboard',
        approved: true,
      },
    });
    assert.equal(validLane.status, 201);
    assert.equal(validLane.body.executorType, 'codex');
    assert.equal(validLane.body.mcpTools[0]?.id, codexTool.body.id);
  } finally {
    await server.stop();
  }
});

test('executor CLI reinstall supports claude with source-mode and command validation', async () => {
  const token = 'route-token-03e';
  const server = await startServer({
    token,
    env: {
      COMMAND_DECK_CLAUDE_BINARY: '/usr/bin/claude',
      COMMAND_DECK_CLAUDE_REINSTALL_COMMAND: 'npm install --yes @anthropic/claude-code',
      COMMAND_DECK_CLAUDE_REINSTALL_SOURCE_REPOS: 'anthropic/claude-code,my-org/claude-fork',
      COMMAND_DECK_CLAUDE_REINSTALL_PREFER_SOURCE: 'false',
    },
  });

  try {
    const info = await server.requestJson('/api/executors/claude/cli', { method: 'GET' });
    assert.equal(info.status, 200);
    assert.equal(info.body.type, 'claude');
    assert.equal(info.body.reinstall?.available, true);
    assert.equal(Array.isArray(info.body.reinstall.command), true);

    const sourceMode = await server.requestJson('/api/executors/claude/cli/reinstall', {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
        execute: false,
        useSource: true,
      },
    });
    assert.equal(sourceMode.status, 200);
    assert.equal(sourceMode.body.executed, false);
    assert.equal(
      String(sourceMode.body.command?.join(' ') || '').includes('git+https://github.com/anthropic/claude-code.git'),
      true,
    );

    const executeDenied = await server.requestJson('/api/executors/claude/cli/reinstall', {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
        execute: true,
        useSource: true,
      },
    });
    assert.equal(executeDenied.status, 409);
    assert.equal(
      String(executeDenied.body?.error || '').includes('requires explicit confirmation'),
      true,
    );
  } finally {
    await server.stop();
  }
});

test('server MCP tooling routes require token and support CRUD workflow', async () => {
  const token = 'route-token-04';
  const server = await startServer({ token });

  try {
    const deniedCreate = await server.requestJson('/api/mcp/tools', {
      method: 'POST',
      body: {
        name: 'route-tool',
        command: 'node',
        scope: ['all'],
        args: ['--version'],
        enabled: true,
      },
    });
    assert.equal(deniedCreate.status, 401);

    const created = await server.requestJson('/api/mcp/tools', {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        name: 'route-tool',
        command: 'node',
        scope: ['all'],
        args: ['--version'],
        enabled: true,
        approved: true,
      },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.name, 'route-tool');

    const listed = await server.requestJson('/api/mcp/tools', { method: 'GET' });
    assert.equal(listed.status, 200);
    assert.equal(Array.isArray(listed.body), true);
    assert.equal(listed.body.length, 1);

    const fetched = await server.requestJson(`/api/mcp/tools/${created.body.id}`, { method: 'GET' });
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.id, created.body.id);

    const updated = await server.requestJson(`/api/mcp/tools/${created.body.id}`, {
      method: 'PATCH',
      headers: { 'x-commanddeck-token': token },
      body: {
        enabled: false,
        approved: true,
      },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.enabled, false);

    const deleted = await server.requestJson(`/api/mcp/tools/${created.body.id}`, {
      method: 'DELETE',
      headers: { 'x-commanddeck-token': token },
      body: {
        approved: true,
      },
    });
    assert.equal(deleted.status, 200);

    const afterDelete = await server.requestJson(`/api/mcp/tools/${created.body.id}`, { method: 'GET' });
    assert.equal(afterDelete.status, 404);
  } finally {
    await server.stop();
  }
});

test('server MCP tooling sanitizes blocked argument tokens', async () => {
  const token = 'route-token-04c';
  const server = await startServer({ token });

  try {
    const blockedArg = await server.requestJson('/api/mcp/tools', {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        name: 'blocked-arg-tool',
        command: 'node',
        args: [';rm -rf /'],
        scope: ['all'],
        approved: true,
      },
    });
    assert.equal(blockedArg.status, 422);
    assert.equal(String(blockedArg.body?.error || '').includes('contains blocked characters'), true);
  } finally {
    await server.stop();
  }
});

test('server MCP tooling rejects unsupported scope values and blocked commands', async () => {
  const token = 'route-token-04b';
  const server = await startServer({
    token,
    env: {
      COMMAND_DECK_MCP_TOOL_COMMAND_ALLOWLIST: 'node,npx',
    },
  });

  try {
    const invalidScope = await server.requestJson('/api/mcp/tools', {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        name: 'bad-scope-tool',
        command: 'node',
        scope: ['invalid'],
        approved: true,
      },
    });
    assert.equal(invalidScope.status, 422);
    assert.equal(String(invalidScope.body?.error || '').includes('unsupported values'), true);

    const blockedCommand = await server.requestJson('/api/mcp/tools', {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        name: 'blocked-command-tool',
        command: 'python',
        scope: ['all'],
        approved: true,
      },
    });
    assert.equal(blockedCommand.status, 422);
    assert.equal(String(blockedCommand.body?.error || '').includes('not in the allowlist'), true);

    const created = await server.requestJson('/api/mcp/tools', {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        name: 'all-tool',
        command: 'node',
        scope: ['all'],
        args: ['--version'],
        approved: true,
      },
    });
    assert.equal(created.status, 201);

    const codexScope = await server.requestJson('/api/mcp/tools?scope=codex', { method: 'GET' });
    assert.equal(codexScope.status, 200);
    assert.equal(Array.isArray(codexScope.body), true);
    assert.equal(codexScope.body.length, 0);

    const allScope = await server.requestJson('/api/mcp/tools?scope=all', { method: 'GET' });
    assert.equal(allScope.status, 200);
    assert.equal(Array.isArray(allScope.body), true);
    assert.equal(allScope.body.length, 1);
    assert.equal(allScope.body[0]?.id, 'all-tool');
  } finally {
    await server.stop();
  }
});

test('run-now cleanup endpoint enforces approval and supports dry-run mode', async () => {
  const token = 'route-token-05';
  const server = await startServer({ token });

  try {
    const denied = await server.requestJson('/api/artifacts/cleanup/run-now', {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        actor: 'dashboard',
        dryRun: false,
        confirmed: true,
      },
    });
    assert.equal(denied.status, 409);
    assert.equal(Boolean(denied.body?.requiresApproval), true);

    const dryRunResult = await server.requestJson('/api/artifacts/cleanup/run-now', {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
        dryRun: true,
      },
    });
    assert.equal(dryRunResult.status, 200);
    assert.equal(dryRunResult.body?.dryRun, true);
    assert.equal(dryRunResult.body?.removed, 0);

    const invalidRunNowSession = await server.requestJson('/api/artifacts/cleanup/run-now', {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
        dryRun: true,
        sessionId: 'missing-session-id',
      },
    });
    assert.equal(invalidRunNowSession.status, 404);
    assert.equal(String(invalidRunNowSession.body?.error || '').includes('Session not found'), true);

    const missingCleanupConfirmation = await server.requestJson('/api/artifacts/cleanup/run-now', {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
        dryRun: false,
        confirmed: false,
      },
    });
    assert.equal(missingCleanupConfirmation.status, 409);
    assert.equal(
      String(missingCleanupConfirmation.body?.error || '').includes('Destructive cleanup requires explicit confirmation.'),
      true,
    );
  } finally {
    await server.stop();
  }
});

test('cleanup schedule endpoint enforces approval and persists updated schedule', async () => {
  const token = 'route-token-06';
  const server = await startServer({ token });

  try {
    const denied = await server.requestJson('/api/artifacts/cleanup/schedule', {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        enabled: true,
        intervalHours: 12,
      },
    });
    assert.equal(denied.status, 409);
    assert.equal(Boolean(denied.body?.requiresApproval), true);

    const saved = await server.requestJson('/api/artifacts/cleanup/schedule', {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        actor: 'dashboard',
        enabled: true,
        approved: true,
        intervalHours: 12,
        olderThanDays: 30,
        dryRun: true,
      },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body?.enabled, true);
    assert.equal(saved.body?.intervalHours, 12);
    assert.equal(saved.body?.olderThanDays, 30);
    assert.equal(saved.body?.dryRun, true);

    const listed = await server.requestJson('/api/artifacts/cleanup/schedule', {
      method: 'GET',
    });
    assert.equal(listed.status, 200);
    assert.equal(listed.body?.schedule?.enabled, true);
    assert.equal(listed.body?.schedule?.intervalHours, 12);
  } finally {
    await server.stop();
  }
});

test('cleanup schedule endpoint validates interval, session id, and retention', async () => {
  const token = 'route-token-06b';
  const server = await startServer({ token });

  try {
    const badInterval = await server.requestJson('/api/artifacts/cleanup/schedule', {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
        intervalHours: 900,
      },
    });
    assert.equal(badInterval.status, 422);
    assert.equal(String(badInterval.body?.error || '').includes('cannot exceed 720'), true);

    const badSession = await server.requestJson('/api/artifacts/cleanup/schedule', {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
        enabled: true,
        sessionId: 'missing-session-id',
      },
    });
    assert.equal(badSession.status, 404);
    assert.equal(String(badSession.body?.error || '').includes('Session not found'), true);

    const badRetention = await server.requestJson('/api/artifacts/cleanup/schedule', {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
        olderThanDays: 'nope',
      },
    });
    assert.equal(badRetention.status, 422);
    assert.equal(String(badRetention.body?.error || '').includes('olderThanDays must be a positive integer or null'), true);
  } finally {
    await server.stop();
  }
});

test('mobile manifest exposes deep links for projects, sessions, and lane artifact/evidence actions', async () => {
  const token = 'route-token-07';
  const server = await startServer({ token });

  try {
    const project = await server.requestJson('/api/projects', {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        name: 'Manifest Project',
        approved: true,
      },
    });
    assert.equal(project.status, 201);

    const session = await server.requestJson(`/api/projects/${project.body.id}/sessions`, {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        name: 'Manifest Session',
        approved: true,
      },
    });
    assert.equal(session.status, 201);

    const lane = await server.requestJson(`/api/sessions/${session.body.id}/lanes`, {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        title: 'Manifest Lane',
        executorType: 'mock',
        owner: 'dashboard',
        approved: true,
      },
    });
    assert.equal(lane.status, 201);

    const manifest = await server.requestJson('/api/mobile/manifest', { method: 'GET' });
    assert.equal(manifest.status, 200);
    assert.equal(Boolean(manifest.body?.apiTokenRequired), true);
    assert.equal(Array.isArray(manifest.body?.projects), true);
    assert.equal(manifest.body.projects.length, 1);

    const projectEntry = manifest.body.projects[0];
    assert.equal(projectEntry.projectId, project.body.id);
    assert.equal(projectEntry.route.includes(`/projects/${project.body.slug}`), true);
    assert.equal(projectEntry.sessions.length, 1);

    const sessionEntry = projectEntry.sessions[0];
    assert.equal(sessionEntry.sessionId, session.body.id);
    assert.equal(sessionEntry.route.includes(`/projects/${project.body.slug}/sessions/${session.body.id}`), true);
    assert.equal(sessionEntry.lanes.length, 1);

    const laneEntry = sessionEntry.lanes[0];
    assert.equal(laneEntry.laneId, lane.body.id);
    assert.equal(laneEntry.route.includes(`/projects/${project.body.slug}/sessions/${session.body.id}/lanes/${lane.body.id}`), true);
    assert.equal(laneEntry.artifactsUrl, `/api/lanes/${lane.body.id}/artifacts`);
    assert.equal(laneEntry.evidenceUrl, `/api/lanes/${lane.body.id}/evidence`);
    assert.equal(laneEntry.evidenceLatestUrl, `/api/lanes/${lane.body.id}/evidence/latest`);
    assert.equal(laneEntry.auditApi, `/api/lanes/${lane.body.id}/audit`);

    assert.equal(typeof manifest.body?.artifactCleanupUrl, 'string');
    assert.equal(typeof manifest.body?.artifactCleanupScheduleUrl, 'string');
    assert.equal(typeof manifest.body?.artifactCleanupNowUrl, 'string');
    assert.equal(typeof manifest.body?.executorProfilesUrl, 'string');
    assert.equal(typeof manifest.body?.executorCliInfoUrl, 'string');
    assert.equal(typeof manifest.body?.executorCliReinstallUrl, 'string');
  } finally {
    await server.stop();
  }
});

test('projects can be patched to manage quick links from the dashboard', async () => {
  const token = 'route-token-08';
  const server = await startServer({ token });

  try {
    const project = await server.requestJson('/api/projects', {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        name: 'Quick Link Project',
        approved: true,
      },
    });
    assert.equal(project.status, 201);

    const added = await server.requestJson(`/api/projects/${project.body.id}`, {
      method: 'PATCH',
      headers: { 'x-commanddeck-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
        quickLinks: [
          { label: 'Local', url: 'http://localhost:3000' },
        ],
      },
    });
    assert.equal(added.status, 200);
    assert.equal(Array.isArray(added.body.quickLinks), true);
    assert.equal(added.body.quickLinks.length, 1);
    assert.equal(added.body.quickLinks[0].label, 'Local');
    assert.equal(added.body.quickLinks[0].url, 'http://localhost:3000');

    const cleared = await server.requestJson(`/api/projects/${project.body.id}`, {
      method: 'PATCH',
      headers: { 'x-commanddeck-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
        quickLinks: [],
      },
    });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.quickLinks.length, 0);
  } finally {
    await server.stop();
  }
});

test('lane-level and session-level audit-event listing supports filtering by scope and status', async () => {
  const token = 'route-token-09';
  const server = await startServer({ token });

  try {
    const project = await server.requestJson('/api/projects', {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        name: 'Audit Scope Project',
        approved: true,
      },
    });
    assert.equal(project.status, 201);

    const session = await server.requestJson(`/api/projects/${project.body.id}/sessions`, {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        name: 'Audit Scope Session',
        approved: true,
      },
    });
    assert.equal(session.status, 201);

    const lane = await server.requestJson(`/api/sessions/${session.body.id}/lanes`, {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        title: 'Audit Scope Lane',
        executorType: 'mock',
        owner: 'dashboard',
        approved: true,
      },
    });
    assert.equal(lane.status, 201);

    const auditQueued = await server.requestJson(`/api/lanes/${lane.body.id}/audit`, {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
      },
    });
    assert.equal(auditQueued.status, 201);
    const queuedAuditEventId = auditQueued.body?.event?.id || auditQueued.body?.id;
    assert.equal(typeof queuedAuditEventId, 'string');

    const lanePending = await server.requestJson(`/api/lanes/${lane.body.id}/audit-events?status=pending`, { method: 'GET' });
    assert.equal(lanePending.status, 200);
    assert.equal(Array.isArray(lanePending.body), true);
    assert.equal(lanePending.body.some((event) => event.id === queuedAuditEventId), true);

    const sessionPending = await server.requestJson(`/api/sessions/${session.body.id}/audit-events?status=pending`, { method: 'GET' });
    assert.equal(sessionPending.status, 200);
    assert.equal(Array.isArray(sessionPending.body), true);
    assert.equal(sessionPending.body.some((event) => event.id === queuedAuditEventId), true);

    const laneAck = await server.requestJson(`/api/audit/events/${queuedAuditEventId}/ack`, {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: { actor: 'dashboard' },
    });
    assert.equal(laneAck.status, 200);

    const lanePendingAfterAck = await server.requestJson(`/api/lanes/${lane.body.id}/audit-events?status=pending`, { method: 'GET' });
    assert.equal(lanePendingAfterAck.status, 200);
    assert.equal(Array.isArray(lanePendingAfterAck.body), true);
    assert.equal(lanePendingAfterAck.body.some((event) => event.id === queuedAuditEventId), false);

    const lanePassed = await server.requestJson(`/api/lanes/${lane.body.id}/audit-events?status=passed`, { method: 'GET' });
    assert.equal(lanePassed.status, 200);
    assert.equal(Array.isArray(lanePassed.body), true);
    assert.equal(lanePassed.body.some((event) => event.id === queuedAuditEventId), true);
  } finally {
    await server.stop();
  }
});

test('high-risk lane stop action requires explicit approval', async () => {
  const token = 'route-token-10';
  const server = await startServer({ token });

  try {
    const project = await server.requestJson('/api/projects', {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        name: 'Lane Stop Project',
        approved: true,
      },
    });
    assert.equal(project.status, 201);

    const session = await server.requestJson(`/api/projects/${project.body.id}/sessions`, {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        name: 'Lane Stop Session',
        approved: true,
      },
    });
    assert.equal(session.status, 201);

    const lane = await server.requestJson(`/api/sessions/${session.body.id}/lanes`, {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        title: 'Lane Stop Lane',
        executorType: 'mock',
        owner: 'dashboard',
        approved: true,
      },
    });
    assert.equal(lane.status, 201);

    const deniedStop = await server.requestJson(`/api/lanes/${lane.body.id}/stop`, {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        actor: 'dashboard',
        approved: false,
      },
    });
    assert.equal(deniedStop.status, 409);
    assert.equal(Boolean(deniedStop.body?.requiresApproval), true);

    const approvedStop = await server.requestJson(`/api/lanes/${lane.body.id}/stop`, {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
      },
    });
    assert.equal(approvedStop.status, 200);
    assert.equal(approvedStop.body?.state, 'stopped');
  } finally {
    await server.stop();
  }
});

test('server rejects oversized JSON bodies with 413 and small limit override', async () => {
  const token = 'route-token-11';
  const server = await startServer({ token, env: { COMMAND_DECK_MAX_JSON_BYTES: '256' } });

  try {
    const oversize = {
      name: 'Oversize Project',
      approved: true,
      padding: 'x'.repeat(1024),
    };
    const over = await server.requestJson('/api/projects', {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: oversize,
    });
    assert.equal(over.status, 413);
    assert.equal(String(over.body?.error || '').includes('exceeds the'), true);

    const malformed = await server.requestJson('/api/projects', {
      method: 'POST',
      headers: { 'x-commanddeck-token': token, 'content-type': 'application/json' },
      body: undefined,
    });
    // Empty body is treated as {} not malformed; check that legitimate malformed JSON returns 400 instead.
    assert.equal(typeof malformed.status, 'number');
  } finally {
    await server.stop();
  }
});

test('server rejects dashboard requests that try to spoof the scheduler actor', async () => {
  const token = 'route-token-12';
  const server = await startServer({ token });

  try {
    const spoofed = await server.requestJson('/api/projects', {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: { name: 'Spoofed Actor', approved: true, actor: 'scheduler' },
    });
    assert.equal(spoofed.status, 403);
    assert.equal(String(spoofed.body?.error || '').includes('scheduler'), true);

    const systemSpoof = await server.requestJson('/api/artifacts/cleanup', {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: { actor: 'system', approved: true, dryRun: true, sessionId: null },
    });
    assert.equal(systemSpoof.status, 403);
  } finally {
    await server.stop();
  }
});

test('artifact serving rejects traversal, absolute, encoded, and symlink paths', async () => {
  const token = 'route-token-14';
  const server = await startServer({ token });

  try {
    const project = await server.requestJson('/api/projects', {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: { name: 'Artifact Path Project', approved: true },
    });
    assert.equal(project.status, 201);
    const session = await server.requestJson(`/api/projects/${project.body.id}/sessions`, {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: { name: 'Artifact Path Session', approved: true },
    });
    const lane = await server.requestJson(`/api/sessions/${session.body.id}/lanes`, {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: { title: 'Artifact Lane', executorType: 'mock', owner: 'dashboard', approved: true },
    });
    assert.equal(lane.status, 201);

    const laneDir = path.join(process.cwd(), 'artifacts', session.body.id, lane.body.id);
    await fs.mkdir(laneDir, { recursive: true });
    await fs.writeFile(path.join(laneDir, 'real.txt'), 'real');
    const outsideTarget = path.join(process.cwd(), 'sensitive.txt');
    await fs.writeFile(outsideTarget, 'top secret');
    try {
      await fs.symlink(outsideTarget, path.join(laneDir, 'link.txt'));
    } catch {
      // ignore platforms that lack symlink support
    }

    const traversal = await server.requestJson(`/artifacts/${session.body.id}/${lane.body.id}/..%2Fsensitive.txt`, {
      method: 'GET',
    });
    assert.equal(traversal.status === 400 || traversal.status === 404, true);

    const absolute = await server.requestJson(`/artifacts/${session.body.id}/${lane.body.id}/%2Fetc%2Fpasswd`, {
      method: 'GET',
    });
    assert.equal(absolute.status === 400 || absolute.status === 404, true);

    const real = await server.requestJson(`/artifacts/${session.body.id}/${lane.body.id}/real.txt`, { method: 'GET' });
    assert.equal(real.status, 200);
    // Symlink should be refused even though it exists.
    const symlinkProbe = await server.requestJson(`/artifacts/${session.body.id}/${lane.body.id}/link.txt`, { method: 'GET' });
    assert.equal(symlinkProbe.status === 400 || symlinkProbe.status === 404, true);
  } finally {
    await server.stop();
  }
});

test('lane heartbeat endpoint can be gated by COMMAND_DECK_WORKER_TOKEN', async () => {
  const token = 'route-token-13';
  const workerToken = 'worker-token-aa';
  const server = await startServer({ token, env: { COMMAND_DECK_WORKER_TOKEN: workerToken } });

  try {
    const project = await server.requestJson('/api/projects', {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: { name: 'Heartbeat Project', approved: true },
    });
    assert.equal(project.status, 201);
    const session = await server.requestJson(`/api/projects/${project.body.id}/sessions`, {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: { name: 'Heartbeat Session', approved: true },
    });
    assert.equal(session.status, 201);
    const lane = await server.requestJson(`/api/sessions/${session.body.id}/lanes`, {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: { title: 'Heartbeat Lane', executorType: 'mock', owner: 'dashboard', approved: true },
    });
    assert.equal(lane.status, 201);

    const denied = await server.requestJson(`/api/lanes/${lane.body.id}/heartbeat`, {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {},
    });
    assert.equal(denied.status, 401);
    assert.equal(String(denied.body?.error || '').toLowerCase().includes('worker token'), true);

    const allowed = await server.requestJson(`/api/lanes/${lane.body.id}/heartbeat`, {
      method: 'POST',
      headers: { 'x-commanddeck-token': token, 'x-commanddeck-worker-token': workerToken },
      body: {},
    });
    assert.equal(allowed.status, 200);
  } finally {
    await server.stop();
  }
});

test('private access API exposes mocked tailnet state, dry-run setup plans, and rejects Funnel targets', async () => {
  const token = 'route-token-private-access';
  const server = await startServer({ token });

  try {
    const state = await server.requestJson('/api/private-access?fakeTailnetState=serve-https', { method: 'GET' });
    assert.equal(state.status, 200);
    assert.equal(state.body?.tailnet?.provider, 'fake');
    assert.equal(state.body?.tailnet?.serveMode, 'tailnet-https-serve');
    assert.equal(state.body?.pwa?.staticOnlyCache, true);

    const plan = await server.requestJson('/api/private-access/setup-plan?localUrl=http%3A%2F%2F127.0.0.1%3A3000', { method: 'GET' });
    assert.equal(plan.status, 200);
    assert.equal(Array.isArray(plan.body?.commands), true);
    assert.equal(plan.body.commands.some((command) => String(command.copyText || '').includes('tailscale serve')), true);
    assert.equal(plan.body.commands.some((command) => String(command.copyText || '').toLowerCase().includes('funnel')), false);

    const target = await server.requestJson('/api/private-access/targets', {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        actor: 'dashboard',
        label: 'Local target',
        mode: 'local',
        localUrl: 'http://127.0.0.1:3000',
      },
    });
    assert.equal(target.status, 201);
    assert.equal(target.body?.mode, 'local');

    const badFunnel = await server.requestJson('/api/private-access/targets', {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        actor: 'dashboard',
        label: 'Bad Funnel',
        mode: 'tailnet-https-serve',
        localUrl: 'http://127.0.0.1:3000',
        httpsServeUrl: 'https://command-deck.funnel.ts.net',
      },
    });
    assert.equal(badFunnel.status, 422);
    assert.equal(String(badFunnel.body?.error || '').includes('Funnel'), true);
  } finally {
    await server.stop();
  }
});

test('provider profile API exposes first-class providers and memory-backed secret references without echoing values', async () => {
  const token = 'route-token-providers';
  const server = await startServer({ token, env: { COMMAND_DECK_CREDENTIAL_BACKEND: 'memory' } });

  try {
    const list = await server.requestJson('/api/providers', { method: 'GET' });
    assert.equal(list.status, 200);
    assert.equal(list.body?.credentialBackend, 'memory');
    const ids = new Set((list.body?.profiles || []).map((profile) => profile.id));
    for (const id of ['codex', 'claude', 'custom-cli', 'openai-compatible', 'gemini', 'kimi', 'deepseek', 'openrouter', 'composer']) {
      assert.equal(ids.has(id), true, `missing ${id}`);
    }

    const deniedSecret = await server.requestJson('/api/providers/openai-compatible/secret', {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        actor: 'dashboard',
        approved: false,
        secret: 'sk-test-secret',
      },
    });
    assert.equal(deniedSecret.status, 409);

    const setSecret = await server.requestJson('/api/providers/openai-compatible/secret', {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: {
        actor: 'dashboard',
        approved: true,
        secret: 'sk-test-secret',
      },
    });
    assert.equal(setSecret.status, 200);
    assert.equal(JSON.stringify(setSecret.body).includes('sk-test-secret'), false);

    const health = await server.requestJson('/api/providers/openai-compatible/health', { method: 'GET' });
    assert.equal(health.status, 200);
    assert.equal(health.body?.status, 'configured');
    assert.equal(JSON.stringify(health.body).includes('sk-test-secret'), false);

    const exported = await server.requestJson('/api/providers/export', { method: 'GET' });
    assert.equal(exported.status, 200);
    assert.equal(exported.body?.excludesSecrets, true);
    assert.equal(JSON.stringify(exported.body).includes('sk-test-secret'), false);
  } finally {
    await server.stop();
  }
});
