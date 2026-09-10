// Proof, on a SYNTHETIC state shaped like the one measured in
// docs/audits/2026-09-10-state-bloat-diagnosis.md, that the v3 -> v4 migration
// and `orca gc` shrink hot state without losing a single log line or event.
//
//   node scripts/state-lifecycle-proof.mjs [--scale 1] [--dir DIR]
//
// --scale 1 generates the measured shape at full size (~525 MB of state.json,
// plus a byte-identical state.json.bak): 82 terminal lanes (58 done, 7 accepted,
// 5 stopped, 12 failed) spanning 2026-07-26 -> 2026-09-01 carrying 143.9 MB of
// logs and 55.1 MB of agent events, and 200 audit events of which 84 embed a
// whole lane (300 MB), 14 of them lanes whose record was already dropped.
// Text is pseudo-random words and ids, so compression figures are indicative
// only. Everything happens in a fresh temp directory; nothing else is touched.
//
// Phases: generate -> first v4 boot (migration) -> gc --apply -> archive purge
// (simulated 31 days later). Prints sizes per phase and the entry-count check.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : fallback; };
const scale = Number(flag('scale', '1'));
const root = flag('dir', fs.mkdtempSync(path.join(os.tmpdir(), 'orca-state-proof-')));
const stateDir = path.join(root, '.orca');
fs.mkdirSync(stateDir, { recursive: true });

// ---- deterministic pseudo-random text -------------------------------------
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const VOCAB = (() => {
  const r = rng(7);
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  return Array.from({ length: 4000 }, () => Array.from({ length: 3 + Math.floor(r() * 8) }, () => letters[Math.floor(r() * 26)]).join(''));
})();
function text(r, bytes) {
  let out = '';
  while (out.length < bytes) {
    const pick = r();
    out += pick < 0.08 ? `${Math.floor(r() * 0xffffffff).toString(16)} ` : pick < 0.12 ? `src/${VOCAB[Math.floor(r() * VOCAB.length)]}.js:${Math.floor(r() * 900)} ` : `${VOCAB[Math.floor(r() * VOCAB.length)]} `;
  }
  return out.slice(0, bytes);
}
const hashId = (r) => Array.from({ length: 4 }, () => Math.floor(r() * 0xffffffff).toString(16).padStart(8, '0')).join('-');

// ---- the synthetic model ----------------------------------------------------
const MB = 1024 * 1024;
const LANES = 82;
const STATES = [...Array(58).fill('done'), ...Array(7).fill('accepted'), ...Array(5).fill('stopped'), ...Array(12).fill('failed')];
const START = Date.parse('2026-07-26T09:00:00Z');
const END = Date.parse('2026-09-01T18:00:00Z');
const laneIdOf = (index) => `lane-${String(index).padStart(4, '0')}-${(index * 2654435761 >>> 0).toString(16)}`;
// Per-lane weight so sizes vary (a few very chatty lanes, many quiet ones).
const weight = (index) => 0.25 + ((index * 7919) % 97) / 30;
const totalWeight = Array.from({ length: LANES }, (_, index) => weight(index)).reduce((a, b) => a + b, 0);

function buildLane(index, { dropped = false } = {}) {
  const r = rng(1000 + index);
  const id = dropped ? `dropped-${index}` : laneIdOf(index);
  const completed = START + ((END - START) * index) / LANES;
  const share = weight(index % LANES) / totalWeight;
  const logBytes = Math.min(143.9 * MB * scale * share, 2000 * 12000);
  const logCount = Math.min(2000, Math.max(20, Math.round(logBytes / 900)));
  const eventBytes = Math.min(55.1 * MB * scale * share, 3000 * 12000);
  const eventCount = Math.min(3000, Math.max(10, Math.round(eventBytes / 700)));
  const at = (offset) => new Date(completed - 3600_000 + offset).toISOString();
  return {
    id,
    projectId: 'prj_synthetic',
    sessionId: `orc_${index % 10}`,
    orchestratorId: `orc_${index % 10}`,
    title: `Synthetic lane ${index}: ${text(r, 40)}`,
    state: STATES[index % STATES.length],
    auditState: 'accepted',
    executorType: index % 3 ? 'claude' : 'codex',
    taskPrompt: text(r, 2400),
    resultText: text(r, 3600),
    processMeta: { pid: 40000 + index, exitCode: 0, startedAt: at(0), endedAt: at(3000_000), command: text(r, 1200) },
    createdAt: at(-60_000),
    updatedAt: new Date(completed).toISOString(),
    completedAt: new Date(completed).toISOString(),
    changedFiles: Array.from({ length: 6 }, () => `M src/${VOCAB[Math.floor(r() * VOCAB.length)]}.js`),
    logs: Array.from({ length: logCount }, (_, n) => ({ at: at(n * 1000), message: text(r, Math.max(20, Math.round(logBytes / logCount) - 60)) })),
    agentEvents: Array.from({ length: eventCount }, (_, n) => ({
      id: hashId(r), at: at(n * 900), source: 'claude', type: n % 5 ? 'command.output' : 'message.assistant.delta', title: '',
      content: text(r, Math.max(20, Math.round(eventBytes / eventCount) - 260)), stream: 'stdout', command: '', toolName: '', callId: '', externalSessionId: '', durationMs: null,
    })),
  };
}

// ---- generate (streamed, one lane in memory at a time) ----------------------
const t0 = Date.now();
const stateFile = path.join(stateDir, 'state.json');
const fd = fs.openSync(stateFile, 'w', 0o600);
const write = (chunk) => fs.writeSync(fd, chunk);
let generatedLogs = 0;
let generatedEvents = 0;
const evidenceLaneEntries = new Map();
write(`{"version":3,"savedAt":"2026-09-09T21:33:00.000Z","policies":{},`);
write(`"projects":${JSON.stringify([0, 1, 2].map((n) => ({ id: n ? `prj_${n}` : 'prj_synthetic', name: `Project ${n}`, slug: `project-${n}`, quickLinks: [] })))},`);
write(`"orchestrators":${JSON.stringify(Array.from({ length: 10 }, (_, n) => ({ id: `orc_${n}`, projectId: 'prj_synthetic', actor: `orch-${n}`, title: `Orchestrator ${n}`, registeredAt: new Date(START).toISOString(), lastSeenAt: new Date(END).toISOString(), resignedAt: new Date(END).toISOString() })))},`);
write('"lanes":[');
for (let index = 0; index < LANES; index += 1) {
  const lane = buildLane(index);
  generatedLogs += lane.logs.length;
  generatedEvents += lane.agentEvents.length;
  write(`${index ? ',' : ''}${JSON.stringify(lane)}`);
}
write('],"auditEvents":[');
// 200 events; 84 embed a whole lane: 70 hot lanes (the biggest first), 14 dropped.
const heavy = Array.from({ length: LANES }, (_, index) => index).sort((a, b) => weight(b) - weight(a)).slice(0, 70);
const perEvidenceScale = (300 * MB * scale) / 84;
for (let n = 0; n < 200; n += 1) {
  const base = { id: `evt-${n}`, createdAt: new Date(END - n * 3600_000).toISOString(), actor: 'scheduler', projectId: 'prj_synthetic', sessionId: `orc_${n % 10}`, status: 'passed', followUpQueued: false };
  let event;
  if (n < 70) {
    const lane = buildLane(heavy[n]);
    event = { ...base, type: 'lane_completed', laneId: lane.id, summary: `Lane ${lane.title} completed`, evidence: { lane } };
  } else if (n < 84) {
    const lane = buildLane(n, { dropped: true });
    // Dropped lanes are big: together the 84 embedded lanes weigh ~300 MB.
    const extra = Math.max(0, Math.round(perEvidenceScale * 2.2 - JSON.stringify(lane).length));
    if (extra > 0) {
      const r = rng(5000 + n);
      const pad = Math.min(3000 - lane.agentEvents.length, Math.ceil(extra / 11000));
      for (let k = 0; k < pad; k += 1) lane.agentEvents.push({ id: hashId(r), at: lane.updatedAt, source: 'codex', type: 'command.output', title: '', content: text(r, 10800) });
    }
    evidenceLaneEntries.set(lane.id, { logs: lane.logs.length, agentEvents: lane.agentEvents.length });
    event = { ...base, type: 'lane_stopped', laneId: lane.id, summary: `Lane ${lane.title} stopped`, evidence: { lane } };
  } else {
    event = { ...base, type: 'tool_lease_revoked', laneId: null, summary: 'Lease revoked', evidence: { leaseId: `lease-${n}`, reason: 'lane_completed' } };
  }
  write(`${n ? ',' : ''}${JSON.stringify(event)}`);
}
write('],');
const r0 = rng(99);
write(`"toolLeases":${JSON.stringify(Array.from({ length: 94 }, (_, n) => ({ id: `lease-${n}`, role: 'executor', actor: 'synthetic', tokenHash: hashId(r0).replace(/-/g, ''), allowedTools: ['lane.get'], createdAt: new Date(START).toISOString(), expiresAt: new Date(END).toISOString(), revokedAt: new Date(END).toISOString() })))},`);
write(`"agentQueue":${JSON.stringify(Array.from({ length: 90 }, (_, n) => ({ id: `q-${n}`, seq: n, type: 'lane_failed', targetRole: 'orchestrator', title: 'x', body: text(r0, 200), acks: {}, metadata: {} })))}}`);
write('\n');
fs.closeSync(fd);
fs.copyFileSync(stateFile, `${stateFile}.bak`, fs.constants.COPYFILE_FICLONE);
const generatedMs = Date.now() - t0;
// V8 cannot hold a string longer than 536,870,888 characters, and the daemon reads
// state.json as ONE string. Above that, boot would quarantine the file and start
// empty (see the report) instead of migrating it. Stay under it on purpose.
const generatedBytes = fs.statSync(stateFile).size;
if (generatedBytes > 530_000_000) {
  console.error(`Generated ${generatedBytes} bytes, too close to V8's string limit for this proof; lower --scale.`);
  process.exit(2);
}

// ---- measuring ---------------------------------------------------------------
function bytesOf(target) {
  let stat;
  try { stat = fs.lstatSync(target); } catch { return 0; }
  if (!stat.isDirectory()) return stat.size;
  return fs.readdirSync(target).reduce((sum, name) => sum + bytesOf(path.join(target, name)), 0);
}
const phases = [];
const measure = (phase, ms) => phases.push({
  phase,
  seconds: ms === null ? '' : (ms / 1000).toFixed(1),
  'state.json': bytesOf(stateFile),
  'state.json.bak': bytesOf(`${stateFile}.bak`),
  'lanes/ (journals)': bytesOf(path.join(stateDir, 'lanes')),
  'archive/': bytesOf(path.join(stateDir, 'archive')),
  'state dir total': bytesOf(stateDir),
});
measure('synthetic v3 state (generated)', generatedMs);

function child(code) {
  const started = Date.now();
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: root, encoding: 'utf8', env: { ...process.env, ORCA_AUTO_AUDIT: 'false', ORCA_SEED: 'false' }, maxBuffer: 64 * MB });
  if (result.status !== 0) { console.error(result.stdout, result.stderr); process.exit(1); }
  return { ms: Date.now() - started, out: result.stdout.trim() };
}

// First v4 boot: construct the registry exactly as the daemon does.
const boot = child(`
  const { OrcaRegistry } = await import(${JSON.stringify(path.join(ROOT, 'src', 'registry.js'))});
  const registry = new OrcaRegistry({ autoAudit: false });
  registry.stopScheduler();
  await registry.drainPendingWrites();
  const migrated = registry.auditEvents.find((event) => event.type === 'registry_state_migrated');
  console.log(JSON.stringify({ lanes: registry.lanes.length, archived: registry.archivedLanes.length, evidence: migrated?.evidence || null }));
`);
measure('after first v4 boot (migration)', boot.ms);
const bootInfo = JSON.parse(boot.out.split('\n').pop());

// gc --apply through the real CLI (every synthetic lane is > 7 days old).
const gcRun = child(`
  const { spawnSync } = await import('node:child_process');
  const run = spawnSync(process.execPath, [${JSON.stringify(path.join(ROOT, 'src', 'orca-cli.js'))}, 'gc', '--apply', '--older-than-days', '7', '--state-dir', ${JSON.stringify(stateDir)}, '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) { console.error(run.stderr); process.exit(1); }
  const parsed = JSON.parse(run.stdout);
  console.log(JSON.stringify({ archivedLanes: parsed.results.filter((r) => r.kind === 'archive-lane').length }));
`);
measure('after gc --apply --older-than-days 7', gcRun.ms);

// Count every entry now on disk: journals + lane archives.
const count = child(`
  const { listLaneArchives } = await import(${JSON.stringify(path.join(ROOT, 'src', 'lane-archive.js'))});
  const zlib = await import('node:zlib');
  const fs = await import('node:fs');
  let logs = 0; let events = 0; let evidenceOnly = 0; let evidenceLogs = 0; let evidenceEvents = 0;
  for (const archive of listLaneArchives(${JSON.stringify(stateDir)})) {
    const payload = JSON.parse(zlib.gunzipSync(fs.readFileSync(archive.file)).toString('utf8'));
    if (String(payload.reason).startsWith('recovered from audit evidence')) { evidenceOnly += 1; evidenceLogs += payload.logs.length; evidenceEvents += payload.agentEvents.length; }
    else { logs += payload.logs.length; events += payload.agentEvents.length; }
  }
  console.log(JSON.stringify({ logs, events, evidenceOnly, evidenceLogs, evidenceEvents }));
`);
const counted = JSON.parse(count.out);

// Purge, 31 days later, through the module (the CLI always uses the real clock).
const purge = child(`
  const { planGc, applyGc } = await import(${JSON.stringify(path.join(ROOT, 'src', 'state-gc.js'))});
  const later = Date.now() + 31 * 24 * 60 * 60 * 1000;
  const plan = planGc({ stateDir: ${JSON.stringify(stateDir)}, now: later, olderThanDays: 7, purgeArchive: true, purgeOlderThanDays: 30 });
  applyGc(plan, { now: later });
  console.log(JSON.stringify({ purged: plan.actions.filter((a) => a.kind === 'purge').length }));
`);
measure('after --purge-archive --purge-older-than-days 30 (31 days later)', purge.ms);

const expectedEvidenceLogs = [...evidenceLaneEntries.values()].reduce((sum, item) => sum + item.logs, 0);
const expectedEvidenceEvents = [...evidenceLaneEntries.values()].reduce((sum, item) => sum + item.agentEvents, 0);
const mb = (bytes) => (bytes / MB).toFixed(1);
console.log(`\nSynthetic state lifecycle proof (scale ${scale}) in ${root}\n`);
console.log(['phase', 'secs', 'state.json MB', '.bak MB', 'lanes/ MB', 'archive/ MB', 'total MB'].join(' | '));
for (const row of phases) console.log([row.phase, row.seconds, mb(row['state.json']), mb(row['state.json.bak']), mb(row['lanes/ (journals)']), mb(row['archive/']), mb(row['state dir total'])].join(' | '));
console.log(`\nboot: ${bootInfo.lanes} hot lanes, ${bootInfo.archived} evidence-only lanes archived; migration: ${JSON.stringify(bootInfo.evidence)}`);
console.log(`entries generated: ${generatedLogs} logs + ${generatedEvents} agent events in hot lanes, ${expectedEvidenceLogs} + ${expectedEvidenceEvents} in evidence-only lanes`);
console.log(`entries found after gc: ${counted.logs} logs + ${counted.events} agent events in lane archives; ${counted.evidenceOnly} evidence-only archives with ${counted.evidenceLogs} + ${counted.evidenceEvents}`);
const ok = counted.logs === generatedLogs && counted.events === generatedEvents && counted.evidenceLogs === expectedEvidenceLogs && counted.evidenceEvents === expectedEvidenceEvents;
console.log(ok ? 'NO ENTRY LOST.' : 'ENTRY COUNT MISMATCH.');
process.exitCode = ok ? 0 : 1;
