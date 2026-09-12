// Lane logs and agent events live in per-lane journal files, not state.json.
// Readers (lane.get, lane.list, transcripts, the dashboard) see what they saw
// before; the journal keeps every line, including those the in-memory cap drops.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { OrcaRegistry } from '../src/registry.js';
import { appendJournalEntries, readJournalAll, readJournalTail } from '../src/lane-journal.js';
import { laneArchivedSegmentsDir, laneJournalDir, laneKey } from '../src/state-paths.js';
import { approveFixtureRoot, restoreFixtureRoot } from './helpers/fence-root.js';

const roundTrip = (value) => JSON.parse(JSON.stringify(value));

async function withTempDir(prefix, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try { return await fn(dir); } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
}

async function withEnv(vars, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  try { return await fn(); } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// A fixture that registers an orchestrator declares its directory as the fence,
// the way a real install does with `setup --roots`: Orca never treats the
// directory it runs in as an approved root (src/fence.js).
async function inDir(dir, fn) {
  const previousCwd = process.cwd();
  process.chdir(dir);
  approveFixtureRoot(process.cwd());
  try { return await fn(); } finally { restoreFixtureRoot(); process.chdir(previousCwd); }
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

async function makeLane(registry, title = 'Journal') {
  const { lease } = registry.createToolLease({ role: 'orchestrator', actor: 'test' });
  const orchestrator = await registry.registerOrchestrator({ cwd: process.cwd(), actor: 'test', title: 'Journals' }, { leaseId: lease.id });
  const created = registry.createLane(orchestrator.id, { title, executorType: 'mock' }, { actor: 'test', approved: true });
  return { orchestrator, lane: registry.getLane(created.id) };
}

async function persisted(registry) {
  registry._flushPersistTimer();
  await registry.drainPendingWrites();
  return JSON.parse(await fs.readFile(registry.stateFile, 'utf8'));
}

test('journal: rotation past the cap moves old segments to the archive and loses nothing', async () => {
  await withTempDir('orca-journal-unit-', async (dir) => {
    await withEnv({ ORCA_LANE_JOURNAL_SEGMENT_BYTES: '1500', ORCA_LANE_JOURNAL_HOT_SEGMENTS: '2' }, async () => {
      const stateDir = path.join(dir, '.orca');
      for (let index = 0; index < 200; index += 1) {
        appendJournalEntries(stateDir, 'lane-1', 'logs', [{ at: 't', message: `m${index} ${'z'.repeat(40)}` }]);
      }
      appendJournalEntries(stateDir, 'lane-1', 'agentEvents', [{ id: 'e1', type: 'agent.done' }]);

      const all = readJournalAll(stateDir, 'lane-1', 'logs');
      assert.equal(all.length, 200);
      assert.deepEqual(all.map((entry) => entry.message.split(' ')[0]), Array.from({ length: 200 }, (_, index) => `m${index}`));
      const hot = fsSync.readdirSync(laneJournalDir(stateDir, 'lane-1')).filter((name) => /^logs\.\d{6}\.jsonl$/.test(name));
      assert.ok(hot.length <= 1, `at most one rotated segment stays hot, found ${hot.length}`);
      const archived = fsSync.readdirSync(laneArchivedSegmentsDir(stateDir, 'lane-1'));
      assert.ok(archived.length >= 5, `older segments move to the archive, found ${archived.length}`);

      assert.deepEqual(readJournalTail(stateDir, 'lane-1', 'logs', 30).map((entry) => entry.message.split(' ')[0]),
        Array.from({ length: 30 }, (_, index) => `m${170 + index}`));
      assert.equal(readJournalTail(stateDir, 'lane-1', 'logs', 500).length, 200, 'a long tail reads back into archived segments');
      assert.deepEqual(readJournalAll(stateDir, 'lane-1', 'agentEvents'), [{ id: 'e1', type: 'agent.done' }]);
    });
  });
});

test('journal: a torn last line costs only itself', async () => {
  await withTempDir('orca-journal-torn-', async (dir) => {
    const stateDir = path.join(dir, '.orca');
    await fs.mkdir(laneJournalDir(stateDir, 'lane-t'), { recursive: true });
    await fs.writeFile(path.join(laneJournalDir(stateDir, 'lane-t'), 'logs.jsonl'), '{"a":1}\n{"b":');
    appendJournalEntries(stateDir, 'lane-t', 'logs', [{ c: 3 }]);
    assert.deepEqual(readJournalAll(stateDir, 'lane-t', 'logs'), [{ a: 1 }, { c: 3 }]);
    assert.deepEqual(readJournalTail(stateDir, 'lane-t', 'logs', 5), [{ a: 1 }, { c: 3 }]);
  });
});

test('journal: an unsafe lane id becomes one hashed path segment', () => {
  assert.equal(laneKey('2f1c7a4e-8d0b-4b6e-9a51-3b2f5c6d7e8f'), '2f1c7a4e-8d0b-4b6e-9a51-3b2f5c6d7e8f');
  assert.match(laneKey('../../etc'), /^h-[0-9a-f]{32}$/);
  assert.match(laneKey(''), /^h-[0-9a-f]{32}$/);
  const stateDir = path.join(os.tmpdir(), 'orca-state');
  assert.equal(path.dirname(laneJournalDir(stateDir, '../x')), path.join(stateDir, 'lanes'));
});

test('state.json keeps lane streams out; the journal holds them; counts stay', async () => {
  await withTempDir('orca-journal-state-', (dir) => inDir(dir, async () => {
    const registry = openRegistry();
    try {
      const { lane } = await makeLane(registry);
      for (let index = 0; index < 30; index += 1) registry.appendLaneLog(lane, `log ${index}`);
      for (let index = 0; index < 25; index += 1) registry.appendLaneAgentEvent(lane, { type: 'command.output', content: `event ${index}` });
      const saved = await persisted(registry);
      const savedLane = saved.lanes.find((entry) => entry.id === lane.id);
      assert.equal(saved.version, 4);
      assert.equal('logs' in savedLane, false);
      assert.equal('agentEvents' in savedLane, false);
      assert.equal(savedLane.logCount, lane.logs.length);
      assert.equal(savedLane.agentEventCount, lane.agentEvents.length);
      assert.deepEqual(readJournalAll(registry.storageDir, lane.id, 'logs'), roundTrip(lane.logs));
      assert.deepEqual(readJournalAll(registry.storageDir, lane.id, 'agentEvents'), roundTrip(lane.agentEvents));
    } finally {
      await closeRegistry(registry);
    }
  }));
});

test('after a restart lane.get and lane.list show exactly what they showed before, and appends do not duplicate', async () => {
  await withTempDir('orca-journal-restart-', (dir) => inDir(dir, async () => {
    const first = openRegistry();
    let before;
    let compactBefore;
    let laneId;
    let orchestratorId;
    try {
      const { orchestrator, lane } = await makeLane(first);
      laneId = lane.id;
      orchestratorId = orchestrator.id;
      for (let index = 0; index < 30; index += 1) first.appendLaneLog(lane, `log ${index}`);
      for (let index = 0; index < 50; index += 1) first.appendLaneAgentEvent(lane, { type: 'command.output', content: `event-${index}` });
      first.markLaneCompleted(lane);
      await first.drainPendingWrites();
      before = roundTrip(first.laneForRead(lane));
      compactBefore = roundTrip(first.listLanesCompact(orchestrator.id).find((entry) => entry.id === lane.id));
    } finally {
      await closeRegistry(first);
    }

    const second = openRegistry();
    try {
      const restored = second.getLane(laneId);
      assert.equal(Array.isArray(restored.logs), false, 'a restored lane does not load its streams at boot');
      const view = second.laneForRead(restored);
      assert.deepEqual(view.logs, before.logs);
      assert.deepEqual(view.agentEvents, before.agentEvents);
      assert.equal(Array.isArray(restored.logs), false, 'reading does not keep the streams in memory');

      const compact = second.listLanesCompact(orchestratorId).find((entry) => entry.id === laneId);
      assert.deepEqual(compact.agentEvents, compactBefore.agentEvents);
      assert.equal(compact.agentEvents.length, 20);
      assert.equal(compact.agentEventCount, compactBefore.agentEventCount);
      assert.equal(compact.logCount, compactBefore.logCount);

      second.appendLaneLog(restored, 'after restart');
      assert.deepEqual(roundTrip(restored.logs.slice(0, -1)), before.logs, 'an append loads the journal first');
      await persisted(second);
      const journal = readJournalAll(second.storageDir, laneId, 'logs');
      assert.equal(journal.length, before.logs.length + 1, 'loaded entries are not appended twice');
      assert.equal(journal.at(-1).message, 'after restart');
    } finally {
      await closeRegistry(second);
    }
  }));
});

test('the lane.get view keeps its 2000-line cap; the journal keeps every line', async () => {
  await withTempDir('orca-journal-cap-', (dir) => inDir(dir, async () => {
    const first = openRegistry();
    let laneId;
    try {
      const { lane } = await makeLane(first);
      laneId = lane.id;
      for (let index = 0; index < 2100; index += 1) first.appendLaneLog(lane, `line ${index}`);
      assert.equal(lane.logs.length, 2000);
      await persisted(first);
      const journal = readJournalAll(first.storageDir, laneId, 'logs');
      assert.equal(journal.length, 2101, 'the queued line plus all 2100 appended lines');
      assert.equal(journal[1].message, 'line 0');
    } finally {
      await closeRegistry(first);
    }
    const second = openRegistry();
    try {
      const view = second.laneForRead(second.getLane(laneId));
      assert.equal(view.logs.length, 2000);
      assert.equal(view.logs.at(-1).message, 'line 2099');
      assert.equal(view.logs[0].message, 'line 100');
    } finally {
      await closeRegistry(second);
    }
  }));
});

test('a v3 state with inline streams is journaled on the first persist, and nothing is lost', async () => {
  await withTempDir('orca-journal-v3-', (dir) => inDir(dir, async () => {
    const now = new Date().toISOString();
    await fs.mkdir(path.join(dir, '.orca'), { recursive: true });
    await fs.writeFile(path.join(dir, '.orca', 'state.json'), JSON.stringify({
      version: 3, projects: [], orchestrators: [], auditEvents: [], toolLeases: [], agentQueue: [], policies: {},
      lanes: [{
        id: 'lane-v3', sessionId: 'orc_gone', title: 'old', state: 'done', executorType: 'mock', workdir: dir, createdAt: now,
        logs: [{ at: now, message: 'one' }, { at: now, message: 'two' }, { at: now, message: 'three' }],
        agentEvents: [{ id: 'a', at: now, type: 'agent.done', content: 'done' }, { id: 'b', at: now, type: 'agent.note', content: 'note' }],
      }],
    }));
    const registry = openRegistry();
    try {
      const saved = await persisted(registry);
      assert.equal(saved.version, 4);
      const savedLane = saved.lanes.find((entry) => entry.id === 'lane-v3');
      assert.equal('logs' in savedLane, false);
      assert.deepEqual(readJournalAll(registry.storageDir, 'lane-v3', 'logs').map((entry) => entry.message).slice(0, 3), ['one', 'two', 'three']);
      assert.deepEqual(readJournalAll(registry.storageDir, 'lane-v3', 'agentEvents').map((entry) => entry.id), ['a', 'b']);
    } finally {
      await closeRegistry(registry);
    }
  }));
});

test('a lane whose journal cannot be written keeps its streams inline in state.json until it can', async () => {
  await withTempDir('orca-journal-fail-', (dir) => inDir(dir, async () => {
    const registry = openRegistry();
    const originalError = console.error;
    console.error = () => {};
    try {
      // A regular file where the journal directory must go: every append fails.
      await fs.mkdir(registry.storageDir, { recursive: true });
      const blocker = path.join(registry.storageDir, 'lanes');
      await fs.writeFile(blocker, 'not a directory');
      const { lane } = await makeLane(registry);
      registry.appendLaneLog(lane, 'kept inline');
      let saved = await persisted(registry);
      let savedLane = saved.lanes.find((entry) => entry.id === lane.id);
      assert.deepEqual(savedLane.logs, roundTrip(lane.logs), 'streams stay inline while the journal is unwritable');

      await fs.unlink(blocker);
      registry.appendLaneLog(lane, 'journal works again');
      saved = await persisted(registry);
      savedLane = saved.lanes.find((entry) => entry.id === lane.id);
      assert.equal('logs' in savedLane, false);
      assert.deepEqual(readJournalAll(registry.storageDir, lane.id, 'logs').map((entry) => entry.message),
        lane.logs.map((entry) => entry.message));
    } finally {
      console.error = originalError;
      await closeRegistry(registry);
    }
  }));
});

test('HTTP lane.get, lane.list and terminal-tail still answer from a restarted daemon', async () => {
  await withTempDir('orca-journal-http-', (dir) => inDir(dir, async () => {
    const first = openRegistry();
    let laneId;
    let orchestratorId;
    let before;
    try {
      const { orchestrator, lane } = await makeLane(first, 'Over HTTP');
      laneId = lane.id;
      orchestratorId = orchestrator.id;
      for (let index = 0; index < 40; index += 1) first.appendLaneAgentEvent(lane, { type: 'command.output', content: `event-${index}` });
      first.markLaneCompleted(lane);
      await first.drainPendingWrites();
      before = roundTrip(first.laneForRead(lane));
    } finally {
      await closeRegistry(first);
    }

    await withEnv({ PORT: '0' }, async () => {
      const token = process.env.ORCA_API_TOKEN;
      delete process.env.ORCA_API_TOKEN;
      const moduleUrl = `${pathToFileURL(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'server.js')).href}?lane-journal=${Date.now()}`;
      const { routeRequest, stopServer } = await import(moduleUrl);
      const get = async (url) => {
        const chunks = [];
        const res = { statusCode: 200, headers: {}, setHeader(name, value) { this.headers[name.toLowerCase()] = value; }, end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); } };
        const req = new PassThrough();
        req.method = 'GET';
        req.url = url;
        req.headers = { host: '127.0.0.1' };
        req.socket = { remoteAddress: '127.0.0.1' };
        const handled = routeRequest(req, res);
        req.end();
        await handled;
        return { status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') };
      };
      try {
        const full = await get(`/api/lanes/${laneId}`);
        assert.equal(full.status, 200);
        assert.deepEqual(full.body.logs, before.logs);
        assert.deepEqual(full.body.agentEvents, before.agentEvents);

        const list = await get(`/api/orchestrators/${orchestratorId}/lanes`);
        assert.equal(list.status, 200);
        const compact = list.body.find((entry) => entry.id === laneId);
        assert.deepEqual(compact.agentEvents, before.agentEvents.slice(-20));
        assert.equal(compact.agentEventCount, before.agentEvents.length);
        assert.equal(compact.logCount, before.logs.length);

        const tail = await get(`/api/lanes/${laneId}/terminal-tail`);
        assert.equal(tail.status, 200);
        assert.equal(tail.body.laneId, laneId);
      } finally {
        await stopServer();
        if (token !== undefined) process.env.ORCA_API_TOKEN = token;
      }
    });
  }));
});
