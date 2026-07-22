// Verify the lightweight-list + on-demand-detail architecture:
//   - listLanesCompact (GET /api/sessions/:id/lanes) drops `logs` and caps
//     agentEvents to a 20-tail, but reports the true agentEventCount/logCount.
//   - getLane (GET /api/lanes/:id) still returns the FULL transcript.
// This is what lets the client poll cheaply and fetch full detail only for the
// lane it's actually showing.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-lane-arch-'));
const realTmp = await fs.realpath(tmp);
process.chdir(realTmp);
process.env.ORCA_CREDENTIAL_BACKEND = 'memory';
// registerOrchestrator validates cwd against the approved repo roots; point them
// at the isolated temp dir so process.cwd() is an approved root.
process.env.ORCA_REPO_ROOTS = realTmp;
const { OrcaRegistry } = await import('../src/registry.js');
const reg = new OrcaRegistry({ autoCompleteMs: 60 * 60 * 1000 });

// v2: the orchestrator RECORD is the lane container (no session records). Mint an
// orchestrator lease, register by cwd (implicitly creating the project), then
// create the lane under the orchestrator id.
const { lease } = reg.createToolLease({ role: 'orchestrator', actor: 'test' });
const orchestrator = await reg.registerOrchestrator(
  { cwd: realTmp, actor: 'test', title: 'Arch Session' },
  { leaseId: lease.id },
);
const created = reg.createLane(orchestrator.id, { title: 'Arch Lane', executorType: 'mock' }, { actor: 'test', approved: true });
const lane = reg.lanes.find((l) => l.id === created.id); // LIVE lane (createLane returns a clone)

// Append 50 agentEvents + 30 logs onto the live lane.
for (let i = 0; i < 50; i += 1) {
  reg.appendLaneAgentEvent(lane, { type: 'output', content: `event-${i}`, at: new Date(Date.now() + i).toISOString() }, { persist: false });
}
for (let i = 0; i < 30; i += 1) reg.appendLaneLog(lane, `log-${i}`);

const compact = reg.listLanesCompact(orchestrator.id);
const c = compact.find((l) => l.id === lane.id);
const full = reg.getLane(lane.id);

const result = {
  compact_hasNoLogs: !('logs' in c) || (Array.isArray(c.logs) && c.logs.length === 0),
  compact_agentEventsTail: Array.isArray(c.agentEvents) ? c.agentEvents.length : -1, // expect 20
  compact_agentEventCount: c.agentEventCount, // expect 50
  compact_logCount: c.logCount, // expect 30
  compact_tailIsNewest: c.agentEvents[c.agentEvents.length - 1]?.content === 'event-49',
  full_agentEvents: Array.isArray(full.agentEvents) ? full.agentEvents.length : -1, // expect 50
  full_logs: Array.isArray(full.logs) ? full.logs.length : -1, // expect 30
};
result.pass = result.compact_hasNoLogs
  && result.compact_agentEventsTail === 20                       // list capped to a tail
  && result.full_agentEvents > 20                                // ...of a much larger transcript
  && result.compact_agentEventCount === result.full_agentEvents  // true count reported in the list
  && result.compact_logCount === result.full_logs               // true log count reported (logs themselves dropped)
  && result.compact_tailIsNewest                                 // the tail is the NEWEST events
  && result.full_logs > 0;                                       // detail still carries full logs

console.log('[verify] lane-detail-arch:', JSON.stringify(result, null, 2));
assert.ok(result.pass, 'lane detail architecture contract failed');
