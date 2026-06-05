// Verify the Archive disclosure stays OPEN when an item is permanently deleted
// (it used to collapse because the summary count changed its disclosure key). The
// optimistic removal + stable data-uikey="archive" must keep it open and just drop
// the row.
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const projectCwd = process.cwd();
process.chdir(await fs.mkdtemp(path.join(os.tmpdir(), 'orca-verify-state-')));
process.env.PORT = '0'; process.env.ORCA_HOST = '127.0.0.1';
process.env.ORCA_CREDENTIAL_BACKEND = 'memory'; process.env.ORCA_RATE_LIMIT_DISABLED = 'true';
const sm = await import('../src/server.js');
const s = await sm.startServer(0, '127.0.0.1');
const base = `http://127.0.0.1:${s.address().port}`;
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1100, height: 880 }, colorScheme: 'dark' });
const p = await ctx.newPage();
await p.goto(base + '/#system', { waitUntil: 'networkidle' });
await p.waitForTimeout(700);

const result = await p.evaluate(async () => {
  const { shell } = await import('./ui/state.js');
  const frag = await import('./ui/render-fragments.js');
  const views = await import('./ui/render-views.js');
  // Seed two archived sessions and render the settings view.
  shell.archive = { projects: [], sessions: [
    { id: 'arch-1', name: 'Old chat one' },
    { id: 'arch-2', name: 'Old chat two' },
  ] };
  window.location.hash = '#system';
  views.render();
  const details = () => document.querySelector('details[data-uikey="archive"]');
  details().open = true;
  const beforeRows = document.querySelectorAll('.archive-row').length;
  const beforeOpen = details().open;

  // Simulate the optimistic delete path: drop one + render(captureContentUiState()).
  const uiState = frag.captureContentUiState();
  shell.archive.sessions = shell.archive.sessions.filter((x) => x.id !== 'arch-1');
  views.render();
  frag.restoreContentUiState(uiState);

  const after = details();
  return {
    hasUikey: Boolean(after),
    beforeRows,
    afterRows: document.querySelectorAll('.archive-row').length,
    beforeOpen,
    stillOpen: Boolean(after && after.open),
  };
});
console.log('[verify] archive-stays-open:', JSON.stringify(result, null, 2));
await b.close(); if (sm.stopServer) await sm.stopServer(); await new Promise((r) => s.close(r));
