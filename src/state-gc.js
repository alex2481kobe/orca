// `orca gc`: what in the state directory may leave hot state, when, and why.
//
// RETENTION below is the one retention table: every file and folder the state
// directory can hold, who writes it, and when it becomes safe to delete.
// docs/state-retention.md renders the same table, and a test keeps the two in
// step. planGc() reads the state directory and decides; applyGc() carries out
// exactly that plan, in an order where a crash at any point loses nothing.
//
// gc MOVES things into archive/ and never deletes them. The one exception is the
// archive purge, which needs its own flag AND an age threshold.

import fs from 'node:fs';
import path from 'node:path';
import { readJsonSync, writeJsonFileAtomicSync } from './state-store/io.js';
import { STATE_FORMAT_VERSION, laneKey, statePaths } from './state-paths.js';
import { removeJournalFiles } from './lane-journal.js';
import {
  ARCHIVED_ARTIFACTS_MARKER,
  archiveLaneArtifacts,
  archivedLaneIndexEntry,
  archiveOrphanJournal,
  hotLaneArtifactDir,
  listLaneArchives,
  writeLaneArchive,
} from './lane-archive.js';
import { readJournalAll } from './lane-journal.js';

export const TERMINAL_LANE_STATES = Object.freeze(['done', 'failed', 'stopped', 'accepted', 'blocked', 'archived']);
export const DEFAULT_LANE_ARCHIVE_AGE_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
// A temp file younger than this may belong to a write in progress.
const STALE_TEMP_MS = 60 * 60 * 1000;
// Audit states that still need someone to act on the lane.
const PENDING_AUDIT_STATES = ['queued', 'auditing', 'escalated'];
// Dropped into an archived artifacts folder so the purge has an age to work from
// and can find the lane the folder belongs to before deleting anything.
export { ARCHIVED_ARTIFACTS_MARKER };
// A lane's result.txt is the ONLY complete copy of a long agent report (the lane
// record's resultText is capped). It is moved with everything else, and when a
// purge finally does delete a folder it is unlinked LAST, so a purge that dies
// half way through has still not destroyed the report.
const LANE_RESULT_FILE = 'result.txt';

// path: relative to the state directory. `gc`: what `orca gc` does with it.
export const RETENTION = Object.freeze([
  {
    path: 'state.json',
    what: 'Hot registry state: projects, orchestrators, lane records (without their logs or agent events), the last 200 audit events (lane evidence by reference), tool leases (tokens stored hashed), the agent wake-up queue, and the index of archived lanes.',
    writer: 'The daemon (debounced atomic write); `orca gc --apply` while it holds the instance lock.',
    safeToDelete: 'Never. It is the registry.',
    gc: 'Rewritten without the lanes it archives.',
  },
  {
    path: 'state.json.bak',
    what: 'Copy of state.json taken after a write (at most once a minute, and on shutdown). Read only when state.json is missing or unparsable.',
    writer: 'The daemon.',
    safeToDelete: 'While the daemon is stopped and state.json parses; the next write recreates it.',
    gc: 'Left alone.',
  },
  {
    path: 'state.json.<pid>.<time>.<uuid>.tmp',
    what: 'Temp file of an atomic write. A running daemon renames it within milliseconds; one that remains is a write that crashed.',
    writer: 'The daemon.',
    safeToDelete: 'When no daemon is running.',
    gc: 'Moved to archive/legacy/ once it is over an hour old.',
  },
  {
    path: 'state.json.v1.bak, state.json.v2.bak',
    what: 'The pre-migration state kept by the v1 -> v3 and v2 -> v3 migrations.',
    writer: 'The daemon, once, at that migration.',
    safeToDelete: 'Once the migrated state has been checked.',
    gc: 'Moved to archive/legacy/.',
  },
  {
    path: '<store>.json.corrupt.<time>.<pid>.<id>',
    what: 'An unparsable state file, quarantined by recovery before it fell back to the backup.',
    writer: 'The daemon, on a failed read.',
    safeToDelete: 'Once inspected.',
    gc: 'Moved to archive/legacy/.',
  },
  {
    path: 'daemon.lock, daemon.lock.takeover',
    what: 'The instance lock (src/instance-lock.js): which process owns this state directory.',
    writer: 'The daemon; `orca gc --apply` for its duration.',
    safeToDelete: 'Never by hand while its owner runs. A lock whose owner has provably exited is taken over automatically.',
    gc: 'Left alone; `--apply` refuses while another process holds it.',
  },
  {
    path: 'auth-sessions.json (+ .bak)',
    what: 'Paired browser and phone sessions.',
    writer: 'The daemon (auth store).',
    safeToDelete: 'Only to unpair every device.',
    gc: 'Left alone.',
  },
  {
    path: 'private-access.json (+ .bak)',
    what: 'Tailscale Serve settings and their audit trail.',
    writer: 'The daemon (private-access store).',
    safeToDelete: 'Only to forget the private-access settings.',
    gc: 'Left alone.',
  },
  {
    path: 'lanes/<lane>/logs.jsonl, events.jsonl, *.NNNNNN.jsonl',
    what: 'The journal of a lane that is still in state.json: every log line and agent event, one JSON object per line, rotated at 8 MiB with at most 4 segments per stream kept here.',
    writer: 'The daemon (appends only).',
    safeToDelete: 'Never while its lane is in state.json. A directory whose lane is not in state.json is an orphan.',
    gc: 'Archived with its lane; an orphan directory is archived on its own.',
  },
  {
    path: 'archive/lanes/<lane>/lane-<time>.json.gz',
    what: 'A retired lane: its full record and EVERY log line and agent event, gzip-compressed and verified on write. lane.get still serves it.',
    writer: 'The daemon (lane.delete, the terminal-lane cap) and `orca gc --apply`.',
    safeToDelete: 'When you no longer need that lane\'s history.',
    gc: 'Purged only by `--purge-archive --purge-older-than-days N --apply`.',
  },
  {
    path: 'archive/lanes/<lane>/logs.NNNNNN.jsonl, events.NNNNNN.jsonl',
    what: 'Journal segments rotated out of a lane that is still hot.',
    writer: 'The daemon.',
    safeToDelete: 'Never while the lane is hot: they are the oldest part of its journal.',
    gc: 'Folded into the lane\'s .json.gz when the lane is archived.',
  },
  {
    path: 'archive/migrations/<time>-v3-to-v4-<sha>/',
    what: 'The state.json (and state.json.bak) a v4 daemon found at its first boot, kept byte for byte, plus manifest.json with sizes, sha256 and what was converted.',
    writer: 'The daemon at its first v4 boot, or `orca gc --apply` on a v3 state.',
    safeToDelete: 'Once the migrated state has been checked.',
    gc: 'Purged only by `--purge-archive --purge-older-than-days N --apply`.',
  },
  {
    path: 'archive/legacy/<time>/',
    what: 'Legacy backups, crashed-write temp files and quarantined corrupt files moved here by gc.',
    writer: '`orca gc --apply`.',
    safeToDelete: 'Once inspected.',
    gc: 'Purged only by `--purge-archive --purge-older-than-days N --apply`.',
  },
  {
    path: 'archive/artifacts/<orchestrator>/<lane>/',
    what: 'The artifacts of an archived lane, moved here whole: result.txt (the complete captured report, the only copy — lane.resultText is capped), outcome.txt, transcript.json, terminal.log, stdout.log, stderr.log, mcp-tools.json and screenshots, plus a .orca-archived.json marker recording when and from which lane.',
    writer: '`orca gc --apply`, when it archives the lane.',
    safeToDelete: 'Once the lane archive it belongs to is no longer needed. Its raw output is not readable through the API from here.',
    gc: 'Purged only by `--purge-archive --purge-older-than-days N --apply`, and only once the lane\'s own archive goes in the same run; result.txt is deleted last.',
  },
  {
    path: 'workspaces/<orchestrator>/worktrees/<lane>',
    what: 'The git worktree of an isolated lane.',
    writer: 'The daemon, when it creates an isolated lane.',
    safeToDelete: 'After the lane is integrated, or its work is deliberately discarded.',
    gc: 'LISTED, never removed. Remove one with lane__worktree__discard (it refuses uncommitted work unless force:true).',
  },
]);

// Outside the state directory. gc does not sweep this tree on its own — it never
// walks artifacts/ looking for things to tidy — but a lane's folder is no longer
// stranded here: it moves into archive/ with the lane, under the same rules.
export const OUTSIDE_STATE_DIR = Object.freeze([
  {
    path: '<daemon cwd>/artifacts/<orchestrator>/<lane>/',
    what: 'Per-lane artifacts: outcome.txt, result.txt (the complete captured report for that lane, whole even when lane.resultText was capped), transcript.json, terminal.log, stdout.log, stderr.log, mcp-tools.json, and captured screenshots. lane.terminal.tail, the live lane stream, lane.artifacts.list and lane.artifacts.get read them.',
    writer: 'The daemon and the executors it runs.',
    safeToDelete: 'When the lane\'s raw output and evidence are no longer needed. The lane record and its logs do not depend on them.',
    gc: 'Size reported. When the lane is archived, its folder is MOVED to archive/artifacts/<orchestrator>/<lane>/; a hot lane\'s artifacts are never touched.',
  },
]);

const cell = (value) => String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ');

// The retention table as Markdown. docs/state-retention.md embeds exactly this
// between its retention-table markers; test/state-gc.test.js checks it.
export function renderRetentionMarkdown() {
  const header = [
    '| path | what it is | who writes it | safe to delete when | what `orca gc` does |',
    '| --- | --- | --- | --- | --- |',
  ];
  const row = (entry) => `| \`${cell(entry.path)}\` | ${cell(entry.what)} | ${cell(entry.writer)} | ${cell(entry.safeToDelete)} | ${cell(entry.gc)} |`;
  return [
    'Under the state directory:',
    '',
    ...header,
    ...RETENTION.map(row),
    '',
    'Outside the state directory (gc does not sweep it; it follows the lane it belongs to):',
    '',
    ...header,
    ...OUTSIDE_STATE_DIR.map(row),
    '',
  ].join('\n');
}

function dirBytes(target) {
  let total = 0;
  let stat;
  try { stat = fs.lstatSync(target); } catch { return 0; }
  if (!stat.isDirectory()) return stat.size;
  let names;
  try { names = fs.readdirSync(target); } catch { return 0; }
  for (const name of names) total += dirBytes(path.join(target, name));
  return total;
}

function ageDaysOf(isoOrMs, now) {
  const ms = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs || '');
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return (now - ms) / DAY_MS;
}

const roundDays = (days) => Math.floor(days * 10) / 10;

function holdsIsolatedWorktree(lane) {
  const worktree = lane?.worktreePath ? String(lane.worktreePath) : '';
  if (!worktree) return false;
  if (lane.repoRoot && path.resolve(worktree) === path.resolve(lane.repoRoot)) return false;
  return true;
}

function legacyReason(name) {
  if (/^state\.json\.v[12]\.bak$/.test(name)) return 'a backup kept by an old (v1/v2 -> v3) migration';
  if (/\.json\.corrupt\./.test(name)) return 'an unparsable state file quarantined by recovery';
  if (/\.json\.\d+\.\d+\.[0-9a-f-]{36}\.tmp$/.test(name)) return 'the temp file of a write that crashed';
  return null;
}

// Decide. Reads the state directory; writes nothing.
export function planGc({
  stateDir,
  now = Date.now(),
  olderThanDays = DEFAULT_LANE_ARCHIVE_AGE_DAYS,
  purgeArchive = false,
  purgeOlderThanDays = null,
  artifactsDir = null,
} = {}) {
  const paths = statePaths(stateDir);
  const plan = {
    stateDir,
    generatedAt: new Date(now).toISOString(),
    olderThanDays,
    purgeOlderThanDays: purgeArchive ? purgeOlderThanDays : null,
    // Recorded so a re-plan (after a migration) decides artifacts the same way
    // the first plan would have, instead of silently leaving them behind.
    artifactsDir: artifactsDir || null,
    blocked: null,
    state: null,
    actions: [],
    sizes: {},
  };
  const add = (action) => plan.actions.push(action);

  let state = null;
  try {
    state = readJsonSync(paths.stateFile);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      plan.blocked = `state.json cannot be read (${error.message}). Start the daemon once so recovery can restore it from the backup, then run gc again.`;
    }
  }
  plan.state = state ? { version: state.version ?? null, lanes: Array.isArray(state.lanes) ? state.lanes.length : 0 } : null;

  if (state && state.version !== STATE_FORMAT_VERSION) {
    add({
      kind: 'migrate-state',
      from: state.version ?? null,
      to: STATE_FORMAT_VERSION,
      reason: `state.json is format v${state.version}: lane logs and agent events are inline and audit events embed whole lanes. Converting moves them out; the original is kept byte for byte under archive/migrations/.`,
    });
  }

  // A v3 state is converted first; its lanes are planned against the result
  // (--apply re-plans after migrating).
  const migrating = plan.actions.some((action) => action.kind === 'migrate-state');
  const lanes = migrating ? [] : (Array.isArray(state?.lanes) ? state.lanes : []);
  if (migrating) plan.note = 'Lane retention is decided after the migration; --apply migrates, then plans and applies it.';
  if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
    plan.blocked = plan.blocked || '--older-than-days must be a number of days, 0 or more.';
  }
  for (const lane of lanes) {
    if (!lane || typeof lane !== 'object' || !lane.id) continue;
    const terminal = TERMINAL_LANE_STATES.includes(lane.state);
    const age = ageDaysOf(lane.completedAt || lane.updatedAt || lane.createdAt, now);
    const label = { laneId: lane.id, title: lane.title || null, state: lane.state || null };

    if (holdsIsolatedWorktree(lane) && (terminal || lane.integratedAt)) {
      const exists = fs.existsSync(lane.worktreePath);
      add({
        kind: 'list-worktree',
        ...label,
        worktreePath: lane.worktreePath,
        exists,
        reason: lane.integratedAt
          ? `merged at ${lane.integratedAt}; its worktree is no longer needed.`
          : `the lane is ${lane.state} and its worktree was never integrated.`,
        hint: lane.integratedAt
          ? `lane__worktree__discard {"laneId":"${lane.id}"}`
          : `lane__integrate {"laneId":"${lane.id}"} to keep the work, or lane__worktree__discard {"laneId":"${lane.id}","force":true} to drop it`,
      });
    }

    if (!terminal || age === null || age < olderThanDays) continue;
    let skip = null;
    if (PENDING_AUDIT_STATES.includes(lane.auditState)) skip = `its audit is still ${lane.auditState}`;
    else if (holdsIsolatedWorktree(lane) && !lane.integratedAt) skip = 'it still holds an un-integrated worktree (integrate or discard it first)';
    else if (Array.isArray(lane.logs) || Array.isArray(lane.agentEvents)) skip = 'its logs are still inline in state.json (start the daemon once so it journals them)';
    if (skip) {
      add({ kind: 'keep-lane', ...label, ageDays: roundDays(age), reason: `terminal and ${roundDays(age)} days old, but ${skip}.` });
      continue;
    }
    add({
      kind: 'archive-lane',
      ...label,
      ageDays: roundDays(age),
      reason: `terminal (${lane.state}) and unchanged for ${roundDays(age)} days (threshold ${olderThanDays}).`,
    });

    // Artifacts follow the lane. gc used to report this folder's size and manage
    // nothing in it, which is how 808 MB of per-lane stdout.log / terminal.log /
    // transcript.json accumulated against a 1.2 GB state directory. It is MOVED,
    // like everything else gc touches, and only the explicit purge deletes it.
    const artifactDir = laneArtifactDir(artifactsDir, lane);
    if (artifactDir && fs.existsSync(artifactDir)) {
      add({
        kind: 'archive-artifacts',
        ...label,
        sessionId: lane.sessionId || 'orphan',
        from: artifactDir,
        bytes: dirBytes(artifactDir),
        hasResult: fs.existsSync(path.join(artifactDir, LANE_RESULT_FILE)),
        reason: 'its lane is being archived; artifacts move with it into archive/artifacts/ (nothing is deleted).',
      });
    }
  }

  // Journals no lane in state.json points at.
  const hotKeys = new Set(lanes.filter((lane) => lane?.id).map((lane) => laneKey(lane.id)));
  let journalKeys = [];
  try { journalKeys = fs.readdirSync(paths.lanesDir); } catch { /* none yet */ }
  for (const key of journalKeys) {
    if (hotKeys.has(key)) continue;
    if (!fs.statSync(path.join(paths.lanesDir, key)).isDirectory()) continue;
    add({
      kind: 'archive-orphan-journal',
      key,
      bytes: dirBytes(path.join(paths.lanesDir, key)),
      reason: 'no lane in state.json points at this journal (its record was dropped by an older daemon).',
    });
  }

  // Worktree folders no lane points at.
  const referenced = new Set(lanes.filter((lane) => lane?.worktreePath).map((lane) => path.resolve(String(lane.worktreePath))));
  let orchestratorDirs = [];
  try { orchestratorDirs = fs.readdirSync(paths.workspacesDir); } catch { /* none */ }
  for (const orchestratorDir of orchestratorDirs) {
    const worktreesDir = path.join(paths.workspacesDir, orchestratorDir, 'worktrees');
    let names = [];
    try { names = fs.readdirSync(worktreesDir); } catch { continue; }
    for (const name of names) {
      const full = path.join(worktreesDir, name);
      if (referenced.has(path.resolve(full))) continue;
      add({
        kind: 'list-orphan-worktree',
        worktreePath: full,
        reason: 'no lane in state.json points at this worktree folder. Check `git worktree list` in its repository before removing it by hand.',
      });
    }
  }

  // Legacy backups, crashed temp files, quarantined corrupt files.
  let rootNames = [];
  try { rootNames = fs.readdirSync(stateDir); } catch { /* no state dir */ }
  for (const name of rootNames) {
    const reason = legacyReason(name);
    if (!reason) continue;
    const full = path.join(stateDir, name);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (!stat.isFile()) continue;
    if (/\.tmp$/.test(name) && now - stat.mtimeMs < STALE_TEMP_MS) continue;
    add({ kind: 'move-legacy', file: name, bytes: stat.size, reason });
  }

  if (purgeArchive) {
    if (!Number.isFinite(purgeOlderThanDays) || purgeOlderThanDays <= 0) {
      plan.blocked = plan.blocked || '--purge-archive needs --purge-older-than-days N (N > 0): purging deletes, so the age threshold is never implied.';
    } else {
      for (const archive of listLaneArchives(stateDir)) {
        const age = ageDaysOf(archive.archivedAt, now);
        if (age === null || age < purgeOlderThanDays) continue;
        add({ kind: 'purge', target: path.relative(stateDir, archive.file), bytes: archive.bytes, ageDays: roundDays(age), reason: `lane archive older than ${purgeOlderThanDays} days.` });
      }
      for (const entry of listArchivedArtifacts(stateDir)) {
        const age = ageDaysOf(entry.archivedAt, now);
        if (age === null || age < purgeOlderThanDays) continue;
        add({
          kind: 'purge-artifacts',
          target: path.relative(stateDir, entry.dir),
          laneId: entry.laneId,
          sessionId: entry.sessionId,
          bytes: entry.bytes,
          ageDays: roundDays(age),
          hasResult: entry.hasResult,
          reason: `archived artifacts older than ${purgeOlderThanDays} days${entry.hasResult ? ', INCLUDING result.txt — the only complete copy of that lane\'s report' : ''}.`,
        });
      }
      for (const [dir, label] of [[paths.migrationsDir, 'migration archive'], [paths.legacyDir, 'legacy files']]) {
        let names = [];
        try { names = fs.readdirSync(dir); } catch { continue; }
        for (const name of names) {
          const full = path.join(dir, name);
          let when = null;
          try { when = JSON.parse(fs.readFileSync(path.join(full, 'manifest.json'), 'utf8')).movedAt || null; } catch { /* fall back to mtime */ }
          const age = ageDaysOf(when || fs.statSync(full).mtimeMs, now);
          if (age === null || age < purgeOlderThanDays) continue;
          add({ kind: 'purge', target: path.relative(stateDir, full), bytes: dirBytes(full), ageDays: roundDays(age), reason: `${label} older than ${purgeOlderThanDays} days.` });
        }
      }
    }
  }

  plan.sizes = {
    stateJson: dirBytes(paths.stateFile),
    stateJsonBak: dirBytes(`${paths.stateFile}.bak`),
    lanes: dirBytes(paths.lanesDir),
    archive: dirBytes(paths.archiveDir),
    ...(artifactsDir ? { artifactsOutsideStateDir: dirBytes(artifactsDir) } : {}),
  };
  return plan;
}

// The hot artifacts folder of one lane. Shared with the daemon (lane-archive.js)
// so `orca gc` and runtime retirement can never disagree about where a lane's
// artifacts live or where they go.
function laneArtifactDir(artifactsDir, lane) {
  if (!lane?.id) return null;
  return hotLaneArtifactDir(artifactsDir, { sessionId: lane.sessionId, laneId: lane.id });
}

// Every archived artifacts folder, with the marker gc wrote when it moved it.
// A folder with no readable marker still lists (with a null age) so it can never
// become invisible; it simply never satisfies an age threshold.
function listArchivedArtifacts(stateDir) {
  const paths = statePaths(stateDir);
  const out = [];
  let sessions = [];
  try { sessions = fs.readdirSync(paths.archivedArtifactsDir); } catch { return out; }
  for (const session of sessions) {
    const sessionDir = path.join(paths.archivedArtifactsDir, session);
    let lanes = [];
    try { lanes = fs.readdirSync(sessionDir); } catch { continue; }
    for (const laneId of lanes) {
      const dir = path.join(sessionDir, laneId);
      try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
      let marker = null;
      try { marker = JSON.parse(fs.readFileSync(path.join(dir, ARCHIVED_ARTIFACTS_MARKER), 'utf8')); } catch { /* unmarked */ }
      out.push({
        dir,
        sessionId: session,
        laneId: marker?.laneId || laneId,
        archivedAt: marker?.archivedAt || null,
        hasResult: fs.existsSync(path.join(dir, LANE_RESULT_FILE)),
        bytes: dirBytes(dir),
      });
    }
  }
  return out;
}

function moveInto(dir, source) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, path.basename(source));
  fs.renameSync(source, target);
  return target;
}

// Carry out a plan made by planGc. The caller holds the instance lock. Order:
// 1. write and verify every lane archive (journals untouched),
// 2. rewrite state.json without those lanes,
// 3. only then remove their journals;
// then orphan journals, legacy files and — only when planned — the purge.
export function applyGc(plan, { now = Date.now(), migrate = null } = {}) {
  if (plan.blocked) throw new Error(plan.blocked);
  const { stateDir } = plan;
  const paths = statePaths(stateDir);
  const results = [];
  const stamp = new Date(now).toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const archivedAt = new Date(now).toISOString();

  if (plan.actions.some((action) => action.kind === 'migrate-state')) {
    if (typeof migrate !== 'function') throw new Error('This state needs migrating first and no migration is available.');
    results.push({ kind: 'migrate-state', ...migrate({ stateDir, now }) });
    // A migration changes the lanes; decide again on the migrated state.
    const replanned = planGc({ stateDir, now, olderThanDays: plan.olderThanDays, purgeArchive: plan.purgeOlderThanDays !== null, purgeOlderThanDays: plan.purgeOlderThanDays, artifactsDir: plan.artifactsDir });
    return [...results, ...applyGc(replanned, { now })];
  }

  const laneIds = new Set(plan.actions.filter((action) => action.kind === 'archive-lane').map((action) => action.laneId));
  if (laneIds.size) {
    const state = readJsonSync(paths.stateFile);
    const retiring = state.lanes.filter((lane) => laneIds.has(lane.id));
    const entries = [];
    for (const lane of retiring) {
      const info = writeLaneArchive(stateDir, {
        laneId: lane.id,
        lane,
        logs: readJournalAll(stateDir, lane.id, 'logs'),
        agentEvents: readJournalAll(stateDir, lane.id, 'agentEvents'),
        reason: `gc: ${plan.actions.find((action) => action.laneId === lane.id && action.kind === 'archive-lane').reason}`,
        archivedAt,
      });
      entries.push(archivedLaneIndexEntry(lane, info));
      results.push({ kind: 'archive-lane', laneId: lane.id, file: info.relativeFile, bytes: info.bytes, logs: info.logCount, agentEvents: info.agentEventCount });
    }
    const next = {
      ...state,
      savedAt: new Date(now).toISOString(),
      lanes: state.lanes.filter((lane) => !laneIds.has(lane.id)),
      archivedLanes: [...(Array.isArray(state.archivedLanes) ? state.archivedLanes : []), ...entries],
    };
    writeJsonFileAtomicSync(paths.stateFile, next, { forceBackup: true });
    for (const lane of retiring) removeJournalFiles(stateDir, lane.id);
  }

  // Artifacts move in the same place in the order the journals are removed: only
  // once the lane's archive has been written, verified and committed to
  // state.json. A move is a rename, so nothing is destroyed even if this dies.
  for (const action of plan.actions.filter((item) => item.kind === 'archive-artifacts')) {
    const moved = archiveLaneArtifacts(stateDir, {
      from: action.from,
      sessionId: action.sessionId,
      laneId: action.laneId,
      reason: action.reason,
      archivedAt,
    });
    if (!moved.moved) {
      // A folder that could not be moved is REPORTED, not skipped in silence —
      // the same contract keep-lane keeps for a lane gc leaves alone.
      if (moved.reason !== 'the lane has no artifacts folder') {
        results.push({ kind: 'keep-artifacts', laneId: action.laneId, bytes: action.bytes, reason: moved.reason });
      }
      continue;
    }
    results.push({
      kind: 'archive-artifacts',
      laneId: action.laneId,
      to: moved.relativeTo,
      bytes: moved.bytes,
      ...(moved.parked ? {} : { hasResult: moved.hasResult }),
    });
  }

  for (const action of plan.actions.filter((item) => item.kind === 'archive-orphan-journal')) {
    const info = archiveOrphanJournal(stateDir, action.key, { archivedAt });
    results.push({ kind: 'archive-orphan-journal', key: action.key, file: info.relativeFile, bytes: info.bytes });
  }

  const legacy = plan.actions.filter((item) => item.kind === 'move-legacy');
  if (legacy.length) {
    const dir = path.join(paths.legacyDir, stamp);
    for (const action of legacy) {
      const target = moveInto(dir, path.join(stateDir, action.file));
      results.push({ kind: 'move-legacy', file: action.file, to: path.relative(stateDir, target) });
    }
    fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify({ movedAt: new Date(now).toISOString(), files: legacy.map((action) => ({ file: action.file, bytes: action.bytes, reason: action.reason })) }, null, 2)}\n`, { mode: 0o600 });
  }

  const purges = plan.actions.filter((item) => item.kind === 'purge');
  if (purges.length || plan.actions.some((item) => item.kind === 'purge-artifacts')) {
    const purged = new Set();
    for (const action of purges) {
      const target = path.join(stateDir, action.target);
      // Purge never reaches outside archive/.
      if (!path.resolve(target).startsWith(`${path.resolve(paths.archiveDir)}${path.sep}`)) continue;
      fs.rmSync(target, { recursive: true, force: true });
      purged.add(action.target);
      results.push({ kind: 'purge', target: action.target, bytes: action.bytes });
    }
    // Archived artifacts are deleted only AFTER the lane archives above, and only
    // when this run is taking the lane's own archive too. result.txt is the only
    // complete copy of that lane's report; while the lane archive it belongs to
    // is still on disk, deleting it would orphan the record's pointer to it. So
    // the artifacts refuse to go first, and say so.
    const survivingLaneArchive = (laneId) => {
      const dir = path.join(paths.archivedLanesDir, laneKey(laneId));
      try { return fs.readdirSync(dir).some((name) => name.endsWith('.json.gz')); } catch { return false; }
    };
    for (const action of plan.actions.filter((item) => item.kind === 'purge-artifacts')) {
      const target = path.join(stateDir, action.target);
      if (!path.resolve(target).startsWith(`${path.resolve(paths.archiveDir)}${path.sep}`)) continue;
      if (survivingLaneArchive(action.laneId)) {
        results.push({
          kind: 'keep-artifacts',
          laneId: action.laneId,
          target: action.target,
          reason: `its lane archive is still on disk, so result.txt stays with it: purge the lane archive too (it is younger than the threshold) before these artifacts can go.`,
        });
        continue;
      }
      // Everything else first, result.txt last, THEN the folder. A purge
      // interrupted half way has still not destroyed the complete report.
      let names = [];
      try { names = fs.readdirSync(target); } catch { continue; }
      for (const name of names) {
        if (name === LANE_RESULT_FILE) continue;
        fs.rmSync(path.join(target, name), { recursive: true, force: true });
      }
      fs.rmSync(path.join(target, LANE_RESULT_FILE), { force: true });
      fs.rmSync(target, { recursive: true, force: true });
      results.push({ kind: 'purge-artifacts', laneId: action.laneId, target: action.target, bytes: action.bytes });
    }

    // Drop index entries whose archive is gone, so lane.get says so plainly.
    let state = null;
    try { state = readJsonSync(paths.stateFile); } catch { /* no state */ }
    if (state && Array.isArray(state.archivedLanes)) {
      const kept = state.archivedLanes.filter((entry) => !purged.has(entry.file));
      if (kept.length !== state.archivedLanes.length) {
        writeJsonFileAtomicSync(paths.stateFile, { ...state, savedAt: new Date(now).toISOString(), archivedLanes: kept }, { forceBackup: true });
      }
    }
  }
  return results;
}

const kb = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil((bytes || 0) / 1024)} KB`);

export function formatGcPlan(plan, { apply = false, results = null } = {}) {
  const out = [];
  out.push(`Orca gc ${apply ? '(APPLY)' : '(dry run: nothing is changed; add --apply to move what is listed)'}`);
  out.push(`  state directory: ${plan.stateDir}`);
  out.push(`  state.json ${kb(plan.sizes.stateJson)} · state.json.bak ${kb(plan.sizes.stateJsonBak)} · lanes/ ${kb(plan.sizes.lanes)} · archive/ ${kb(plan.sizes.archive)}${plan.sizes.artifactsOutsideStateDir !== undefined ? ` · artifacts/ (outside the state dir, not managed) ${kb(plan.sizes.artifactsOutsideStateDir)}` : ''}`);
  if (plan.blocked) out.push(`  BLOCKED: ${plan.blocked}`);
  if (plan.note) out.push(`  note: ${plan.note}`);
  const verb = apply ? '' : 'would ';
  const lines = {
    'migrate-state': (a) => `${verb}migrate state.json v${a.from} -> v${a.to}: ${a.reason}`,
    'archive-lane': (a) => `${verb}archive lane ${a.laneId} "${a.title || ''}": ${a.reason}`,
    'keep-lane': (a) => `keep lane ${a.laneId} "${a.title || ''}": ${a.reason}`,
    'archive-orphan-journal': (a) => `${verb}archive orphan journal lanes/${a.key} (${kb(a.bytes)}): ${a.reason}`,
    'move-legacy': (a) => `${verb}move ${a.file} (${kb(a.bytes)}) to archive/legacy/: ${a.reason}`,
    'list-worktree': (a) => `stale worktree ${a.worktreePath}${a.exists ? '' : ' (already gone from disk)'} of lane ${a.laneId}: ${a.reason} -> ${a.hint}`,
    'list-orphan-worktree': (a) => `unreferenced worktree folder ${a.worktreePath}: ${a.reason}`,
    'archive-artifacts': (a) => `${verb}move artifacts of lane ${a.laneId} (${kb(a.bytes)}${a.hasResult ? ', includes result.txt' : ''}) to archive/artifacts/: ${a.reason}`,
    'purge-artifacts': (a) => `${apply ? 'DELETE' : 'would DELETE'} ${a.target} (${kb(a.bytes)}, ${a.ageDays} days old): ${a.reason}`,
    purge: (a) => `${apply ? 'DELETE' : 'would DELETE'} ${a.target} (${kb(a.bytes)}, ${a.ageDays} days old): ${a.reason}`,
  };
  if (!plan.actions.length) out.push('  nothing to do.');
  for (const action of plan.actions) out.push(`  - ${(lines[action.kind] || ((a) => JSON.stringify(a)))(action)}`);
  if (results) {
    // What a RUN declined to do, and why. The plan above already names what gc
    // is leaving alone (keep-lane, list-worktree, list-orphan-worktree); this is
    // the same contract for the apply phase, where a move or a purge can still
    // refuse after the plan was made. Without it "done: N change(s)" is the only
    // thing a person sees, and N being smaller than the plan says nothing.
    const declined = results.filter((item) => String(item.kind || '').startsWith('keep-'));
    out.push(`  done: ${results.length - declined.length} change(s) made.`);
    for (const item of declined) {
      out.push(`  - NOT done: ${item.kind === 'keep-artifacts' ? `artifacts of lane ${item.laneId}` : item.kind} left in place: ${item.reason}`);
    }
  }
  return out.join('\n');
}
