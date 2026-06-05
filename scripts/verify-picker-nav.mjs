// Verify: tapping inside the custom New-Project file picker (a modal overlay) does
// NOT collapse the open left nav panel behind it on mobile.
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
const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
const p = await ctx.newPage();
await p.goto(base + '/', { waitUntil: 'networkidle' });
await p.waitForTimeout(600);

const result = await p.evaluate(async () => {
  const { shell, refs } = await import('./ui/state.js');
  const views = await import('./ui/render-views.js');
  // Open the mobile nav drawer, then open the project file picker on top.
  document.body.classList.add('nav-open');
  shell.workstationPicker = { open: true, mode: 'project', cwd: '/tmp', entries: [], loading: false };
  views.render();
  const overlay = document.querySelector('.picker-overlay, #picker-overlay .modal-overlay, .modal-overlay');
  const navOpenBefore = document.body.classList.contains('nav-open');
  // Simulate a real tap inside the picker: pointerdown (the path that actually
  // collapsed the panel) AND click.
  const target = (document.querySelector('.picker-modal') || overlay);
  let tapped = false;
  if (target) {
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, button: 0, clientX: 200, clientY: 300 }));
    await new Promise((r) => setTimeout(r, 20));
    const navAfterPointerdown = document.body.classList.contains('nav-open');
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    tapped = true;
    await new Promise((r) => setTimeout(r, 30));
    return {
      pickerRendered: Boolean(overlay),
      tapped,
      navOpenBefore,
      navOpenAfterPointerdown: navAfterPointerdown,
      navOpenAfterClick: document.body.classList.contains('nav-open'),
    };
  }
  return { pickerRendered: Boolean(overlay), tapped, navOpenBefore };
});
console.log('[verify] picker-nav:', JSON.stringify({ ...result, pass: result.pickerRendered && result.navOpenBefore && result.navOpenAfterClick }, null, 2));
await b.close(); if (sm.stopServer) await sm.stopServer(); await new Promise((r) => s.close(r));
