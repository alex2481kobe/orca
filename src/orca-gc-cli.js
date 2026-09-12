// `orca gc`: the command line for state retention (src/state-gc.js).
//
//   gc [--apply] [--older-than-days N] [--purge-archive --purge-older-than-days N]
//      [--state-dir DIR] [--json]
//
// A dry run by default: prints what would move and why, and changes nothing.
// --apply MOVES what the plan lists into archive/ inside the state directory and
// never deletes. Deleting from the archive needs --purge-archive AND
// --purge-older-than-days N; no age is ever implied.
//
// A dry run is safe beside a running daemon (it reads the last state the daemon
// persisted). --apply refuses while any process owns the state directory, and
// holds the instance lock (src/instance-lock.js) itself while it works, so no
// daemon can start and read state halfway through.

import fs from 'node:fs';
import path from 'node:path';
import { acquireInstanceLock, inspectInstanceLock } from './instance-lock.js';
import { artifactDirFor, resolveStateDir } from './orca-paths.js';
import { applyGc, DEFAULT_LANE_ARCHIVE_AGE_DAYS, formatGcPlan, planGc } from './state-gc.js';
import { migrateStateDir } from './state-migrate.js';

export const GC_USAGE = 'gc [--apply] [--older-than-days N] [--purge-archive --purge-older-than-days N] [--state-dir DIR] [--json]';
export const GC_BOOLEAN_FLAGS = ['apply', 'purge-archive'];

function days(flags, name, fallback) {
  if (flags[name] === undefined) return fallback;
  const value = Number(flags[name]);
  return Number.isFinite(value) && value >= 0 ? value : NaN;
}

function holderText(holder) {
  if (!holder) return 'owner unknown';
  const listen = holder.listen?.port ? `, listening on http://${holder.listen.host}:${holder.listen.port}` : '';
  return `pid ${holder.pid}${listen}`;
}

// Returns the exit code: 0 done, 1 refused or failed, 2 bad usage.
export async function runGcCommand(flags, {
  stdout = process.stdout,
  stderr = process.stderr,
  now = Date.now(),
  migrate = migrateStateDir,
  cwd = process.cwd(),
} = {}) {
  const usageError = (message) => {
    stderr.write(`${message}\nUsage: orca ${GC_USAGE}\n`);
    return 2;
  };
  const olderThanDays = days(flags, 'older-than-days', DEFAULT_LANE_ARCHIVE_AGE_DAYS);
  const purgeArchive = flags['purge-archive'] === true;
  const purgeOlderThanDays = days(flags, 'purge-older-than-days', null);
  if (Number.isNaN(olderThanDays)) return usageError('--older-than-days needs a number of days (0 or more).');
  if (Number.isNaN(purgeOlderThanDays)) return usageError('--purge-older-than-days needs a number of days.');
  if (purgeOlderThanDays !== null && !purgeArchive) return usageError('--purge-older-than-days only applies with --purge-archive.');
  if (flags['state-dir'] === true || flags['state-dir'] === '') return usageError('--state-dir needs a directory.');

  // The same directory `orca start`, `stop`, `status` and `doctor` act on
  // (src/orca-paths.js), so gc never collects a state dir the daemon does not
  // use. --state-dir still overrides it, resolved against the caller's cwd.
  const stateDir = flags['state-dir']
    ? path.resolve(cwd, flags['state-dir'])
    : resolveStateDir().dir;
  const apply = flags.apply === true;
  const json = flags.json === true;
  const artifactsDir = artifactDirFor(stateDir);
  const options = {
    stateDir,
    now,
    olderThanDays,
    purgeArchive,
    purgeOlderThanDays,
    artifactsDir: fs.existsSync(artifactsDir) ? artifactsDir : null,
  };
  const emit = (payload, text) => stdout.write(`${json ? JSON.stringify(payload, null, 2) : text}\n`);

  if (!fs.existsSync(stateDir)) {
    emit({ ok: true, apply, stateDir, plan: null, results: [], note: 'no state directory' }, `No state directory at ${stateDir}; nothing to do.`);
    return 0;
  }

  const owner = inspectInstanceLock(stateDir);
  if (!apply) {
    const plan = planGc(options);
    const note = owner.held
      ? `Note: a daemon owns this state directory (${holderText(owner.holder)}). This plan reads the last state it persisted; --apply refuses until it stops.`
      : null;
    emit({ ok: !plan.blocked, apply: false, stateDir, daemon: owner.held ? { pid: owner.holder?.pid ?? null } : null, plan }, [formatGcPlan(plan), note].filter(Boolean).join('\n'));
    return plan.blocked ? 1 : 0;
  }

  const lock = acquireInstanceLock(stateDir);
  if (!lock.acquired) {
    stderr.write([
      `Refusing to apply: another process owns ${stateDir} (${lock.reason}; ${holderText(lock.holder)}).`,
      'Stop the Orca daemon that uses this state directory, then run this again. Nothing was changed.',
    ].join('\n') + '\n');
    return 1;
  }
  try {
    // Plan again under the lock: the state may have changed since any dry run.
    const plan = planGc(options);
    if (plan.blocked) {
      emit({ ok: false, apply: true, stateDir, plan, results: [] }, formatGcPlan(plan, { apply: true }));
      return 1;
    }
    const results = applyGc(plan, { now, migrate });
    emit({ ok: true, apply: true, stateDir, plan, results }, formatGcPlan(plan, { apply: true, results }));
    return 0;
  } catch (error) {
    stderr.write(`gc --apply stopped: ${error?.message || error}\nWhat it had already moved is in ${path.join(stateDir, 'archive')}; run a dry run to see what remains.\n`);
    return 1;
  } finally {
    lock.release();
  }
}
