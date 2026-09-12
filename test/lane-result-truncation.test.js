// A captured lane result that was cut must SAY it was cut.
//
// On 2026-09-11 four Codex lanes finished with resultText at exactly 12,000
// characters, each cut mid-sentence with nothing marking it — their real reports
// were 16,870 / 16,913 / 18,261 / 28,719 characters. The same capped value went
// into outcome.txt and transcript.json, so the complete text survived only inside
// the raw stdout.log. An orchestrator reading lane.get could not tell.
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OrcaRegistry } from '../src/registry.js';
import { createAgentEventNormalizer } from '../src/agent-events.js';
import { renderLaneTree } from '../src/render-lane-tree.js';
import { MAX_RESULT_CONTENT, LANE_RESULT_ARTIFACT } from '../src/lane-result.js';
import { approveFixtureRoot, restoreFixtureRoot } from './helpers/fence-root.js';

// The real report that lost 58% of itself, and one that fits.
const HUGE = 28719;
const SMALL = 2152;
const body = (length, seed = 'r') => seed.repeat(length).slice(0, length);

async function inTempDir(fn) {
  const previousCwd = process.cwd();
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'orca-result-'));
  process.chdir(dir);
  approveFixtureRoot(process.cwd());
  try { return await fn(dir); } finally {
    restoreFixtureRoot();
    process.chdir(previousCwd);
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
}

async function laneWithResult(registry, text) {
  const { lease } = registry.createToolLease({ role: 'orchestrator', actor: 'owner' });
  const orchestrator = await registry.registerOrchestrator(
    { cwd: process.cwd(), actor: 'owner', title: 'owner' },
    { leaseId: lease.id },
  );
  const created = registry.createLane(
    orchestrator.id,
    { title: 'reporting lane', executorType: 'codex' },
    { actor: 'test', approved: true },
  );
  const lane = registry.getLane(created.id);
  registry.appendLaneAgentEvent(lane, { type: 'message.assistant.final', source: 'codex', content: text });
  return lane;
}

test('the event normalizer no longer cuts a final report at the event cap', () => {
  const normalizer = createAgentEventNormalizer('codex');
  const report = body(HUGE);
  const events = normalizer.consume('stdout', `${JSON.stringify({
    type: 'item.completed',
    item: { id: 'msg-1', type: 'agent_message', text: report },
  })}\n`);
  const final = events.find((event) => event.type === 'message.assistant.final');
  assert.equal(final.content.length, HUGE, 'the whole report reaches the registry; the cap belongs to storage');
});

test('a report past the cap is stored marked, measured, and pointed at its artifact', async () => {
  await inTempDir(async () => {
    const registry = new OrcaRegistry({ autoCompleteMs: 60 * 60 * 1000, autoAudit: false });
    registry.stopScheduler();
    try {
      const report = body(HUGE * 2); // 57,438 chars: past the 32,000 cap
      const lane = await laneWithResult(registry, report);
      await registry.drainPendingWrites();

      assert.equal(lane.resultTruncated, true);
      assert.equal(lane.resultFullLength, report.length);
      assert.equal(lane.resultArtifact, LANE_RESULT_ARTIFACT);
      assert.equal(lane.resultText.slice(0, MAX_RESULT_CONTENT), report.slice(0, MAX_RESULT_CONTENT));
      // The value itself says it was cut, how much is missing, and where the rest is.
      assert.match(lane.resultText, /\[orca\] RESULT TRUNCATED/);
      assert.match(lane.resultText, /57,438-character report/);
      assert.match(lane.resultText, /25,438 characters are not shown/);
      assert.match(lane.resultText, new RegExp(LANE_RESULT_ARTIFACT));
      assert.ok(
        lane.logs.some((entry) => /result truncated for storage/.test(entry.message)),
        'the lane log records the cut too',
      );

      // The complete text is a real artifact, not only the raw executor stream.
      const artifact = path.join(process.cwd(), 'artifacts', lane.sessionId, lane.id, LANE_RESULT_ARTIFACT);
      const saved = await fsp.readFile(artifact, 'utf8');
      assert.equal(saved.trimEnd(), report, 'result.txt holds the whole report');

      // lane.get / lane.list hand the same facts to an orchestrator.
      const read = registry.laneForRead(lane);
      assert.equal(read.resultTruncated, true);
      assert.equal(read.resultFullLength, report.length);
      const listed = registry.listLanesCompact(lane.sessionId).find((entry) => entry.id === lane.id);
      assert.equal(listed.resultTruncated, true);
      assert.equal(listed.resultFullLength, report.length);

      // The MCP lane tree clips to 64 chars, which would otherwise read as whole.
      const tree = renderLaneTree({ name: 'p' }, [listed]);
      assert.match(tree, /result truncated: 57,438 chars total/);
    } finally {
      registry.stopScheduler();
      await registry.drainPendingWrites();
    }
  });
});

test('a report that fits is stored whole, unmarked, and still archived to its artifact', async () => {
  await inTempDir(async () => {
    const registry = new OrcaRegistry({ autoCompleteMs: 60 * 60 * 1000, autoAudit: false });
    registry.stopScheduler();
    try {
      const report = body(SMALL);
      const lane = await laneWithResult(registry, report);
      await registry.drainPendingWrites();

      assert.equal(lane.resultTruncated, false);
      assert.equal(lane.resultFullLength, SMALL);
      assert.equal(lane.resultText, report, 'nothing is added to a result that was not cut');
      assert.equal(renderLaneTree({ name: 'p' }, [lane]).includes('result truncated'), false);

      const artifact = path.join(process.cwd(), 'artifacts', lane.sessionId, lane.id, LANE_RESULT_ARTIFACT);
      assert.equal((await fsp.readFile(artifact, 'utf8')).trimEnd(), report);
    } finally {
      registry.stopScheduler();
      await registry.drainPendingWrites();
    }
  });
});

test('outcome.txt and transcript.json say the result was cut and name the artifact', async () => {
  await inTempDir(async () => {
    const registry = new OrcaRegistry({ autoCompleteMs: 60 * 60 * 1000, autoAudit: false });
    registry.stopScheduler();
    try {
      const report = body(HUGE * 2);
      const lane = await laneWithResult(registry, report);
      registry.markLaneCompleted(lane);
      await registry.drainPendingWrites();

      const laneDir = path.join(process.cwd(), 'artifacts', lane.sessionId, lane.id);
      const outcome = await fsp.readFile(path.join(laneDir, 'outcome.txt'), 'utf8');
      assert.match(outcome, /^Result truncated: yes — 57438 chars captured, whole text in result\.txt$/m);
      assert.match(outcome, /\[orca\] RESULT TRUNCATED/);

      const transcript = JSON.parse(await fsp.readFile(path.join(laneDir, 'transcript.json'), 'utf8'));
      assert.equal(transcript.resultTruncated, true);
      assert.equal(transcript.resultFullLength, report.length);
      assert.equal(transcript.resultArtifact, LANE_RESULT_ARTIFACT);
      assert.match(transcript.resultText, /\[orca\] RESULT TRUNCATED/);
    } finally {
      registry.stopScheduler();
      await registry.drainPendingWrites();
    }
  });
});
