import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandDeckRegistry } from '../src/registry.js';

const previousCwd = process.cwd();
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'command-deck-notifications-'));

async function waitForLane(registry, laneId) {
  for (let i = 0; i < 80; i += 1) {
    const lane = registry.getLane(laneId);
    if (['done', 'failed', 'stopped', 'needs_critique'].includes(lane?.state)) return lane;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return registry.getLane(laneId);
}

try {
  process.chdir(tempDir);
  const registry = new CommandDeckRegistry({
    heartbeatIntervalMs: 25,
    autoCompleteMs: 50,
  });

  const project = registry.createProject({
    name: 'Notification Smoke',
  }, {
    actor: 'smoke',
    approved: true,
  });
  const session = registry.createSession(project.id, {
    name: 'Notification Session',
  }, {
    actor: 'smoke',
    approved: true,
  });
  const lane = await registry.createLane(session.id, {
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
}
