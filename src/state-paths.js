// The LAYOUT of Orca's state directory: every path the daemon, the migration and
// `orca gc` use is derived here from one state directory, so changing the layout
// changes all of them together.
//
// WHICH directory that is, is not decided here. src/orca-paths.js is the single
// resolver (ORCA_STATE_DIR > the Orca config file > an existing checkout .orca >
// the per-user default), and the daemon, the CLI and `gc` all call it.

import { createHash } from 'node:crypto';
import path from 'node:path';

// v4: lane logs and agent events live in per-lane journal files, not in
// state.json, and audit evidence references lanes instead of embedding them.
export const STATE_FORMAT_VERSION = 4;

export function statePaths(stateDir) {
  const archiveDir = path.join(stateDir, 'archive');
  return {
    stateDir,
    stateFile: path.join(stateDir, 'state.json'),
    lanesDir: path.join(stateDir, 'lanes'),
    archiveDir,
    archivedLanesDir: path.join(archiveDir, 'lanes'),
    // Where a lane's artifacts go when the lane is archived. Same archive/, same
    // "moved, never deleted" rule, same purge — see RETENTION in state-gc.js.
    archivedArtifactsDir: path.join(archiveDir, 'artifacts'),
    migrationsDir: path.join(archiveDir, 'migrations'),
    legacyDir: path.join(archiveDir, 'legacy'),
    workspacesDir: path.join(stateDir, 'workspaces'),
  };
}

// A lane id as a single safe path segment. Orca's own ids (UUIDs) pass through
// unchanged; anything else (a hand-edited or tampered state file) is hashed, so
// an id can never climb out of the directory it names.
export function laneKey(laneId) {
  const id = String(laneId ?? '');
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) && id !== '.' && id !== '..') return id;
  return `h-${createHash('sha256').update(id).digest('hex').slice(0, 32)}`;
}

export function laneJournalDir(stateDir, laneId) {
  return path.join(statePaths(stateDir).lanesDir, laneKey(laneId));
}

export function laneArchivedSegmentsDir(stateDir, laneId) {
  return path.join(statePaths(stateDir).archivedLanesDir, laneKey(laneId));
}
