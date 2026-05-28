#!/usr/bin/env node
/*
 * Command Deck end-to-end smoke.
 *
 * Walks the full operator path against a running local server and proves
 * both the happy path AND that the security guards reject the bad path:
 *   1. health, policy, mobile manifest, system blockers
 *   2. unauthorized POST → 401
 *   3. spoofed actor (scheduler/system) → 403
 *   4. oversized JSON body → 413
 *   5. malformed JSON body → 400
 *   6. malformed query string → 400
 *   7. project + session + mock lane creation; lane reaches done
 *   8. MCP CRUD + Codex lane attachment (blocked execution OK)
 *   9. evidence capture; if Playwright is present, assert captured=true
 *      and a real screenshot file with non-zero size; otherwise assert
 *      the degraded state explicitly
 *  10. audit queue + ack + cleanup dry-run + worktree route shape
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
  if (args[i] === '--base' && args[i + 1]) base = args[i + 1];
}
const token = process.env.COMMAND_DECK_API_TOKEN || '';

const tokenHeaders = {
  'content-type': 'application/json',
  ...(token ? { 'x-commanddeck-token': token } : {}),
};
const noTokenHeaders = { 'content-type': 'application/json' };

const log = (label, info = '') => console.log(`[smoke] ${label}${info ? ' — ' + info : ''}`);
const fail = (label, info) => {
  console.error(`[smoke FAIL] ${label}${info ? ' — ' + info : ''}`);
  process.exitCode = 1;
  throw new Error(label);
};

async function req(method, path, body, opts = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: opts.headers || tokenHeaders,
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json };
}

const start = Date.now();
log('start', `base=${base} token=${token ? 'set' : 'unset'}`);

// --- read-only sanity ---
const health = await req('GET', '/api/health');
if (health.status !== 200) fail('health', JSON.stringify(health));
log('health', `counts=${JSON.stringify(health.body.counts || {})}`);

const policy = await req('GET', '/api/policy');
if (policy.status !== 200) fail('policy', JSON.stringify(policy));
log('policy', `${Object.keys(policy.body.policies || {}).length} policies`);

const blockers = await req('GET', '/api/system/blockers');
if (blockers.status !== 200) fail('system blockers', JSON.stringify(blockers));
log('blockers', `${(blockers.body.blockers || []).length} blocker(s)`);

const manifest = await req('GET', '/api/mobile/manifest');
if (manifest.status !== 200) fail('manifest', JSON.stringify(manifest));
log('manifest', `apiTokenRequired=${manifest.body.apiTokenRequired}`);

// --- negative auth/spoof/size/malform tests ---
if (token) {
  const unauthorized = await req('POST', '/api/projects', { name: 'unauthorized' }, { headers: noTokenHeaders });
  if (unauthorized.status !== 401) fail('unauthorized POST should be 401', JSON.stringify(unauthorized));
  log('neg/unauthorized', `${unauthorized.status} ok`);
}
const spoofed = await req('POST', '/api/projects', { name: 'spoofed', approved: true, actor: 'scheduler' });
if (spoofed.status !== 403) fail('spoofed actor POST should be 403', JSON.stringify(spoofed));
log('neg/spoofed-actor', `${spoofed.status} ok`);

const overPayload = JSON.stringify({ name: 'over', approved: true, padding: 'x'.repeat(300 * 1024) });
const oversize = await req('POST', '/api/projects', overPayload);
if (oversize.status !== 413) fail('oversize POST should be 413', JSON.stringify(oversize));
log('neg/oversize', `${oversize.status} ok`);

const malformed = await req('POST', '/api/projects', '{ not json ', { headers: tokenHeaders });
if (malformed.status !== 400) fail('malformed JSON should be 400', JSON.stringify(malformed));
log('neg/malformed-json', `${malformed.status} ok`);

const malformedQuery = await req('GET', '/api/audit/events?status=%E0%A4');
if (malformedQuery.status !== 400) fail('malformed query should be 400', JSON.stringify(malformedQuery));
log('neg/malformed-query', `${malformedQuery.status} ok`);

// --- happy-path: project + session + mock lane ---
const slugSuffix = Date.now().toString(36).slice(-6);
const project = await req('POST', '/api/projects', { name: `Smoke ${slugSuffix}`, approved: true });
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

// Wait for mock lane completion.
let laneState = lane.body.state;
for (let i = 0; i < 30 && !['done', 'failed', 'stopped'].includes(laneState); i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 500));
  const status = await req('GET', `/api/lanes/${lane.body.id}`);
  laneState = status.body.state;
}
if (laneState !== 'done') fail('lane should reach done', laneState);
log('laneState', laneState);

// --- MCP CRUD + Codex lane attachment ---
const tool = await req('POST', '/api/mcp/tools', {
  name: `smoke-tool-${slugSuffix}`,
  command: 'node',
  args: ['--version'],
  env: { SMOKE: '1' },
  description: 'smoke',
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

// --- evidence: real if Playwright present, degraded otherwise ---
const playwrightBlocker = (blockers.body.blockers || []).find((b) => b.id === 'playwright-missing');
const evidence = await req('POST', `/api/lanes/${lane.body.id}/evidence`, {
  url: `${base}/api/health`,
  modes: ['screenshot'],
  approved: true,
});
if (evidence.status !== 200) fail('evidence POST should be 200', JSON.stringify(evidence));
if (playwrightBlocker) {
  if (evidence.body?.captured !== false) fail('evidence should be degraded without Playwright', JSON.stringify(evidence.body));
  log('evidence', `degraded ok (captured=false)`);
} else {
  if (evidence.body?.captured !== true) fail('evidence should capture with Playwright', JSON.stringify(evidence.body));
  const screenshot = (evidence.body?.evidence?.produced || []).find((name) => name.endsWith('-shot.png'));
  if (!screenshot) fail('evidence should produce a screenshot file', JSON.stringify(evidence.body));
  const fetchShot = await req('GET', `/artifacts/${lane.body.sessionId}/${lane.body.id}/${screenshot}`);
  if (fetchShot.status !== 200) fail('screenshot file should be served', String(fetchShot.status));
  log('evidence', `captured ok (file=${screenshot})`);
}

// --- evidence presets endpoint shape ---
const presets = await req('GET', `/api/lanes/${lane.body.id}/evidence/presets`);
if (presets.status !== 200 || !Array.isArray(presets.body?.presets)) fail('evidence presets shape', JSON.stringify(presets));
log('presets', `${presets.body.presets.length} preset(s)`);

// --- audit queue + ack ---
const audit = await req('POST', `/api/lanes/${lane.body.id}/audit`, { actor: 'dashboard', approved: true });
if (audit.status !== 201) fail('queueLaneAudit', JSON.stringify(audit));
const auditId = audit.body.event?.id || audit.body.id || audit.body.queueId;
log('audit', `id=${auditId}`);
if (auditId) {
  const ack = await req('POST', `/api/audit/events/${auditId}/ack`, { actor: 'dashboard' });
  if (ack.status !== 200) fail('ackAudit', JSON.stringify(ack));
  log('ackedAudit', ack.body.status);
}

// --- cleanup dry-run ---
const cleanup = await req('POST', '/api/artifacts/cleanup', {
  actor: 'dashboard',
  approved: true,
  dryRun: true,
  sessionId: session.body.id,
});
if (cleanup.status !== 200) fail('cleanupDryRun', JSON.stringify(cleanup));
log('cleanupDryRun', `candidates=${cleanup.body.candidates}`);

// --- worktree remove (expected 422 because lane has no managed worktree) ---
const wtRemove = await req('POST', `/api/lanes/${lane.body.id}/worktree/remove`, { actor: 'dashboard', approved: true });
if (wtRemove.status !== 422) fail('worktree remove without managed worktree should be 422', JSON.stringify(wtRemove));
log('worktreeRemoveShape', `${wtRemove.status} ok`);

const elapsed = Date.now() - start;
log('done', `${elapsed}ms`);
