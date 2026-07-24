// Guardrails added in the round-2 agent-parity audit: audit-accept integrity,
// the unmerged-commit discard guard, and spawn-time concurrency enforcement.
// These make destructive/accept paths refuse-by-default so an agent can't
// rubber-stamp or silently lose work.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { OrcaRegistry } from '../src/registry.js';
import { buildNextActionEnvelope } from '../src/agent-tools/next-action.js';
import { chooseNextTool } from '../src/agent-tools/next-action.js';

async function withRegistry(callback) {
  const previousCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-guardrails-'));
  process.chdir(tempDir);
  const registry = new OrcaRegistry({ autoCompleteMs: 60 * 60 * 1000 });
  registry.stopScheduler();
  try {
    return await callback(registry, tempDir);
  } finally {
    registry.stopScheduler();
    if (typeof registry.drainPendingWrites === 'function') await registry.drainPendingWrites();
    process.chdir(previousCwd);
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
}

async function makeOrchestrator(registry, { actor = 'test', title = 'Orch', cwd = process.cwd() } = {}) {
  const { lease } = registry.createToolLease({ role: 'orchestrator', actor });
  const orchestrator = await registry.registerOrchestrator({ cwd, actor, title }, { leaseId: lease.id });
  return { orchestrator, lease };
}

async function makeGitRepo(dirName) {
  const repoDir = path.join(process.cwd(), dirName);
  await fs.mkdir(repoDir, { recursive: true });
  const g = (...args) => spawnSync('git', args, { cwd: repoDir, encoding: 'utf8' });
  g('init', '-q'); g('config', 'user.email', 't@local'); g('config', 'user.name', 'T');
  await fs.writeFile(path.join(repoDir, 'README.md'), 'hi');
  g('add', 'README.md'); g('commit', '-qm', 'init');
  return { repoDir, g };
}

// --- 1a: audit.accept integrity ------------------------------------------------

test('acceptLaneAudit refuses an empty rubber-stamp (no findings, no reviewedFiles)', async () => {
  await withRegistry(async (registry) => {
    const { orchestrator } = await makeOrchestrator(registry);
    const lane = registry.createLane(orchestrator.id, { title: 'work', executorType: 'mock' }, { actor: 'test', approved: true });
    registry.markLaneCompleted(registry.getLane(lane.id));

    let thrown;
    try { registry.acceptLaneAudit(lane.id, { actor: 'auditor' }); } catch (e) { thrown = e; }
    assert.ok(thrown, 'accept with no review must throw');
    assert.equal(thrown.status, 409);
    assert.equal(thrown.nextAction?.nextRequiredTool, 'audit.findings.record');
    // Lane was NOT accepted.
    assert.notEqual(registry.getLane(lane.id).state, 'accepted');
  });
});

test('acceptLaneAudit succeeds once a finding OR a reviewed file is recorded', async () => {
  await withRegistry(async (registry) => {
    const { orchestrator } = await makeOrchestrator(registry);
    const withFinding = registry.createLane(orchestrator.id, { title: 'a', executorType: 'mock' }, { actor: 'test', approved: true });
    registry.markLaneCompleted(registry.getLane(withFinding.id));
    const r1 = registry.acceptLaneAudit(withFinding.id, { actor: 'auditor', findings: ['tests pass'] });
    assert.equal(r1.lane.state, 'accepted');

    const withReviewed = registry.createLane(orchestrator.id, { title: 'b', executorType: 'mock' }, { actor: 'test', approved: true });
    registry.markLaneCompleted(registry.getLane(withReviewed.id));
    const r2 = registry.acceptLaneAudit(withReviewed.id, { actor: 'auditor', reviewedFiles: ['src/foo.js'] });
    assert.equal(r2.lane.state, 'accepted');
  });
});

test('acceptLaneAudit refuses a targetUrl (UI) lane with no captured evidence, accepts with a screenshot', async () => {
  await withRegistry(async (registry, tempDir) => {
    const { orchestrator } = await makeOrchestrator(registry);
    const lane = registry.createLane(orchestrator.id, {
      title: 'ui', executorType: 'mock', targetUrl: 'http://localhost:3000',
    }, { actor: 'test', approved: true });
    registry.markLaneCompleted(registry.getLane(lane.id));

    // A finding alone is NOT enough for UI work — fresh evidence is required.
    let thrown;
    try { registry.acceptLaneAudit(lane.id, { actor: 'auditor', findings: ['looks right'] }); } catch (e) { thrown = e; }
    assert.ok(thrown, 'targetUrl lane without evidence must throw');
    assert.equal(thrown.status, 409);
    assert.match(thrown.message, /evidence/i);
    assert.equal(thrown.nextAction?.nextRequiredTool, 'audit.findings.record');

    // Drop a screenshot artifact into the lane's artifact dir -> now acceptable.
    const artifactDir = path.join(tempDir, 'artifacts', String(lane.sessionId), String(lane.id));
    await fs.mkdir(artifactDir, { recursive: true });
    await fs.writeFile(path.join(artifactDir, 'screenshot.png'), 'PNGDATA');
    const ok = registry.acceptLaneAudit(lane.id, { actor: 'auditor', findings: ['verified against screenshot'] });
    assert.equal(ok.lane.state, 'accepted');
  });
});

// --- 1b: unmerged-commit guard on discard --------------------------------------

test('removeLaneWorktree refuses a branch with unmerged commits unless force:true', async () => {
  await withRegistry(async (registry) => {
    const { repoDir } = await makeGitRepo('unmerged-repo');
    const { orchestrator } = await makeOrchestrator(registry, { cwd: repoDir });
    const lane = registry.createLane(orchestrator.id, {
      title: 'feature', executorType: 'mock', branch: 'feat', worktreeMode: 'isolated',
    }, { actor: 'test', approved: true });
    assert.ok(lane.worktreePath && lane.branch === 'feat');

    // Commit work on the lane branch but never integrate it into base.
    const gw = (...args) => spawnSync('git', args, { cwd: lane.worktreePath, encoding: 'utf8' });
    await fs.writeFile(path.join(lane.worktreePath, 'feature.txt'), 'new feature');
    gw('add', 'feature.txt'); gw('commit', '-qm', 'add feature');
    registry.getLane(lane.id).state = 'done';

    // Clean worktree (no uncommitted work) but the branch is ahead of base -> refuse.
    let thrown;
    try { await registry.removeLaneWorktree(lane.id, { approved: true }); } catch (e) { thrown = e; }
    assert.ok(thrown, 'discard must refuse an unmerged branch');
    assert.equal(thrown.status, 409);
    assert.equal(thrown.unmergedCommits, 1);
    assert.match(thrown.message, /feat/);
    assert.match(thrown.message, /not integrated/i);
    assert.equal((await fs.stat(lane.worktreePath)).isDirectory(), true, 'worktree still present after refusal');

    // force:true discards it.
    const forced = await registry.removeLaneWorktree(lane.id, { approved: true, force: true });
    assert.equal(forced.removed, true);
    await assert.rejects(fs.access(lane.worktreePath), (e) => e.code === 'ENOENT');
  });
});

test('removeLaneWorktree removes a fully-merged branch without force', async () => {
  await withRegistry(async (registry) => {
    const { repoDir, g } = await makeGitRepo('merged-repo');
    const baseBranch = g('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();
    const { orchestrator } = await makeOrchestrator(registry, { cwd: repoDir });
    const lane = registry.createLane(orchestrator.id, {
      title: 'merged', executorType: 'mock', branch: 'donebranch', worktreeMode: 'isolated',
    }, { actor: 'test', approved: true });

    const gw = (...args) => spawnSync('git', args, { cwd: lane.worktreePath, encoding: 'utf8' });
    await fs.writeFile(path.join(lane.worktreePath, 'done.txt'), 'x');
    gw('add', 'done.txt'); gw('commit', '-qm', 'work');
    registry.getLane(lane.id).state = 'accepted';
    registry.getLane(lane.id).auditState = 'accepted';

    // Integrate the branch into base, so nothing is unmerged.
    const merged = await registry.integrateLane(lane.id);
    assert.equal(merged.integrated, true);
    assert.equal(merged.baseBranch, baseBranch);

    // Now discard is safe without force (no uncommitted + nothing unmerged).
    const removed = await registry.removeLaneWorktree(lane.id, { approved: true });
    assert.equal(removed.removed, true);
  });
});

// --- 1c: concurrency enforcement at spawn --------------------------------------

test('createLane refuses to spawn past the orchestrator lane-concurrency limit', async () => {
  await withRegistry(async (registry) => {
    const { orchestrator, lease } = await makeOrchestrator(registry);
    // Pin the container to a single concurrent lane.
    registry.updateOrchestrator(orchestrator.id, { laneConcurrencyLimit: 1 }, { leaseId: lease.id });

    // First spawn fits.
    const first = registry.createLane(orchestrator.id, { title: 'one', executorType: 'mock' }, { actor: 'test', approved: true });
    assert.ok(first.id);

    // Second spawn exceeds capacity (the first is still live/queued) -> 409.
    let thrown;
    try { registry.createLane(orchestrator.id, { title: 'two', executorType: 'mock' }, { actor: 'test', approved: true }); } catch (e) { thrown = e; }
    assert.ok(thrown, 'over-capacity spawn must throw');
    assert.equal(thrown.status, 409);
    assert.match(thrown.message, /capacity/i);
    assert.ok(thrown.nextAction, 'refusal carries a nextAction envelope');

    // Freeing the slot (accept the first) lets a new lane spawn.
    registry.markLaneCompleted(registry.getLane(first.id));
    registry.acceptLaneAudit(first.id, { actor: 'auditor', findings: ['ok'] });
    const third = registry.createLane(orchestrator.id, { title: 'three', executorType: 'mock' }, { actor: 'test', approved: true });
    assert.ok(third.id, 'spawn allowed once a slot frees up');
  });
});

// --- Group 2: new agent-callable tools (registry backing logic) ----------------

test('lane.artifacts.list + lane.artifacts.get enumerate and fetch a lane artifact', async () => {
  await withRegistry(async (registry, tempDir) => {
    const { orchestrator } = await makeOrchestrator(registry);
    const lane = registry.createLane(orchestrator.id, { title: 'a', executorType: 'mock' }, { actor: 'test', approved: true });
    const dir = path.join(tempDir, 'artifacts', String(lane.sessionId), String(lane.id));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'notes.txt'), 'hello world');
    await fs.writeFile(path.join(dir, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const files = await registry.listArtifactFiles(lane.id);
    assert.deepEqual(files, ['notes.txt', 'shot.png']);

    const text = await registry.readArtifactFile(lane.id, 'notes.txt');
    assert.equal(text.encoding, 'utf8');
    assert.equal(text.content, 'hello world');

    const img = await registry.readArtifactFile(lane.id, 'shot.png');
    assert.equal(img.encoding, 'base64');
    assert.equal(Buffer.from(img.content, 'base64')[0], 0x89);

    // Traversal + missing-file are refused, not served.
    await assert.rejects(registry.readArtifactFile(lane.id, '../secret'), (e) => e.status === 422);
    await assert.rejects(registry.readArtifactFile(lane.id, 'nope.txt'), (e) => e.status === 404);
  });
});

test('lane.terminal.write refuses a lane that is not running', async () => {
  await withRegistry(async (registry) => {
    const { orchestrator } = await makeOrchestrator(registry);
    const lane = registry.createLane(orchestrator.id, { title: 'a', executorType: 'mock' }, { actor: 'test', approved: true });
    registry.markLaneCompleted(registry.getLane(lane.id)); // -> done (not live)
    assert.throws(
      () => registry.writeLaneTerminalInput(lane.id, { input: 'y\n', actor: 'orchestrator' }),
      (e) => e.status === 409 && /not running/i.test(e.message),
    );
  });
});

test('fleet.emergency_stop stops every live lane under the orchestrator', async () => {
  await withRegistry(async (registry) => {
    const { orchestrator } = await makeOrchestrator(registry);
    const a = registry.createLane(orchestrator.id, { title: 'a', executorType: 'mock' }, { actor: 'test', approved: true });
    const b = registry.createLane(orchestrator.id, { title: 'b', executorType: 'mock' }, { actor: 'test', approved: true });

    const result = await registry.emergencyStopContainer(orchestrator.id, { actor: 'orchestrator' });
    assert.equal(result.laneCount, 2);
    assert.equal(result.stopped, 2);
    assert.equal(registry.getLane(a.id).state, 'stopped');
    assert.equal(registry.getLane(b.id).state, 'stopped');
    // Unknown orchestrator -> 404.
    await assert.rejects(registry.emergencyStopContainer('orc_nope', {}), (e) => e.status === 404);
  });
});

test('the durable audit log records lane lifecycle events', async () => {
  await withRegistry(async (registry) => {
    const { orchestrator } = await makeOrchestrator(registry);
    const lane = registry.createLane(orchestrator.id, { title: 'a', executorType: 'mock' }, { actor: 'test', approved: true });
    registry.markLaneCompleted(registry.getLane(lane.id));

    // The log is still written for forensics even though no agent tool reads it
    // (audit.log.read / audit.log.ack and their routes are gone).
    const events = registry.listAuditEvents({});
    assert.ok(Array.isArray(events) && events.length > 0, 'audit log has events');
    assert.ok(events.some((event) => event.laneId === lane.id), 'lane lifecycle is recorded');
  });
});

// --- Group 3a: nextAction on successful mutations ------------------------------

test('successful mutations carry a nextAction pointing at the next step', async () => {
  await withRegistry(async (registry) => {
    const { orchestrator } = await makeOrchestrator(registry);

    // createLane -> observe the new lane.
    const created = registry.createLane(orchestrator.id, { title: 'a', executorType: 'mock' }, { actor: 'test', approved: true });
    assert.equal(created.nextAction?.nextRequiredTool, 'lane.get');

    // submit -> queue the audit.
    registry.getLane(created.id).state = 'running';
    const submitted = registry.submitLane(created.id, { actor: 'executor', summary: 'done' });
    assert.equal(submitted.lane.state, 'ready_for_audit');
    assert.equal(submitted.nextAction?.nextRequiredTool, 'audit.queue_one');

    // requestLaneFix -> retry (same-agent default routing).
    registry.queueLaneAudit(created.id, { actor: 'orchestrator', approved: true });
    const fixed = registry.requestLaneFix(created.id, { actor: 'orchestrator', findings: ['nit'] });
    assert.equal(fixed.nextAction?.nextRequiredTool, 'lane.retry');
  });
});

test('accepting an isolated lane points nextAction at lane.integrate', async () => {
  await withRegistry(async (registry) => {
    const { repoDir } = await makeGitRepo('accept-integrate-repo');
    const { orchestrator } = await makeOrchestrator(registry, { cwd: repoDir });
    const lane = registry.createLane(orchestrator.id, {
      title: 'iso', executorType: 'mock', branch: 'feat', worktreeMode: 'isolated',
    }, { actor: 'test', approved: true });
    registry.getLane(lane.id).state = 'done';
    const accepted = registry.acceptLaneAudit(lane.id, { actor: 'auditor', findings: ['ok'] });
    assert.equal(accepted.lane.state, 'accepted');
    assert.equal(accepted.nextAction?.nextRequiredTool, 'lane.integrate');
  });
});

// --- Group 3c: nextAction hygiene (dead flags removed) -------------------------

test('a blocked lane escalates to the status view, it does not loop on lane.retry', async () => {
  const blocked = chooseNextTool({ role: 'orchestrator', project: { id: 'p' }, session: { id: 's' }, lane: { id: 'l', state: 'blocked' } });
  assert.equal(blocked, 'orchestrator.status');
  assert.notEqual(blocked, 'lane.retry');
  // The dead needs_critique -> lane.get path is gone (falls through to a poll).
  assert.notEqual(chooseNextTool({ role: 'orchestrator', project: { id: 'p' }, session: { id: 's' }, lane: { id: 'l', state: 'needs_critique' } }), 'lane.get');
});

test('the nextAction envelope no longer exposes dead critique-role signals', async () => {
  await withRegistry(async (registry) => {
    const { orchestrator } = await makeOrchestrator(registry);
    const lane = registry.createLane(orchestrator.id, { title: 'a', executorType: 'mock', targetUrl: 'http://localhost:3000' }, { actor: 'test', approved: true });
    const env = buildNextActionEnvelope(registry, { role: 'orchestrator', projectId: orchestrator.projectId, sessionId: orchestrator.id, laneId: lane.id });
    for (const dead of ['critiqueRequired', 'critiqueSatisfied', 'evidenceFresh', 'blockedTools']) {
      assert.equal(Object.prototype.hasOwnProperty.call(env, dead), false, `envelope must not expose dead signal ${dead}`);
    }
    // The live audit-evidence gate is kept.
    assert.equal(env.evidenceRequired, true, 'targetUrl lane still flags evidenceRequired');
  });
});
