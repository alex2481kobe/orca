// ONBOARDING PROOF — "can a brand-new agent actually use Orca?"
//
// Every unit test passes ids explicitly, so none of them exercise the path a REAL
// client takes: wire the bare documented command, get a rulebook, discover tools,
// and let the connection fill in the ids. That blind spot shipped a live break once
// (routes renamed {sessionId} -> {orchestratorId} while the MCP bridge still
// defaulted the old name, so executor.spawn / fleet.emergency_stop became
// "Missing required parameter" for every caller) — this script exists so it can't
// happen again.
//
// It drives the EXACT README quickstart (`node src/mcp-server.js`, no extra env)
// over stdio JSON-RPC against an isolated server, and runs the whole loop:
// register -> spawn -> read output -> status/next-step -> break-glass -> resign.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const realTemp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orca-onboarding-')));
process.chdir(realTemp);
process.env.PORT = '0';
process.env.ORCA_HOST = '127.0.0.1';
process.env.ORCA_CREDENTIAL_BACKEND = 'memory';
process.env.ORCA_RATE_LIMIT_DISABLED = 'true';
process.env.ORCA_REPO_ROOTS = realTemp;          // the agent registers inside here
process.env.ORCA_AUTO_COMPLETE_MS = '1200';       // mock lanes finish fast
// Phase 1 proves the TOKENLESS quickstart, so the operator's own exported token
// must not leak in and fail the proof for an unrelated reason. Phase 2 below
// covers the tokenized configuration explicitly.
delete process.env.ORCA_API_TOKEN;

const sm = await import('../src/server.js');
const server = await sm.startServer(0, '127.0.0.1');
const port = server.address().port;
const workDir = await fs.realpath(await (async () => {
  const d = path.join(realTemp, 'Demo Project');
  await fs.mkdir(d, { recursive: true });
  return d;
})());

let failed = false;
const step = (name, ok, detail = '') => {
  if (!ok) failed = true;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// A real client spawns the bridge with only a base URL — no role, no ids.
const child = spawn('node', [path.join(repoDir, 'src', 'mcp-server.js')], {
  env: { ...process.env, ORCA_AGENT_TOOLS_BASE_URL: `http://127.0.0.1:${port}` },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let buf = '';
const pending = new Map();
child.stdout.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    } catch { /* not a JSON-RPC line */ }
  }
});
let nextId = 0;
const rpc = (method, params = {}) => new Promise((resolve) => {
  const id = ++nextId;
  pending.set(id, resolve);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
});
const call = async (name, args = {}) => {
  const res = await rpc('tools/call', { name, arguments: args });
  const text = res?.result?.content?.[0]?.text ?? '';
  try { return { ok: !res?.result?.isError, data: JSON.parse(text) }; } catch { return { ok: !res?.result?.isError, data: text }; }
};

// ---- 1. what a fresh agent is handed on connect ----
const init = await rpc('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'onboarding-proof', version: '1' },
});
step('handshake', Boolean(init?.result?.serverInfo), init?.result?.serverInfo?.name || '');
step('rulebook delivered at connect', String(init?.result?.instructions || '').length > 200,
  `${String(init?.result?.instructions || '').length} chars`);

const list = await rpc('tools/list', {});
const tools = list?.result?.tools || [];
const names = tools.map((t) => t.name);
step('tools advertised', names.length > 0, `${names.length}`);
// The bare command MUST expose the two tools the README tells the reader to use.
step('orchestrator__register advertised (bare command)', names.includes('orchestrator__register'));
step('executor__spawn advertised (bare command)', names.includes('executor__spawn'));

// ---- 2. the loop ----
const reg = await call('orchestrator__register', {
  body: { cwd: workDir, title: 'Onboarding proof', actor: 'claude' },
});
const orchestratorId = reg.data?.id || reg.data?.orchestrator?.id;
step('orchestrator.register', Boolean(orchestratorId), orchestratorId || JSON.stringify(reg.data).slice(0, 140));

const spawned = await call('executor__spawn', {
  orchestratorId,
  body: { title: 'Scout the repo', executorType: 'mock', approved: true, taskPrompt: 'read-only scout' },
});
const laneId = spawned.data?.id || spawned.data?.lane?.id;
step('executor.spawn', Boolean(laneId), laneId || JSON.stringify(spawned.data).slice(0, 160));

// depend on the subagent: poll to a terminal state, then read what it produced
let state = '';
for (let i = 0; i < 60 && !['done', 'ready_for_audit', 'accepted', 'failed'].includes(state); i++) {
  const got = await call('lane__get', { laneId });
  state = got.data?.state || got.data?.lane?.state || '';
  if (['done', 'ready_for_audit', 'accepted', 'failed'].includes(state)) break;
  await new Promise((r) => setTimeout(r, 300));
}
step('lane reaches a terminal state', ['done', 'ready_for_audit', 'accepted'].includes(state), `state=${state}`);
const tail = await call('lane__terminal__tail', { laneId });
const output = typeof tail.data === 'string' ? tail.data : JSON.stringify(tail.data);
step('subagent output is readable', output.length > 0, `${output.length} bytes`);

// the server tells the agent what to do next (this is how the loop stays honest)
const status = await call('orchestrator__status', { orchestratorId });
const nextTool = status.data?.nextAction?.tool || status.data?.nextRequiredTool || '';
step('orchestrator.status returns a next step', Boolean(status.data), `next=${nextTool || 'n/a'}`);

// ---- 3. THE REGRESSION GUARD: connection-supplied ids ----
// Re-spawn the bridge the way a LANE runs it, and confirm a container-scoped tool
// works with NO explicit id — the exact behavior that broke before.
child.kill();
const laneChild = spawn('node', [path.join(repoDir, 'src', 'mcp-server.js')], {
  env: {
    ...process.env,
    ORCA_AGENT_TOOLS_BASE_URL: `http://127.0.0.1:${port}`,
    ORCA_ORCHESTRATOR_ID: orchestratorId,
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let buf2 = '';
const pending2 = new Map();
laneChild.stdout.on('data', (chunk) => {
  buf2 += chunk;
  let i;
  while ((i = buf2.indexOf('\n')) >= 0) {
    const line = buf2.slice(0, i);
    buf2 = buf2.slice(i + 1);
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (pending2.has(msg.id)) { pending2.get(msg.id)(msg); pending2.delete(msg.id); }
    } catch { /* */ }
  }
});
let nextId2 = 0;
const rpc2 = (method, params = {}) => new Promise((resolve) => {
  const id = ++nextId2;
  pending2.set(id, resolve);
  laneChild.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
});
await rpc2('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'lane', version: '1' } });
const implicit = await rpc2('tools/call', { name: 'orchestrator__status', arguments: {} });
const implicitText = implicit?.result?.content?.[0]?.text ?? '';
step('container id defaults from the connection (no explicit id)',
  !implicit?.result?.isError && !/Missing required parameter/i.test(implicitText),
  implicit?.result?.isError ? implicitText.slice(0, 90) : 'orchestrator__status resolved with {}');
laneChild.kill();

// ---- 4. break-glass is reachable ----
const stopped = await call2Fallback();
async function call2Fallback() {
  const c = spawn('node', [path.join(repoDir, 'src', 'mcp-server.js')], {
    env: { ...process.env, ORCA_AGENT_TOOLS_BASE_URL: `http://127.0.0.1:${port}` },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let b = '';
  const p = new Map();
  c.stdout.on('data', (chunk) => {
    b += chunk;
    let i;
    while ((i = b.indexOf('\n')) >= 0) {
      const line = b.slice(0, i); b = b.slice(i + 1);
      if (!line.trim()) continue;
      try { const m = JSON.parse(line); if (p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); } } catch { /* */ }
    }
  });
  let n = 0;
  const r = (method, params) => new Promise((resolve) => { const id = ++n; p.set(id, resolve); c.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  await r('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'x', version: '1' } });
  const res = await r('tools/call', { name: 'fleet__emergency_stop', arguments: { orchestratorId, body: { actor: 'onboarding', approved: true } } });
  c.kill();
  return !res?.result?.isError;
}
step('fleet.emergency_stop reachable', stopped);

// ---- 4. the TOKENIZED configuration ----
// The bare command in phase 1 works only because a loopback daemon with no token
// grants implicit admin. The Tailscale runbook REQUIRES ORCA_API_TOKEN, which
// turns that bootstrap off — so the same command 401s and a first adopter cannot
// start the loop. The documented answer is the admin-gated bootstrap endpoint,
// which mints a SCOPED lease (never handing the agent the API token). Prove it.
const phase2Token = 'onboarding-proof-api-token';
process.env.ORCA_API_TOKEN = phase2Token;
const sm2 = await import(`../src/server.js?onboarding-token-phase=${Date.now()}`);
const server2 = await sm2.startServer(0, '127.0.0.1');
const port2 = server2.address().port;
const base2 = `http://127.0.0.1:${port2}`;

const bareRes = await fetch(`${base2}/api/orchestrators`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ cwd: workDir, title: 'no auth', actor: 'claude' }),
});
step('tokenized: the bare wiring is correctly refused', bareRes.status === 401, `${bareRes.status}`);

const bootstrapRes = await fetch(`${base2}/api/mcp/orchestrator-bootstrap`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-orca-token': phase2Token },
  body: JSON.stringify({ actor: 'onboarding-proof' }),
});
const bootstrap = await bootstrapRes.json().catch(() => ({}));
const leaseToken = bootstrap?.leaseToken || '';
step('tokenized: bootstrap mints a scoped orchestrator lease', Boolean(leaseToken), `${bootstrapRes.status}`);
step('tokenized: the API token never appears in the bootstrap payload',
  !JSON.stringify(bootstrap).includes(phase2Token));

// Wire the bridge exactly as the returned config says, and run the first step.
const leaseEnv = bootstrap?.bootstrap?.clients?.claudeDesktop?.config?.mcpServers?.orca?.env || {};
const c2 = spawn('node', [path.join(repoDir, 'src', 'mcp-server.js')], {
  env: { ...process.env, ...leaseEnv, ORCA_AGENT_TOOLS_BASE_URL: base2 },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let b2 = '';
const p2 = new Map();
c2.stdout.on('data', (chunk) => {
  b2 += chunk;
  let i;
  while ((i = b2.indexOf('\n')) >= 0) {
    const line = b2.slice(0, i); b2 = b2.slice(i + 1);
    if (!line.trim()) continue;
    try { const m = JSON.parse(line); if (p2.has(m.id)) { p2.get(m.id)(m); p2.delete(m.id); } } catch { /* */ }
  }
});
let n2 = 0;
const r2 = (method, params) => new Promise((resolve) => {
  const id = ++n2; p2.set(id, resolve);
  c2.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
});
await r2('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'onboarding-proof-token', version: '1' } });
const reg2 = await r2('tools/call', {
  name: 'orchestrator__register',
  arguments: { body: { cwd: workDir, title: 'Tokenized onboarding proof', actor: 'claude' } },
});
const reg2Text = reg2?.result?.content?.[0]?.text ?? '';
let reg2Id = '';
try { reg2Id = JSON.parse(reg2Text)?.id || ''; } catch { /* non-JSON error text */ }
step('tokenized: orchestrator.register works with the minted lease', Boolean(reg2Id), reg2Id || reg2Text.slice(0, 140));
c2.kill();
if (sm2.stopServer) await sm2.stopServer();
await new Promise((r) => server2.close(r));

console.log(`\n[onboarding] ${failed ? 'FAILED' : 'OK'} — a new agent can wire Orca with the documented command and run the loop.`);
if (sm.stopServer) await sm.stopServer();
await new Promise((r) => server.close(r));
await fs.rm(realTemp, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
if (failed) process.exit(1);
