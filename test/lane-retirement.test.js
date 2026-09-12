// A lane leaving hot state is archived, never dropped, and lane.get still reads
// it — within the same scope a tool lease would have had on the hot lane.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { OrcaRegistry } from '../src/registry.js';
import { readLaneArchive } from '../src/lane-archive.js';
import { laneJournalDir } from '../src/state-paths.js';
import { LEASE_HEADER } from '../src/mcp-connection.js';
import { approveFixtureRoot, restoreFixtureRoot } from './helpers/fence-root.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const roundTrip = (value) => JSON.parse(JSON.stringify(value));

async function inTempDir(fn) {
  const previousCwd = process.cwd();
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'orca-retire-'));
  process.chdir(dir);
  // The fixture's own directory is its fence; Orca approves no root by cwd.
  approveFixtureRoot(process.cwd());
  try { return await fn(dir); } finally {
    restoreFixtureRoot();
    process.chdir(previousCwd);
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
}

async function withEnv(vars, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(vars)) { previous[key] = process.env[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  try { return await fn(); } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

function openRegistry() {
  const registry = new OrcaRegistry({ autoCompleteMs: 60 * 60 * 1000, autoAudit: false });
  registry.stopScheduler();
  return registry;
}

async function closeRegistry(registry) {
  registry.stopScheduler();
  await registry.drainPendingWrites();
}

async function makeOrchestrator(registry, actor) {
  const { lease } = registry.createToolLease({ role: 'orchestrator', actor });
  return registry.registerOrchestrator({ cwd: process.cwd(), actor, title: actor }, { leaseId: lease.id });
}

function finishedLane(registry, orchestrator, title, { logs = 5, events = 5 } = {}) {
  const created = registry.createLane(orchestrator.id, { title, executorType: 'mock' }, { actor: 'test', approved: true });
  const lane = registry.getLane(created.id);
  for (let index = 0; index < logs; index += 1) registry.appendLaneLog(lane, `${title} log ${index}`);
  for (let index = 0; index < events; index += 1) registry.appendLaneAgentEvent(lane, { type: 'command.output', content: `${title} event ${index}` });
  registry.markLaneCompleted(lane);
  return lane;
}

test('lane.delete archives the lane with its logs; lane.get still reads it, within lease scope', async () => {
  await inTempDir(async () => {
    const registry = openRegistry();
    try {
      const orchestrator = await makeOrchestrator(registry, 'owner');
      const lane = finishedLane(registry, orchestrator, 'Deleted', { logs: 30, events: 10 });
      await registry.drainPendingWrites();
      const before = roundTrip(registry.laneForRead(lane));

      const result = await registry.deleteLane(lane.id, { actor: 'test' });
      assert.equal(result.deleted, true);
      assert.match(result.archivedTo, /^archive\/lanes\/[^/]+\/lane-\d{14}\.json\.gz$/);
      assert.equal(registry.getLane(lane.id), undefined);
      await registry.drainPendingWrites();
      assert.equal(fs.existsSync(laneJournalDir(registry.storageDir, lane.id)), false, 'journal removed once state.json no longer lists the lane');

      const saved = JSON.parse(await fsp.readFile(registry.stateFile, 'utf8'));
      assert.equal(saved.lanes.some((entry) => entry.id === lane.id), false);
      assert.equal(saved.archivedLanes.find((entry) => entry.id === lane.id).reason, 'deleted by test');

      const read = registry.readArchivedLane(lane.id);
      assert.equal(read.status, 200);
      assert.deepEqual(read.body.logs, before.logs);
      assert.deepEqual(read.body.agentEvents, before.agentEvents);
      assert.equal(read.body.title, 'Deleted');
      assert.equal(read.body.archived.reason, 'deleted by test');
      assert.equal(read.body.archived.totalLogs, before.logs.length);

      assert.equal(registry.readArchivedLane(lane.id, { lease: { sessionId: 'orc_someone_else' } }).status, 403);
      assert.equal(registry.readArchivedLane(lane.id, { lease: { sessionId: orchestrator.id } }).status, 200);
      assert.equal(registry.readArchivedLane('never-existed'), null);

      const deletion = registry.auditEvents.find((event) => event.type === 'lane_deleted' && event.laneId === lane.id);
      assert.equal(deletion.evidence.archivedTo, result.archivedTo);
      const status = registry.orchestratorStatus(orchestrator.id);
      assert.equal(status.archivedLanes, 1);
      assert.equal(status.lanes.some((entry) => entry.id === lane.id), false);
    } finally {
      await closeRegistry(registry);
    }
  });
});

test('the terminal-lane cap archives the oldest lanes instead of dropping them', async () => {
  await inTempDir(async () => {
    await withEnv({ ORCA_MAX_TERMINAL_LANES_PER_SESSION: '2' }, async () => {
      const registry = openRegistry();
      try {
        const orchestrator = await makeOrchestrator(registry, 'capped');
        const lanes = ['one', 'two', 'three', 'four'].map((title) => finishedLane(registry, orchestrator, title));
        lanes.forEach((lane, index) => { lane.completedAt = new Date(Date.UTC(2026, 0, 1 + index)).toISOString(); });
        assert.equal(registry.pruneInMemoryRecords(), true);
        await registry.drainPendingWrites();

        assert.deepEqual(registry.lanes.map((lane) => lane.title).sort(), ['four', 'three']);
        assert.deepEqual(registry.archivedLanes.map((entry) => entry.title).sort(), ['one', 'two']);
        for (const entry of registry.archivedLanes) {
          assert.match(entry.reason, /terminal-lane cap/);
          const archive = readLaneArchive(registry.storageDir, entry.id);
          assert.ok(archive.logs.some((log) => log.message === `${entry.title} log 4`), `${entry.title}'s logs are in its archive`);
          assert.equal(registry.readArchivedLane(entry.id).status, 200);
        }
      } finally {
        await closeRegistry(registry);
      }
    });
  });
});

test('a restarted daemon serves an archived lane over HTTP and refuses a lease scoped to another orchestrator', async () => {
  await inTempDir(async () => {
    const first = openRegistry();
    let laneId;
    let ownerToken;
    let otherToken;
    let before;
    try {
      const owner = await makeOrchestrator(first, 'owner');
      const other = await makeOrchestrator(first, 'other');
      const lane = finishedLane(first, owner, 'Archived over HTTP', { logs: 12, events: 7 });
      laneId = lane.id;
      await first.drainPendingWrites();
      before = roundTrip(first.laneForRead(lane));
      await first.deleteLane(lane.id, { actor: 'test' });
      ownerToken = first.createToolLease({ role: 'orchestrator', actor: 'owner-reader', sessionId: owner.id, allowedTools: ['lane.get'] }).leaseToken;
      otherToken = first.createToolLease({ role: 'orchestrator', actor: 'other-reader', sessionId: other.id, allowedTools: ['lane.get'] }).leaseToken;
    } finally {
      await closeRegistry(first);
    }

    await withEnv({ PORT: '0', ORCA_API_TOKEN: undefined }, async () => {
      const { routeRequest, stopServer } = await import(`${pathToFileURL(path.join(ROOT, 'src', 'server.js')).href}?lane-retirement=${Date.now()}`);
      const get = async (url, headers = {}, remoteAddress = '127.0.0.1') => {
        const chunks = [];
        const res = { statusCode: 200, headers: {}, setHeader(name, value) { this.headers[name.toLowerCase()] = value; }, end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); } };
        const req = new PassThrough();
        req.method = 'GET';
        req.url = url;
        req.headers = { host: '127.0.0.1', ...headers };
        req.socket = { remoteAddress };
        const handled = routeRequest(req, res);
        req.end();
        await handled;
        return { status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') };
      };
      try {
        const operator = await get(`/api/lanes/${laneId}`);
        assert.equal(operator.status, 200);
        assert.deepEqual(operator.body.logs, before.logs);
        assert.deepEqual(operator.body.agentEvents, before.agentEvents);
        assert.equal(operator.body.archived.reason, 'deleted by test');

        const own = await get(`/api/lanes/${laneId}`, { [LEASE_HEADER]: ownerToken });
        assert.equal(own.status, 200, JSON.stringify(own.body));
        const foreign = await get(`/api/lanes/${laneId}`, { [LEASE_HEADER]: otherToken });
        assert.equal(foreign.status, 403, JSON.stringify(foreign.body));

        const missing = await get('/api/lanes/never-existed');
        assert.equal(missing.status, 404);
      } finally {
        await stopServer();
      }
    });
  });
});
