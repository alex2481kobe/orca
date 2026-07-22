import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { safeRmRecursive } from '../src/safe-fs.js';

test('safeRmRecursive removes a subdir strictly inside the allowed root', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'saferm-'));
  const sub = path.join(root, 'workspaces', 'sess-1');
  await fs.mkdir(sub, { recursive: true });
  await fs.writeFile(path.join(sub, 'f.txt'), 'x');
  const r = await safeRmRecursive(sub, path.join(root, 'workspaces'));
  assert.equal(r.removed, true);
  assert.equal(fss.existsSync(sub), false);
  await fs.rm(root, { recursive: true, force: true });
});

test('safeRmRecursive REFUSES to delete a git repo root (has .git)', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'saferm-'));
  const repo = path.join(root, 'workspaces', 'a-repo');
  await fs.mkdir(path.join(repo, '.git'), { recursive: true });
  await fs.writeFile(path.join(repo, 'SENTINEL'), 'keep');
  const r = await safeRmRecursive(repo, path.join(root, 'workspaces'));
  assert.equal(r.removed, false);
  assert.match(r.reason, /git repo root/);
  assert.equal(fss.existsSync(path.join(repo, 'SENTINEL')), true, 'repo must survive');
  await fs.rm(root, { recursive: true, force: true });
});

test('safeRmRecursive REFUSES a target outside the allowed root (and the root itself)', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'saferm-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'saferm-out-'));
  await fs.writeFile(path.join(outside, 'SENTINEL'), 'keep');
  const rOut = await safeRmRecursive(outside, root);
  assert.equal(rOut.removed, false);
  assert.equal(fss.existsSync(path.join(outside, 'SENTINEL')), true);
  // The allowed root itself must not be deletable (rel === '').
  const rSelf = await safeRmRecursive(root, root);
  assert.equal(rSelf.removed, false);
  assert.equal(fss.existsSync(root), true);
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

test('safeRmRecursive normalizes symlinked/aliased roots (no /var vs /private/var bypass)', async () => {
  // os.tmpdir() on macOS is /var/folders/... which realpaths to /private/var/...
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'saferm-'));
  const repo = path.join(root, 'repo');
  await fs.mkdir(path.join(repo, '.git'), { recursive: true });
  // Pass the alias spelling for the root; target still recognized as the repo root.
  const aliasRoot = root.replace('/private/var/', '/var/');
  const r = await safeRmRecursive(repo, aliasRoot);
  assert.equal(r.removed, false, 'aliased root must not let a .git repo be deleted');
  assert.equal(fss.existsSync(path.join(repo, '.git')), true);
  await fs.rm(root, { recursive: true, force: true });
});
