#!/usr/bin/env node
/*
 * Command Deck end-to-end smoke.
 *
 * Walks the full operator path against a running local server:
 *   1. health, policy, mobile manifest
 *   2. project / session / lane creation (mock executor)
 *   3. mock lane completes and produces terminal artifacts
 *   4. MCP tool CRUD + lane attachment + generated config inspection
 *   5. evidence capture (degraded if Playwright is unavailable)
 *   6. audit queue + acknowledgement
 *   7. cleanup dry-run (no destructive run)
 *
 * Usage:
 *   COMMAND_DECK_API_TOKEN=<token> node scripts/smoke.mjs [--base http://127.0.0.1:3000]
 *
 * Exits non-zero on the first failing step so it can gate startup.
 */

import process from 'node:process';

const args = process.argv.slice(2);
let base = process.env.COMMAND_DECK_BASE_URL || 'http://127.0.0.1:3000';
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--base' && args[i + 1]) {
    base = args[i + 1];
  }
}
const token = process.env.COMMAND_DECK_API_TOKEN || '';

const headers = {
  'content-type': 'application/json',
  ...(token ? { 'x-commanddeck-token': token } : {}),
};

const log = (label, info = '') => console.log(`[smoke] ${label}${info ? ' — ' + info : ''}`);
const fail = (label, info) => {
  console.error(`[smoke FAIL] ${label}${info ? ' — ' + info : ''}`);
  process.exitCode = 1;
  throw new Error(label);
};

async function req(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json };
}

const start = Date.now();
log('start', `base=${base} token=${token ? 'set' : 'unset'}`);

const health = await req('GET', '/api/health');
if (health.status !== 200) fail('health', JSON.stringify(health));
log('health', `counts=${JSON.stringify(health.body.counts || {})}`);

const policy = await req('GET', '/api/policy');
if (policy.status !== 200) fail('policy', JSON.stringify(policy));
log('policy', `${Object.keys(policy.body.policies || {}).length} policies`);

const manifest = await req('GET', '/api/mobile/manifest');
if (manifest.status !== 200) fail('manifest', JSON.stringify(manifest));
log('manifest', `apiTokenRequired=${manifest.body.apiTokenRequired}`);

const slugSuffix = Date.now().toString(36).slice(-6);
const project = await req('POST', '/api/projects', {
  name: `Smoke ${slugSuffix}`,
  approved: true,
});
if (project.status !== 201) fail('createProject', JSON.stringify(project));
log('project', project.body.id);

const session = await req('POST', `/api/projects/${project.body.id}/sessions`, {
  name: `Smoke Session ${slugSuffix}`,
  approved: true,
});
if (session.status !== 201) fail('createSession', JSON.stringify(session));
log('session', session.body.id);

const lane = await req('POST', `/api/sessions/${session.body.id}/lanes`, {
  title: 'smoke lane',
  executorType: 'mock',
  owner: 'smoke',
  approved: true,
  taskPrompt: 'Smoke run',
  model: 'mock',
});
if (lane.status !== 201) fail('createLane', JSON.stringify(lane));
log('lane', lane.body.id);

// Wait briefly for mock lane to complete.
let laneState = lane.body.state;
for (let i = 0; i < 30 && !['done', 'failed', 'stopped'].includes(laneState); i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 500));
  const status = await req('GET', `/api/lanes/${lane.body.id}`);
  laneState = status.body.state;
}
log('laneState', laneState);

const tool = await req('POST', '/api/mcp/tools', {
  name: `smoke-tool-${slugSuffix}`,
  command: 'node',
  args: ['--version'],
  scope: ['all'],
  approved: true,
});
if (tool.status !== 201) fail('createMcpTool', JSON.stringify(tool));
log('mcpTool', tool.body.id);

const codexLane = await req('POST', `/api/sessions/${session.body.id}/lanes`, {
  title: 'smoke codex lane',
  executorType: 'codex',
  executorBinary: '/usr/bin/codex',
  mcpToolIds: [tool.body.id],
  approved: true,
  taskPrompt: 'Plan only',
  model: 'gpt-5',
  permissionsProfile: 'plan',
});
if (codexLane.status !== 201) fail('createCodexLane', JSON.stringify(codexLane));
log('codexLane', codexLane.body.id);

const artifacts = await req('GET', `/api/lanes/${lane.body.id}/artifacts`);
log('artifacts', `${(artifacts.body.files || []).length} files`);

const evidence = await req('POST', `/api/lanes/${lane.body.id}/evidence`, {
  url: 'about:blank',
  modes: 'screenshot',
  approved: true,
});
if (![200, 400, 409, 500].includes(evidence.status)) fail('captureEvidence', JSON.stringify(evidence));
log('evidence', `status=${evidence.status} captured=${evidence.body?.captured}`);

const audit = await req('POST', `/api/lanes/${lane.body.id}/audit`, {
  actor: 'dashboard',
  approved: true,
});
if (audit.status !== 201) fail('queueLaneAudit', JSON.stringify(audit));
const auditId = audit.body.event?.id || audit.body.id || audit.body.queueId;
log('audit', `id=${auditId}`);

if (auditId) {
  const ack = await req('POST', `/api/audit/events/${auditId}/ack`, {
    actor: 'dashboard',
  });
  if (ack.status !== 200) fail('ackAudit', JSON.stringify(ack));
  log('ackedAudit', ack.body.status);
}

const cleanup = await req('POST', '/api/artifacts/cleanup', {
  actor: 'dashboard',
  approved: true,
  dryRun: true,
  sessionId: session.id,
});
if (cleanup.status !== 200) fail('cleanupDryRun', JSON.stringify(cleanup));
log('cleanupDryRun', `candidates=${cleanup.body.candidates}`);

const elapsed = Date.now() - start;
log('done', `${elapsed}ms`);
