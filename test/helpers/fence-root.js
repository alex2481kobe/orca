// A fixture that registers agents in its temp directory declares that directory
// as its fence, the way a real install does with `orca-cli.js setup --roots`:
// Orca never treats its working directory as an approved root (src/fence.js).
// Not a test file itself (the runner globs *.test.js).
const saved = [];

export function approveFixtureRoot(dir) {
  saved.push(process.env.ORCA_REPO_ROOTS);
  process.env.ORCA_REPO_ROOTS = dir;
}

export function restoreFixtureRoot() {
  if (!saved.length) return;
  const previous = saved.pop();
  if (previous === undefined) delete process.env.ORCA_REPO_ROOTS;
  else process.env.ORCA_REPO_ROOTS = previous;
}
