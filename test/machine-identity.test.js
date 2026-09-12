// A stable identity for this machine, and what happens when there isn't one.
//
// The property that matters is asymmetric: a FALSE MATCH is dangerous (it lets a
// local pid probe answer a question about another machine's daemon, and a wrong
// "the owner is gone" puts two daemons on one state directory), while a false
// mismatch only refuses a command. So the sources are ordered by how impossible
// they are to share, the file fallback is last, and total failure returns null
// rather than inventing something.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  MACHINE_ID_FILE,
  clearMachineIdentityCache,
  describeMachine,
  resolveMachineIdentity,
  shortMachineId,
} from '../src/machine-identity.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function tempDir(label) {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `orca-machine-${label}-`)));
}

test('ORCA_MACHINE_ID overrides every other source', () => {
  clearMachineIdentityCache();
  const identity = resolveMachineIdentity({ env: { ORCA_MACHINE_ID: '  pinned-id  ' }, cached: false });
  assert.deepEqual(identity, { id: 'pinned-id', source: 'ORCA_MACHINE_ID', error: null });
});

test('this machine has an identity, it is not the hostname, and it does not change between calls', () => {
  clearMachineIdentityCache();
  const first = resolveMachineIdentity({ env: {}, cached: false });
  const second = resolveMachineIdentity({ env: {}, cached: false });
  assert.equal(first.id, second.id, 'two independent resolutions agree');
  assert.notEqual(first.id, os.hostname(), 'and it is not the thing that changes with the network');
  if (process.platform === 'darwin') {
    assert.equal(first.source, 'platform-uuid', 'macOS uses the hardware UUID, which no rename can move');
    assert.ok(first.id, 'and it was readable');
  }
});

test('the file fallback writes one owner-only id under the CONFIG dir and reuses it', async () => {
  const configDir = await tempDir('file');
  try {
    // Force the fallback: a platform with no ioreg and (in this sandbox) no
    // /etc/machine-id is what the last resort exists for.
    const options = { env: {}, configDir, platform: 'sunos', cached: false };
    const first = resolveMachineIdentity(options);
    if (first.source !== 'orca-file') {
      // This host has /etc/machine-id, which legitimately wins over the file.
      assert.equal(first.source, 'machine-id-file');
      return;
    }
    const file = path.join(configDir, MACHINE_ID_FILE);
    assert.ok(fsSync.existsSync(file), 'the id was persisted');
    assert.equal(fsSync.statSync(file).mode & 0o777, 0o600, 'owner-only');
    const second = resolveMachineIdentity(options);
    assert.equal(second.id, first.id, 'a later process reads the same id, so a reboot is not a new machine');
    assert.equal(fsSync.readFileSync(file, 'utf8').trim(), first.id);
  } finally {
    await fs.rm(configDir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('the fallback lives in the config dir, never in the state dir the guard is about', async () => {
  const root = await tempDir('placement');
  try {
    const configDir = path.join(root, 'config');
    const stateDir = path.join(root, 'state');
    await fs.mkdir(stateDir);
    const identity = resolveMachineIdentity({ env: {}, configDir, platform: 'sunos', cached: false });
    if (identity.source !== 'orca-file') return; // /etc/machine-id won; nothing was written
    assert.deepEqual(await fs.readdir(stateDir), [], 'a state directory that may be SHARED gets no identity file');
    assert.ok(fsSync.existsSync(path.join(configDir, MACHINE_ID_FILE)));
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('failure to obtain an identity degrades safely: null, a reason, and no throw', async () => {
  const root = await tempDir('unwritable');
  try {
    // A config directory that cannot be created: the file fallback's own
    // failure mode. Refusing to start over an unreadable UUID would be a worse
    // bug than the one this module fixes.
    const blocker = path.join(root, 'blocked');
    await fs.writeFile(blocker, 'not a directory\n');
    const identity = resolveMachineIdentity({
      env: {},
      configDir: path.join(blocker, 'orca'),
      platform: 'sunos',
      cached: false,
    });
    if (identity.source === 'machine-id-file') return; // this host has one; nothing to degrade
    assert.equal(identity.id, null);
    assert.equal(identity.source, 'unavailable');
    assert.match(identity.error, /could not be written|cannot be read/);
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('a relative ORCA_CONFIG_DIR is reported, not thrown', () => {
  clearMachineIdentityCache();
  const identity = resolveMachineIdentity({ env: { ORCA_CONFIG_DIR: 'relative/path' }, platform: 'sunos', cached: false });
  if (identity.source === 'machine-id-file') return;
  assert.equal(identity.id, null);
  assert.match(identity.error, /config directory could not be resolved/);
});

test('an identity is shown short, and always beside the hostname it is not', () => {
  assert.equal(shortMachineId('C20DC899-8710-520C-9966-3233139CC944'), 'C20DC899…C944');
  assert.equal(shortMachineId(''), 'unknown');
  assert.equal(shortMachineId(null), 'unknown');
  assert.equal(
    describeMachine({ id: 'C20DC899-8710-520C-9966-3233139CC944', source: 'platform-uuid' }, 'Mac.lan'),
    'Mac.lan (C20DC899…C944, platform-uuid)',
  );
  assert.equal(describeMachine({ id: null, source: 'unavailable' }, 'Mac.lan'), 'Mac.lan (identity unavailable)');
});

test('the identity does not depend on the caller PATH: /usr/sbin missing must not invent a second machine', (t) => {
  if (process.platform !== 'darwin') {
    t.skip('the PATH-sensitive source (ioreg in /usr/sbin) is macOS-only');
    return;
  }
  // The bug: `ioreg` was looked up on the caller's PATH alone. A LaunchAgent, a
  // cron job or `env -i PATH=/usr/bin:/bin` has no /usr/sbin, so the lookup
  // failed, the resolver fell through to the per-config-dir file, and the SAME
  // Mac then reported two identities. The instance lock compares those, so the
  // CLI declared its own running daemon "taken on another machine" and refused
  // to stop it. Resolve it out of process, because the module memoises.
  const probe = "import('./src/machine-identity.js').then((m) => process.stdout.write(JSON.stringify(m.resolveMachineIdentity({ cached: false }))))";
  const read = (pathEnv) => {
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { PATH: pathEnv, HOME: process.env.HOME },
      timeout: 20000,
    });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout);
  };
  const full = read('/usr/sbin:/sbin:/usr/bin:/bin');
  const stripped = read('/usr/bin:/bin');
  assert.equal(full.source, 'platform-uuid', 'the full-PATH baseline must reach ioreg, or this proves nothing');
  assert.equal(stripped.source, 'platform-uuid', 'a PATH without /usr/sbin still reaches ioreg');
  assert.equal(stripped.id, full.id, 'one machine, one identity, whatever the caller PATH is');
});
