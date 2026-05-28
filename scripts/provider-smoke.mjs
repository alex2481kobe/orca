#!/usr/bin/env node
/*
 * Provider profile smoke. Safe by default: no installs, no updates, no public
 * network probes, and no real OS credential writes unless the running server is
 * explicitly using the test memory credential backend.
 */
import process from 'node:process';

const args = process.argv.slice(2);
let base = process.env.COMMAND_DECK_BASE_URL || 'http://127.0.0.1:3000';
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--base' && args[i + 1]) base = args[i + 1];
}
const token = process.env.COMMAND_DECK_API_TOKEN || '';
const headers = {
  'content-type': 'application/json',
  ...(token ? { 'x-commanddeck-token': token } : {}),
};

const log = (label, info = '') => console.log(`[provider-smoke] ${label}${info ? ' — ' + info : ''}`);
const fail = (label, info = '') => {
  console.error(`[provider-smoke FAIL] ${label}${info ? ' — ' + info : ''}`);
  process.exitCode = 1;
  throw new Error(label);
};

async function req(method, pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data };
}

const list = await req('GET', '/api/providers');
if (list.status !== 200) fail('GET /api/providers', JSON.stringify(list.data));
const ids = new Set((list.data.profiles || []).map((profile) => profile.id));
for (const id of ['codex', 'claude', 'custom-cli', 'openai-compatible', 'gemini', 'kimi', 'deepseek', 'openrouter', 'composer']) {
  if (!ids.has(id)) fail('missing provider profile', id);
}
if (JSON.stringify(list.data).includes('sk-test')) fail('provider list leaked a test-looking secret value');
log('profiles', `${ids.size} loaded; credential backend=${list.data.credentialBackend}`);

const health = await req('GET', '/api/providers/openai-compatible/health');
if (health.status !== 200) fail('API provider health', JSON.stringify(health.data));
if (!['configured', 'missing_secret', 'disabled'].includes(health.data.status)) fail('unexpected API provider health status', health.data.status);
log('api health', health.data.status);

const exported = await req('GET', '/api/providers/export');
if (exported.status !== 200) fail('export', JSON.stringify(exported.data));
if (exported.data.excludesSecrets !== true) fail('export must declare secret exclusion');
if (JSON.stringify(exported.data).includes('secretValue')) fail('export contains secretValue field');
log('export', `${(exported.data.profiles || []).length} profiles`);

const dryRun = await req('POST', '/api/providers/import/dry-run', {
  schemaVersion: 1,
  profiles: [
    {
      id: 'openai-compatible',
      displayName: 'OpenAI-compatible API',
      kind: 'api',
      enabled: false,
      baseUrl: 'https://api.openai.com/v1',
      apiStyle: 'openai-compatible',
      secretRef: 'provider:openai-compatible',
      apiKeyEnv: 'COMMAND_DECK_OPENAI_COMPATIBLE_API_KEY',
    },
  ],
});
if (dryRun.status !== 200) fail('import dry-run', JSON.stringify(dryRun.data));
if (dryRun.data.dryRun !== true || dryRun.data.acceptedCount !== 1) fail('bad import dry-run result', JSON.stringify(dryRun.data));
log('import dry-run', 'ok');

if (list.data.credentialBackend === 'memory') {
  const set = await req('POST', '/api/providers/openai-compatible/secret', {
    actor: 'dashboard',
    approved: true,
    secret: 'smoke-provider-secret',
  });
  if (set.status !== 200) fail('set memory secret', JSON.stringify(set.data));
  if (JSON.stringify(set.data).includes('smoke-provider-secret')) fail('secret set response leaked secret value');
  const afterSet = await req('GET', '/api/providers/openai-compatible/health');
  if (afterSet.data.status !== 'configured') fail('memory secret should configure provider', JSON.stringify(afterSet.data));
  const deleted = await req('DELETE', '/api/providers/openai-compatible/secret', { actor: 'dashboard', approved: true });
  if (deleted.status !== 200) fail('delete memory secret', JSON.stringify(deleted.data));
  log('memory secret flow', 'ok');
} else {
  log('secret write', 'skipped because backend is not memory');
}

log('done', 'ok');
