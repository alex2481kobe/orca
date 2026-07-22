// Hard backstop against a recursive delete ever escaping to a working tree.
// A recursive rm is permitted ONLY when its realpath-resolved target is strictly
// INSIDE `allowedRoot` and is NOT itself a git repo root (a directory containing
// a `.git`). Paths are normalized through fs.realpath so an aliased/symlinked
// spelling (e.g. macOS /var vs /private/var) can never slip past an equality
// check. Returns { removed, reason } and NEVER throws for a guard rejection —
// callers decide whether a rejection is fatal.
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';

function realOrResolve(p) {
  try { return fss.realpathSync(path.resolve(p)); } catch { return path.resolve(p); }
}

export async function safeRmRecursive(target, allowedRoot) {
  if (!target || !allowedRoot) return { removed: false, reason: 'target and allowedRoot are required' };
  const realTarget = realOrResolve(target);
  const realRoot = realOrResolve(allowedRoot);
  const rel = path.relative(realRoot, realTarget);
  // Empty rel = target IS the root; '..' prefix or absolute = target is outside.
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return { removed: false, reason: `refusing recursive rm outside the allowed root (${realTarget} is not strictly inside ${realRoot})` };
  }
  if (fss.existsSync(path.join(realTarget, '.git'))) {
    return { removed: false, reason: `refusing recursive rm of a git repo root (${realTarget})` };
  }
  await fs.rm(realTarget, { recursive: true, force: true });
  return { removed: true };
}
