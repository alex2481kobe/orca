// Capture polished, public-safe screenshots for the README. Boots an isolated
// server from a temp cwd (never touches real .orca state), seeds fictional sample
// projects/sessions/a lane, and captures desktop + phone shots in light & dark into
// docs/assets/. Sample names are made-up — no real project names, no secrets.
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(repoDir, 'docs', 'assets');
await fs.mkdir(outDir, { recursive: true });

process.chdir(await fs.mkdtemp(path.join(os.tmpdir(), 'orca-shots-')));
process.env.PORT = '0';
process.env.ORCA_HOST = '127.0.0.1';
process.env.ORCA_CREDENTIAL_BACKEND = 'memory';
process.env.ORCA_RATE_LIMIT_DISABLED = 'true';
// Allow the localtest.me "remote" host through the anti-DNS-rebinding Host gate.
// It resolves to 127.0.0.1 but is a non-loopback name (used to render the remote
// UI); real tailnet access is proxied and allowed automatically — this opt-in is
// only for local remote simulation.
process.env.ORCA_ALLOWED_HOSTS = 'workstation.localtest.me';

const sm = await import('../src/server.js');
const s = await sm.startServer(0, '127.0.0.1');
const port = s.address().port;
const lh = `http://127.0.0.1:${port}`;
const remote = `http://workstation.localtest.me:${port}`;
const post = (p, body) => fetch(lh + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

// --- Seed fictional, public-safe sample data ---
const aurora = await post('/api/projects', { actor: 'demo', approved: true, name: 'Aurora API' });
const pixel = await post('/api/projects', { actor: 'demo', approved: true, name: 'Pixel Forge' });
const nimbus = await post('/api/projects', { actor: 'demo', approved: true, name: 'Nimbus Deploy' });
const authSession = await post(`/api/projects/${aurora.id}/sessions`, { actor: 'demo', approved: true, name: 'Auth rework', leader: 'codex' });
await post(`/api/projects/${aurora.id}/sessions`, { actor: 'demo', approved: true, name: 'Rate limiter', leader: 'codex' });
await post(`/api/projects/${pixel.id}/sessions`, { actor: 'demo', approved: true, name: 'Particle system', leader: 'claude' });
const lane = await post(`/api/sessions/${authSession.id}/lanes`, { actor: 'demo', approved: true, title: 'Refactor token store', executorType: 'mock' });
void nimbus; void lane;

const b = await chromium.launch();

async function shot(name, { url, width, height, theme = 'dark', paired = false, before }) {
  const ctx = await b.newContext({ viewport: { width, height }, hasTouch: width < 700, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  // SECURITY: force a FAKE tailnet state on every private-access fetch so the real
  // machine's tailnet hostname never reaches a committed screenshot. The fake
  // returns the public-safe placeholder host `orca.test-tailnet.ts.net`.
  await page.route('**/api/private-access*', (route) => {
    const u = new URL(route.request().url());
    u.searchParams.set('fakeTailnetState', 'serve-http');
    route.continue({ url: u.toString() });
  });
  const origin = url.startsWith(remote) ? remote : lh;
  // Set theme before first paint (per-origin localStorage).
  await page.addInitScript((t) => { try { localStorage.setItem('orca.theme', t); } catch { /* ignore */ } }, theme);
  if (paired) {
    await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(async () => {
      const mk = await (await fetch('/api/auth/pairing-codes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actor: 'demo', label: 'iPhone' }) })).json();
      await fetch('/api/auth/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actor: 'demo', code: mk.pairing.code, label: 'iPhone', deviceId: 'demo-phone' }) });
    });
  }
  await page.goto(origin + url.replace(origin, ''), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1600);
  if (before) await before(page);
  await page.waitForTimeout(400);
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file });
  await ctx.close();
  console.log('shot', name, '->', file);
}

// 1. Hero — desktop, dark, a session open (composer + populated sidebar).
await shot('hero', { url: lh + authSession.route, width: 1320, height: 860, theme: 'dark' });
// 2. Light theme — same view, to show theming.
await shot('dashboard-light', { url: lh + authSession.route, width: 1320, height: 860, theme: 'light' });
// 3. Lane detail — orchestration depth.
await shot('lane-detail', { url: lh + (lane.route || authSession.route), width: 1320, height: 860, theme: 'dark' });
// 4. Pairing — the workstation "Pair a remote device" screen (QR + one-time code).
await shot('pairing', {
  url: lh + '/#pair',
  width: 1320,
  height: 860,
  theme: 'dark',
  before: async (page) => {
    await page.evaluate(async () => {
      const r = await (await fetch('/api/auth/pairing-codes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actor: 'demo', label: 'iPhone' }) })).json();
      const st = await import('/ui/state.js'); st.shell.lastPairing = r.pairing;
      const v = await import('/ui/render-views.js'); v.render();
    });
    await page.waitForTimeout(500);
  },
});
// 5. Phone — the real dashboard on a paired phone.
await shot('phone-dashboard', { url: remote + authSession.route, width: 412, height: 880, theme: 'dark', paired: true });

await b.close();
if (sm.stopServer) await sm.stopServer();
await new Promise((r) => s.close(r));
console.log('done -> docs/assets/');
