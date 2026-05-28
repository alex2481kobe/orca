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
    await fs.rm(tempDir, { recursive: true, force: true });
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
  const { routeRequest } = await import(moduleUrl);

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
    stop: restore,
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
      body: { name: 'Authorized project' },
      headers: { 'x-commanddeck-token': token },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.name, 'Authorized project');
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
      body: { name: 'Query project' },
    });
    assert.equal(project.status, 201);

    const session = await server.requestJson(`/api/projects/${project.body.id}/sessions`, {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: { name: 'Query session' },
    });
    assert.equal(session.status, 201);

    const lane = await server.requestJson(`/api/sessions/${session.body.id}/lanes`, {
      method: 'POST',
      headers: { 'x-commanddeck-token': token },
      body: { title: 'Query lane', executorType: 'mock', command: 'echo query route', owner: 'test' },
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
