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
  assert.equal(classifyRoute('POST', ['api', 'lanes', 'lane-1', 'evidence']), 'evidenceCapture');
  // Spawning launches a REAL CLI child process, so it must sit on the strict
  // processSpawn budget. This line used to assert the deleted
  // POST /api/sessions/{id}/lanes — i.e. the budget was pinned to a dead route while
  // every live spawn fell through to the 180/min defaultMutation bucket.
  assert.equal(classifyRoute('POST', ['api', 'orchestrators', 'orc-1', 'executors']), 'processSpawn');
  // Registering is cheap per call but unbounded in effect (each orchestrator brings
  // its own lane capacity), so it shares the same budget.
  assert.equal(classifyRoute('POST', ['api', 'orchestrators']), 'processSpawn');
  assert.equal(classifyRoute('POST', ['api', 'artifacts', 'cleanup']), 'cleanup');
  assert.equal(classifyRoute('POST', ['api', 'agent-tools', 'leases']), 'agentLease');
  assert.equal(classifyRoute('PATCH', ['api', 'private-access', 'settings']), 'privateAccess');
  assert.equal(classifyRoute('PATCH', ['api', 'mcp', 'tools', 'tool-1']), 'mcpMutation');
  assert.equal(classifyRoute('GET', ['api', 'projects']), 'defaultRead');
});
