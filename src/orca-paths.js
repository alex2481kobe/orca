// Where Orca keeps its configuration and its state: one resolver, so the daemon,
// the CLI and the service definition always agree, and none of them depends on
// the directory a command happened to run in.
//
//   config  ORCA_CONFIG_DIR > $XDG_CONFIG_HOME/orca > ~/.config/orca
//           One file, config.json, written only by `orca-cli.js setup`.
//   state   ORCA_STATE_DIR
//           > "stateDir" in config.json
//           > <checkout>/.orca, when it already holds a state.json (an install
//             from before this resolver: its state stays where it is, and is
//             never moved or copied)
//           > $XDG_STATE_HOME/orca > ~/.local/state/orca (new installs)
//
// A state directory named `.orca` has the original layout, with its artifacts
// beside it in `<parent>/artifacts`. Any other state directory keeps its
// artifacts inside, in `<stateDir>/artifacts`. Daemon logs live in
// `<stateDir>/logs/daemon.log`.
//
// Nothing in this module reads the current working directory.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ORCA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SERVER_PATH = path.join(ORCA_DIR, 'src', 'server.js');
export const CONFIG_SCHEMA = 'orca.config.v1';
export const CONFIG_FILE = 'config.json';

function absoluteSetting(name, value) {
  const text = String(value).trim();
  if (!path.isAbsolute(text)) {
    throw new Error(`${name} must be an absolute path, but it is "${text}".`);
  }
  return path.resolve(text);
}

// XDG base directories: a relative value is invalid and ignored, per the spec.
function xdgDir(env, name, fallback) {
  const value = String(env[name] || '').trim();
  return value && path.isAbsolute(value) ? path.join(value, 'orca') : fallback;
}

export function resolveConfigDir({ env = process.env, home = os.homedir() } = {}) {
  if (String(env.ORCA_CONFIG_DIR || '').trim()) return absoluteSetting('ORCA_CONFIG_DIR', env.ORCA_CONFIG_DIR);
  return xdgDir(env, 'XDG_CONFIG_HOME', path.join(home, '.config', 'orca'));
}

export function resolveConfigPath(options = {}) {
  return path.join(resolveConfigDir(options), CONFIG_FILE);
}

// -> { path, config, error }. A missing file is not an error: it is an install
// that has not run setup. An unreadable or malformed one is.
export function readConfig(options = {}) {
  const file = resolveConfigPath(options);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { path: file, config: null, error: null };
    return { path: file, config: null, error: `${file} cannot be read: ${error.message}` };
  }
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('it is not a JSON object');
    return { path: file, config: value, error: null };
  } catch (error) {
    return { path: file, config: null, error: `${file} is not a valid Orca config: ${error.message}` };
  }
}

// Owner-only: the directory 0700, the file 0600, replaced atomically.
export function writeConfig(config, options = {}) {
  const dir = resolveConfigDir(options);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, CONFIG_FILE);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ schema: CONFIG_SCHEMA, ...config }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
  return file;
}

export function legacyStateDir(orcaDir = ORCA_DIR) {
  return path.join(orcaDir, '.orca');
}

export function hasLegacyState(orcaDir = ORCA_DIR) {
  return fs.existsSync(path.join(legacyStateDir(orcaDir), 'state.json'));
}

export function defaultStateDir({ env = process.env, home = os.homedir() } = {}) {
  return xdgDir(env, 'XDG_STATE_HOME', path.join(home, '.local', 'state', 'orca'));
}

// -> { dir, source }, source one of ORCA_STATE_DIR | config | legacy-checkout |
// default. Throws when an explicit setting is not an absolute path. `config` is
// the parsed config (null for none); omitted, it is read from the config dir.
export function resolveStateDir({ env = process.env, home = os.homedir(), config, orcaDir = ORCA_DIR } = {}) {
  if (String(env.ORCA_STATE_DIR || '').trim()) {
    return { dir: absoluteSetting('ORCA_STATE_DIR', env.ORCA_STATE_DIR), source: 'ORCA_STATE_DIR' };
  }
  const settings = config === undefined ? readConfig({ env, home }).config : config;
  if (settings && typeof settings.stateDir === 'string' && settings.stateDir.trim()) {
    return { dir: absoluteSetting('"stateDir" in the Orca config', settings.stateDir), source: 'config' };
  }
  if (hasLegacyState(orcaDir)) return { dir: legacyStateDir(orcaDir), source: 'legacy-checkout' };
  return { dir: defaultStateDir({ env, home }), source: 'default' };
}

export const STATE_SOURCE_LABELS = {
  ORCA_STATE_DIR: 'from ORCA_STATE_DIR',
  config: 'from the Orca config file',
  'legacy-checkout': "the checkout's existing .orca, kept in place",
  default: 'the per-user default',
};

export function artifactDirFor(stateDir) {
  return path.basename(stateDir) === '.orca'
    ? path.join(path.dirname(stateDir), 'artifacts')
    : path.join(stateDir, 'artifacts');
}

export function daemonLogPath(stateDir) {
  return path.join(stateDir, 'logs', 'daemon.log');
}
