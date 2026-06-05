// Find what overflows horizontally when the "Switch workstation" disclosure opens
// on the pair gate at phone width (no horizontal scroller wanted).
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const projectCwd = process.cwd();
process.chdir(await fs.mkdtemp(path.join(os.tmpdir(), 'orca-verify-state-')));
process.env.PORT = '0'; process.env.ORCA_HOST = '127.0.0.1';
process.env.ORCA_CREDENTIAL_BACKEND = 'memory'; process.env.ORCA_RATE_LIMIT_DISABLED = 'true';
process.env.ORCA_API_TOKEN = 'verify-token';
const sm = await import('../src/server.js');
const s = await sm.startServer(0, '127.0.0.1');
const port = s.address().port;
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const b = await chromium.launch({ args: ['--host-resolver-rules=MAP remote.test 127.0.0.1'] });

const ctx = await b.newContext({ userAgent: IPHONE_UA, viewport: { width: 390, height: 844 } });
await ctx.addInitScript((pp) => {
  // Include a deliberately LONG workstation host to stress truncation.
  localStorage.setItem('orca.workstations', JSON.stringify([
    `http://remote.test:${pp}`,
    'http://my-really-long-workstation-name.tail9a8b7c6d5e.ts.net',
  ]));
}, port);
const p = await ctx.newPage();
await p.goto(`http://remote.test:${port}/`, { waitUntil: 'networkidle' });
await p.waitForTimeout(700);
await p.evaluate(() => { const d = document.querySelector('details[data-uikey="switch-workstation"]'); if (d) d.open = true; });
await p.waitForTimeout(200);

const report = await p.evaluate(() => {
  const docEl = document.documentElement;
  const vw = docEl.clientWidth;
  const overflow = docEl.scrollWidth - vw;
  // Walk the DOM; report elements whose right edge exceeds the viewport.
  const offenders = [];
  document.querySelectorAll('.connect-gate *').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.right > vw + 0.5 || r.width > vw + 0.5) {
      offenders.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className || '').toString().slice(0, 40),
        right: Math.round(r.right),
        width: Math.round(r.width),
        scrollW: el.scrollWidth,
      });
    }
  });
  return { vw, scrollWidth: docEl.scrollWidth, overflowPx: overflow, offenders: offenders.slice(0, 12) };
});
const outDir = path.join(projectCwd, 'artifacts/verify');
await fs.mkdir(outDir, { recursive: true });
await p.screenshot({ path: path.join(outDir, 'switch-overflow.png') });
console.log('[verify] switch-overflow:', JSON.stringify(report, null, 2));
await b.close(); if (sm.stopServer) await sm.stopServer(); await new Promise((r) => s.close(r));
