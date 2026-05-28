import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';

function parseJsonBody(rawText) {
  if (!rawText) return null;
  try {
    return JSON.parse(rawText);
  } catch {
    return { raw: rawText };
  }
}

async function startServer({ token, env = {} }) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'command-deck-server-'));
  const entrypoint = path.join(process.cwd(), 'src', 'server.js');

  const serverEnv = {
    ...process.env,
    ...env,
    PORT: env.PORT || '0',
  };

  if (typeof token === 'string') {
    serverEnv.COMMAND_DECK_API_TOKEN = token;
  }

  const child = spawn(process.execPath, [entrypoint], {
    cwd: tempDir,
    env: serverEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const startupTimeout = setTimeout(() => {
    child.kill('SIGKILL');
  }, 5000);

  const baseUrl = await new Promise((resolve, reject) => {
    const onData = (chunk) => {
      const text = String(chunk || '');
      const match = text.match(/listening at http:\/\/localhost:(\d+)/i);
      if (match?.[1]) {
        clearTimeout(startupTimeout);
        const port = Number.parseInt(match[1], 10);
        child.stdout.off('data', onData);
        child.stderr.off('data', onData);
        resolve(`http://127.0.0.1:${port}`);
      }
    };

    const onExit = (code) => {
      clearTimeout(startupTimeout);
      reject(new Error(`Server exited during startup with code ${code}`));
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', onExit);
  });

  const stop = async () => {
    if (child.exitCode !== null) {
      await fs.rm(tempDir, { recursive: true, force: true });
      return;
    }

    if (!child.killed && child.exitCode === null) {
      child.kill('SIGTERM');
    }
    await new Promise((resolve) => {
      child.once('exit', resolve);
    }).catch(() => {});
    await fs.rm(tempDir, { recursive: true, force: true });
  };

  const requestJson = async (requestPath, options = {}) => {
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    };
    const body = options.body !== undefined ? JSON.stringify(options.body) : options.body;

    const response = await fetch(`${baseUrl}${requestPath}`, {
      ...options,
      body,
      headers,
    });
    const text = await response.text();
    return {
      status: response.status,
      body: parseJsonBody(text),
      response,
    };
  };

  return {
    baseUrl,
    child,
    requestJson,
    stop,
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
    },);
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
      },
    );
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
