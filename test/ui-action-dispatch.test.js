import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appJsPath = path.join(here, '..', 'public', 'app.js');

// Regression guard for the class of bug where a button renders a data-action,
// a handler exists for it, but the delegated click dispatcher never routes to
// that handler (so the button silently does nothing — e.g. the agent approve/
// deny buttons). Every rendered data-action must be reachable by the dispatcher.
test('every rendered data-action is routed by the click dispatcher', async () => {
  const src = await fs.readFile(appJsPath, 'utf8');

  const rendered = new Set([...src.matchAll(/data-action="([a-zA-Z]+)"/g)].map((m) => m[1]));

  // Scope to the main delegated click dispatcher (the last click listener to EOF)
  // so we measure actual DISPATCH wiring, not handler-internal `action === 'x'`
  // checks (handlers are defined earlier in the file).
  const lastClick = src.lastIndexOf("addEventListener('click'");
  assert.ok(lastClick > 0, 'could not locate the click dispatcher');
  const dispatcher = src.slice(lastClick);

  // Dispatched = routed via `action === 'x'` checks OR `[ ... ].includes(action)`
  // allowlist arrays, within the dispatcher region.
  const dispatched = new Set();
  for (const m of dispatcher.matchAll(/action === ['"]([a-zA-Z]+)['"]/g)) dispatched.add(m[1]);
  for (const arr of dispatcher.matchAll(/\[([\s\S]*?)\]\.includes\(action\)/g)) {
    for (const t of arr[1].matchAll(/['"]([a-zA-Z]+)['"]/g)) dispatched.add(t[1]);
  }

  // Pure navigation actions handled structurally (no per-action branch).
  const structural = new Set(['toggleNav']);

  const missing = [...rendered].filter((a) => !dispatched.has(a) && !structural.has(a));
  assert.deepEqual(
    missing,
    [],
    `These rendered data-actions are never dispatched (button does nothing): ${missing.join(', ')}`,
  );
});
