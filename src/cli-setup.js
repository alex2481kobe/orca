// `orca-cli.js setup`: the one command a new workstation runs.
//
// It records the fence (the directories agents may work in) in the user's Orca
// config file, never in the repo, keeps an existing install's state where it
// is, starts the daemon, and can connect agent CLIs in the same step. Run again
// to change the roots: it rewrites the config and, if Orca is already running,
// says how to restart it. It never restarts a running daemon itself, because
// stopping Orca stops its executors.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { inspectInstanceLock } from './instance-lock.js';
import {
  ORCA_DIR,
  STATE_SOURCE_LABELS,
  hasLegacyState,
  legacyStateDir,
  readConfig,
  resolveStateDir,
  writeConfig,
} from './orca-paths.js';
import { parseRootList, validateRoots } from './fence.js';
import { fixCommands } from './mcp-connection.js';
import { tokenAdvice } from './cli-lifecycle.js';

function covers(root, target) {
  const withSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return target === root || target.startsWith(withSep);
}

export async function setup(flags, out, { start, connect }) {
  const env = process.env;
  const home = os.homedir();
  const rawRoots = parseRootList(flags.roots ?? []);
  if (!rawRoots.length) {
    out.err([
      'setup needs the directories agents may work in, as absolute paths:',
      `  ${fixCommands.setup()}`,
      `List each project root. Include Orca's own checkout (${ORCA_DIR}) if agents should work on Orca itself.`,
    ].join('\n'));
    return 2;
  }
  const { roots, errors, homeWideRoots } = validateRoots(rawRoots);
  if (errors.length) {
    out.err(`Nothing was saved: ${errors.join('; ')}. Each root must be an absolute path to an existing directory.`);
    return 2;
  }
  if (homeWideRoots.length && !flags['allow-home-root']) {
    out.err([
      `Nothing was saved: ${homeWideRoots.join(', ')} covers your whole home directory, so agents could register and work in any folder you own.`,
      'Name your project directories instead. If you do mean the whole home directory, re-run with --allow-home-root to record that decision; Orca keeps warning about it.',
    ].join('\n'));
    return 2;
  }

  let stateDir = null;
  if (flags['state-dir'] !== undefined) {
    const value = String(flags['state-dir']).trim();
    if (!path.isAbsolute(value)) {
      out.err(`--state-dir must be an absolute path, not "${value}".`);
      return 2;
    }
    stateDir = path.resolve(value);
    if (fs.existsSync(stateDir) && !fs.statSync(stateDir).isDirectory()) {
      out.err(`--state-dir ${stateDir} is not a directory.`);
      return 2;
    }
  }
  const current = readConfig({ env, home });
  if (!stateDir && typeof current.config?.stateDir === 'string' && current.config.stateDir.trim()) stateDir = current.config.stateDir;
  // An install from before the per-user default keeps its state where it is:
  // recorded explicitly, never moved, never copied.
  let keptExisting = false;
  if (!stateDir && hasLegacyState()) {
    stateDir = legacyStateDir();
    keptExisting = true;
  }

  const now = new Date().toISOString();
  const config = {
    roots,
    ...(homeWideRoots.length ? { homeRootAcknowledgedAt: now } : {}),
    ...(stateDir ? { stateDir } : {}),
    updatedAt: now,
  };
  const file = writeConfig(config, { env, home });
  const state = resolveStateDir({ env: { ...env, ORCA_STATE_DIR: '' }, home, config });

  out.log(`Saved ${file}${current.error ? ` (it replaced one that could not be read: ${current.error})` : ''}.`);
  out.log(`  roots  ${roots.join(', ')}`);
  if (homeWideRoots.length) {
    out.log(`  WARNING: ${homeWideRoots.join(', ')} covers your whole home directory. Recorded as deliberate (${now}); Orca warns about it wherever it reports the fence.`);
  }
  out.log(`  state  ${state.dir} (${keptExisting ? 'your existing state, kept where it is: nothing was moved or copied' : STATE_SOURCE_LABELS[state.source]})`);
  if (env.ORCA_STATE_DIR) {
    out.log(`  Note: ORCA_STATE_DIR is set in this environment (${env.ORCA_STATE_DIR}) and overrides this for any Orca started with it.`);
  }
  const orcaReal = fs.realpathSync(ORCA_DIR);
  if (!roots.some((root) => covers(root, orcaReal))) {
    out.log(`  Orca's own checkout (${orcaReal}) is not under these roots, so agents cannot orchestrate work on Orca itself. To allow it, add it to --roots.`);
  }
  if (env.ORCA_REPO_ROOTS !== undefined) {
    out.log('  Note: ORCA_REPO_ROOTS is set in this environment and overrides the saved roots for any Orca started with it, including one started from this shell. Unset it to use the saved roots.');
  }
  const advice = tokenAdvice(env);
  if (advice) out.log(advice);

  const effectiveState = resolveStateDir({ env, home, config });
  let owner = null;
  try { owner = inspectInstanceLock(effectiveState.dir); } catch { owner = null; }
  if (owner?.held && owner.reason === 'running') {
    out.log(`Orca is already running (pid ${owner.holder.pid}) with the fence it started with. The saved roots apply when it next starts. When no executors are running: ${fixCommands.stop()} && ${fixCommands.start()}`);
  } else if (flags['no-start']) {
    out.log(`Not started (--no-start). Start it with: ${fixCommands.start()}`);
  } else {
    const code = await start(flags, out);
    if (code !== 0) return code;
  }

  const clients = parseRootList(flags.connect ?? []);
  for (const client of clients) {
    const code = await connect(client);
    if (code !== 0) return code;
  }
  if (!clients.length) {
    out.log(`Next, register Orca with your agent CLI, once: ${fixCommands.connect('claude')}   (or connect codex)`);
  }
  return 0;
}
