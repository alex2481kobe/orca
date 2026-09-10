// Shared test helpers: drive a real Orca MCP bridge process over stdio, and pick
// a free loopback port. Not a test file itself (the runner globs *.test.js).
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BRIDGE = path.join(ROOT, 'src', 'mcp-server.js');

// The environment a child should start from: this process's, minus everything
// that could point it at a real Orca, a real lease, or a real client config.
export function cleanChildEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ORCA_')
    && key !== 'CODEX_HOME'
    && key !== 'CLAUDE_CONFIG_DIR'));
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// One long-lived bridge, like the one an MCP client keeps open for a session.
export function startBridge(env, { requestTimeoutMs = 30000 } = {}) {
  const child = spawn(process.execPath, [BRIDGE], {
    cwd: ROOT,
    env: { ...cleanChildEnv(), ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let nextId = 1;
  let buffer = '';
  let stderr = '';
  const pending = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.on('exit', () => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`bridge exited early. stderr: ${stderr}`));
    }
    pending.clear();
  });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`bridge request timed out: ${method}. stderr: ${stderr}`));
    }, requestTimeoutMs);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const callTool = async (name, args = {}) => {
    const response = await request('tools/call', { name, arguments: args });
    const text = String(response?.result?.content?.[0]?.text ?? response?.error?.message ?? '');
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { isError: Boolean(response?.result?.isError || response?.error), text, json };
  };
  return {
    request,
    callTool,
    stderr: () => stderr,
    close: () => { if (child.exitCode === null) child.kill(); },
  };
}
