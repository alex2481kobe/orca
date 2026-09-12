// Audit events point at a lane (id, state at the event, digest); they never
// embed the lane. The embedded copies were 300 MB of a 525 MB state file.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OrcaRegistry } from '../src/registry.js';
import { compactAuditEvidence, laneDigest } from '../src/audit-evidence.js';
import { approveFixtureRoot, restoreFixtureRoot } from './helpers/fence-root.js';

async function withRegistry(callback, { cwd = null } = {}) {
  const previousCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-evidence-'));
  process.chdir(tempDir);
  // The fixture's own directory is its fence; Orca approves no root by cwd.
  approveFixtureRoot(process.cwd());
  const registry = new OrcaRegistry({ autoCompleteMs: 60 * 60 * 1000, autoAudit: false });
  registry.stopScheduler();
  try { return await callback(registry, tempDir); } finally {
    registry.stopScheduler();
    await registry.drainPendingWrites();
    restoreFixtureRoot();
    process.chdir(previousCwd);
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
}

async function setup(registry, cwd = process.cwd()) {
  const { lease } = registry.createToolLease({ role: 'orchestrator', actor: 'test' });
  const orchestrator = await registry.registerOrchestrator({ cwd, actor: 'test', title: 'Evidence' }, { leaseId: lease.id });
  return { orchestrator };
}

const laneEventsFor = (registry, laneId) => registry.auditEvents.filter((event) => event.laneId === laneId && event.evidence?.laneRef);

test('lane audit events carry a small reference, not the lane — even for a chatty lane', async () => {
  await withRegistry(async (registry) => {
    const { orchestrator } = await setup(registry);
    const created = registry.createLane(orchestrator.id, { title: 'Chatty', executorType: 'mock' }, { actor: 'test', approved: true });
    const lane = registry.getLane(created.id);
    for (let index = 0; index < 400; index += 1) registry.appendLaneLog(lane, `line ${index} ${'x'.repeat(4000)}`);
    for (let index = 0; index < 100; index += 1) registry.appendLaneAgentEvent(lane, { type: 'command.output', content: 'y'.repeat(4000) });
    registry.markLaneCompleted(lane);

    const events = laneEventsFor(registry, lane.id);
    assert.deepEqual(events.map((event) => event.type).sort(), ['lane_completed', 'lane_created']);
    for (const event of events) {
      assert.equal(event.evidence.lane, undefined, `${event.type} still embeds the lane`);
      assert.equal(event.evidence.laneRef.id, lane.id);
      assert.equal(event.evidence.laneRef.title, 'Chatty');
      assert.match(event.evidence.laneRef.digest, /^sha256:[0-9a-f]{64}$/);
    }
    assert.equal(events.find((event) => event.type === 'lane_completed').evidence.laneRef.state, 'done');

    const laneBytes = Buffer.byteLength(JSON.stringify(lane));
    const eventBytes = Buffer.byteLength(JSON.stringify(registry.auditEvents));
    assert.ok(laneBytes > 1_500_000, `fixture lane should be large, was ${laneBytes}`);
    assert.ok(eventBytes < 20_000, `audit events should stay small, were ${eventBytes} bytes`);

    registry._flushPersistTimer();
    await registry.drainPendingWrites();
    const saved = JSON.parse(await fs.readFile(registry.stateFile, 'utf8'));
    assert.ok(Buffer.byteLength(JSON.stringify(saved.auditEvents)) < 20_000, 'persisted audit events stay small');
    assert.equal(JSON.stringify(saved.auditEvents).includes('x'.repeat(4000)), false, 'no lane log text in persisted audit events');
  });
});

test('audit evidence is point-in-time: a later lane change does not rewrite an earlier event', async () => {
  await withRegistry(async (registry) => {
    const { orchestrator } = await setup(registry);
    const created = registry.createLane(orchestrator.id, { title: 'Moves on', executorType: 'mock' }, { actor: 'test', approved: true });
    const lane = registry.getLane(created.id);
    const createdEvent = laneEventsFor(registry, lane.id).find((event) => event.type === 'lane_created');
    const digestAtCreation = laneDigest(lane);
    assert.equal(createdEvent.evidence.laneRef.state, 'queued');
    assert.equal(createdEvent.evidence.laneRef.digest, digestAtCreation);

    registry.markLaneCompleted(lane);
    // Before this change the evidence WAS the lane object, so it read 'done' here.
    assert.equal(createdEvent.evidence.laneRef.state, 'queued');
    assert.equal(createdEvent.evidence.laneRef.digest, digestAtCreation);
    assert.notEqual(laneDigest(lane), digestAtCreation);
  });
});

test('laneDigest ignores the streams, key order and a JSON round trip; it sees every other field', () => {
  const lane = { id: 'lane-a', title: 't', state: 'done', nested: { b: 1, a: 2 }, logs: [{ at: 'x', message: 'm' }], agentEvents: [] };
  const digest = laneDigest(lane);
  assert.equal(laneDigest({ ...lane, logs: [], agentEvents: [{ type: 'e' }] }), digest);
  assert.equal(laneDigest(JSON.parse(JSON.stringify(lane))), digest);
  assert.equal(laneDigest({ nested: { a: 2, b: 1 }, state: 'done', title: 't', id: 'lane-a' }), digest);
  assert.equal(laneDigest({ ...lane, missing: undefined }), digest);
  assert.notEqual(laneDigest({ ...lane, state: 'failed' }), digest);
  assert.notEqual(laneDigest({ ...lane, nested: { a: 2, b: 2 } }), digest);
});

test('recordAudit replaces a stray embedded lane with a reference and leaves other evidence alone', async () => {
  await withRegistry(async (registry) => {
    const { orchestrator } = await setup(registry);
    const created = registry.createLane(orchestrator.id, { title: 'Stray', executorType: 'mock' }, { actor: 'test', approved: true });
    const lane = registry.getLane(created.id);
    const strayId = registry.recordAudit({ type: 'custom_event', laneId: lane.id, evidence: { lane, extra: 1 } });
    const stray = registry.auditEvents.find((event) => event.id === strayId);
    assert.equal(stray.evidence.lane, undefined);
    assert.equal(stray.evidence.extra, 1);
    assert.equal(stray.evidence.laneRef.id, lane.id);

    const plainId = registry.recordAudit({ type: 'custom_event', evidence: { leaseId: 'l1', reason: 'r' } });
    assert.deepEqual(registry.auditEvents.find((event) => event.id === plainId).evidence, { leaseId: 'l1', reason: 'r' });
    assert.deepEqual(compactAuditEvidence({ lane: 'not-an-object' }), { lane: 'not-an-object' });
    assert.equal(compactAuditEvidence(null), null);
  });
});

test('worktree removal evidence records the path it removed (the embedded lane had already cleared it)', async () => {
  await withRegistry(async (registry, tempDir) => {
    const repoDir = path.join(tempDir, 'repo');
    await fs.mkdir(repoDir, { recursive: true });
    const git = (...args) => spawnSync('git', args, { cwd: repoDir, encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 'test@local');
    git('config', 'user.name', 'Test');
    await fs.writeFile(path.join(repoDir, 'README.md'), 'repo\n');
    git('add', '.');
    git('commit', '-qm', 'init');

    const { orchestrator } = await setup(registry, repoDir);
    const created = registry.createLane(orchestrator.id, { title: 'Isolated', executorType: 'mock', worktreeMode: 'isolated' }, { actor: 'test', approved: true });
    const lane = registry.getLane(created.id);
    const worktreePath = lane.worktreePath;
    assert.equal(lane.worktreeMode, 'isolated');
    registry.markLaneCompleted(lane);
    await registry.drainPendingWrites();

    const result = await registry.removeLaneWorktree(lane.id, { actor: 'test', approved: true, force: true });
    assert.equal(result.removed, true);
    const removal = registry.auditEvents.find((event) => event.type === 'lane_worktree_removed' && event.laneId === lane.id);
    assert.equal(removal.evidence.lane, undefined);
    assert.equal(removal.evidence.worktreePath, worktreePath);
    assert.equal(removal.evidence.laneRef.id, lane.id);
    assert.equal(removal.evidence.force, true);
  });
});
