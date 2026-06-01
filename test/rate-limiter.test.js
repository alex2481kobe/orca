import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MemoryRateLimiter,
  classifyRoute,
} from '../src/rate-limiter.js';

test('rate limiter enforces a fixed-window policy without leaking actor keys', () => {
  let now = 1_000;
  const limiter = new MemoryRateLimiter({ now: () => now });
  const previousLimit = process.env.ORCA_RATE_LIMIT_AUTH_PAIR_LIMIT;
  const previousWindow = process.env.ORCA_RATE_LIMIT_AUTH_PAIR_WINDOW_MS;
  try {
    process.env.ORCA_RATE_LIMIT_AUTH_PAIR_LIMIT = '2';
    process.env.ORCA_RATE_LIMIT_AUTH_PAIR_WINDOW_MS = '1000';

    const first = limiter.check({ key: 'ip:test', policyName: 'authPair' });
    const second = limiter.check({ key: 'ip:test', policyName: 'authPair' });
    const third = limiter.check({ key: 'ip:test', policyName: 'authPair' });
    assert.equal(first.allowed, true);
    assert.equal(second.allowed, true);
    assert.equal(third.allowed, false);
    assert.equal(third.policyName, 'authPair');
    assert.equal(third.limit, 2);
    assert.equal(third.remaining, 0);
    assert.equal(third.retryAfterSeconds, 1);

    now = 2_001;
    const reset = limiter.check({ key: 'ip:test', policyName: 'authPair' });
    assert.equal(reset.allowed, true);
    assert.equal(reset.remaining, 1);
  } finally {
    if (previousLimit === undefined) delete process.env.ORCA_RATE_LIMIT_AUTH_PAIR_LIMIT;
    else process.env.ORCA_RATE_LIMIT_AUTH_PAIR_LIMIT = previousLimit;
    if (previousWindow === undefined) delete process.env.ORCA_RATE_LIMIT_AUTH_PAIR_WINDOW_MS;
    else process.env.ORCA_RATE_LIMIT_AUTH_PAIR_WINDOW_MS = previousWindow;
  }
});

test('route classifier maps privileged surfaces to specific policies', () => {
  assert.equal(classifyRoute('POST', ['api', 'auth', 'pair']), 'authPair');
  assert.equal(classifyRoute('GET', ['api', 'providers', 'codex', 'health']), 'providerHealth');
  assert.equal(classifyRoute('POST', ['api', 'providers', 'openai-compatible', 'secret']), 'providerSecret');
  assert.equal(classifyRoute('POST', ['api', 'providers', 'import', 'apply']), 'providerImportExport');
  assert.equal(classifyRoute('POST', ['api', 'lanes', 'lane-1', 'evidence']), 'evidenceCapture');
  assert.equal(classifyRoute('POST', ['api', 'sessions', 'session-1', 'lanes']), 'processSpawn');
  assert.equal(classifyRoute('POST', ['api', 'artifacts', 'cleanup']), 'cleanup');
  assert.equal(classifyRoute('POST', ['api', 'agent-tools', 'leases']), 'agentLease');
  assert.equal(classifyRoute('PATCH', ['api', 'private-access', 'settings']), 'privateAccess');
  assert.equal(classifyRoute('PATCH', ['api', 'mcp', 'tools', 'tool-1']), 'mcpMutation');
  assert.equal(classifyRoute('GET', ['api', 'projects']), 'defaultRead');
});
