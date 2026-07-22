import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OrcaRegistry } from '../src/registry.js';

const previousCwd = process.cwd();
const previousEnv = { ...process.env };
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-notifications-'));
const realTempDir = await fs.realpath(tempDir);

async function waitForLane(registry, laneId) {
  for (let i = 0; i < 80; i += 1) {
    const lane = registry.getLane(laneId);
    if (['done', 'failed', 'stopped', 'needs_critique'].includes(lane?.state)) return lane;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return registry.getLane(laneId);
}

// v2: no session container. An orchestrator lease registers by cwd (implicitly
// creating the project keyed by cwd) and lanes are created under the orchestrator
// record (createLane's first arg is the orc_ id; lane.sessionId === orchestratorId).
async function makeOrchestrator(registry, { actor = 'smoke', title = 'Notification Orchestrator' } = {}) {
  const { lease } = registry.createToolLease({ role: 'orchestrator', actor });
  const orchestrator = await registry.registerOrchestrator(
    { cwd: realTempDir, actor, title },
    { leaseId: lease.id },
  );
  return { orchestrator, lease };
}

try {
  process.chdir(tempDir);
  process.env.ORCA_REPO_ROOTS = realTempDir;
  const registry = new OrcaRegistry({
    heartbeatIntervalMs: 25,
    autoCompleteMs: 50,
  });

  const { orchestrator } = await makeOrchestrator(registry);
  const lane = await registry.createLane(orchestrator.id, {
    title: 'Do not leak sk-smoke-notification-secret',
    taskDescription: 'Exercise terminal notification redaction.',
    executorType: 'mock',
  }, {
    actor: 'smoke',
    approved: true,
  });

  const finished = await waitForLane(registry, lane.id);
  assert.equal(finished.state, 'done');

  const list = registry.getNotifications();
  assert.equal(list.settings.inAppEnabled, true);
  assert.equal(list.unreadCount >= 1, true);
  assert.equal(JSON.stringify(list).includes('sk-smoke-notification-secret'), false);
  const terminal = list.notifications.find((item) => item.laneId === lane.id);
  assert.ok(terminal);
  assert.equal(terminal.severity, 'success');
  assert.match(terminal.href, /^\/projects\//);

  const read = registry.markNotificationRead(terminal.id, { actor: 'smoke' });
  assert.ok(read.readAt);
  assert.equal(registry.getNotifications().unreadCount, list.unreadCount - 1);

  const settings = registry.updateNotificationSettings({
    actor: 'smoke',
    approved: true,
    inAppEnabled: true,
    browserEnabled: true,
    minSeverity: 'warning',
    muted: false,
  });
  assert.equal(settings.settings.browserEnabled, true);
  assert.equal(settings.settings.minSeverity, 'warning');

  const skipped = registry.enqueueNotification({
    severity: 'info',
    title: 'Filtered info',
    body: 'This should be filtered by warning threshold.',
  });
  assert.equal(skipped, null);

  registry.stopScheduler();
  await registry.drainPendingWrites();
  console.log('notifications smoke passed');
} finally {
  process.chdir(previousCwd);
  await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  for (const key of Object.keys(process.env)) {
    if (!(key in previousEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(previousEnv)) {
    process.env[key] = value;
  }
}
