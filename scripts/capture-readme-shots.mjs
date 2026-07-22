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

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-shots-'));
process.chdir(tempRoot);
const realTempRoot = await fs.realpath(tempRoot);
process.env.PORT = '0';
process.env.ORCA_HOST = '127.0.0.1';
process.env.ORCA_CREDENTIAL_BACKEND = 'memory';
process.env.ORCA_RATE_LIMIT_DISABLED = 'true';
// registerOrchestrator validates cwd against the approved repo roots; each sample
// project is a subfolder of the isolated temp root, so allow the whole root.
process.env.ORCA_REPO_ROOTS = realTempRoot;
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
// v2: projects are keyed by cwd and only appear in the tree once an orchestrator
// registers them (overview drops projects with zero orchestrators). Each sample
// project is a folder whose basename is its display name; each "session" is now an
// orchestrator record (title = the old session name), and the lane spawns under it.
async function projectDir(name) {
  const dir = path.join(realTempRoot, name);
  await fs.mkdir(dir, { recursive: true });
  return fs.realpath(dir);
}
const registerOrch = (cwd, actor, title) => post('/api/orchestrators', { actor, cwd, title });

const auroraDir = await projectDir('Aurora API');
const pixelDir = await projectDir('Pixel Forge');
const nimbusDir = await projectDir('Nimbus Deploy');
const authOrch = await registerOrch(auroraDir, 'auth-rework', 'Auth rework');
await registerOrch(auroraDir, 'rate-limiter', 'Rate limiter');
await registerOrch(pixelDir, 'particle-system', 'Particle system');
await registerOrch(nimbusDir, 'deploy-pipeline', 'Deploy pipeline');
const lane = await post(`/api/orchestrators/${authOrch.id}/lanes`, { actor: 'demo', approved: true, title: 'Refactor token store', executorType: 'mock' });
void lane;

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

// v2: the dashboard is a single Home screen (projects → orchestrators → executors
// tree); there are no per-session/per-lane deep-link routes. All dashboard shots
// target Home, which renders the seeded orchestrators + the spawned lane.
// 1. Hero — desktop, dark, populated project/orchestrator/executor tree.
await shot('hero', { url: lh + '/', width: 1320, height: 860, theme: 'dark' });
// 2. Light theme — same view, to show theming.
await shot('dashboard-light', { url: lh + '/', width: 1320, height: 860, theme: 'light' });
// 3. Lane detail — orchestration depth (the lane appears under its orchestrator).
await shot('lane-detail', { url: lh + '/', width: 1320, height: 860, theme: 'dark' });
// 4. Pairing — the workstation "Pair a device" screen (Remote tab; QR + one-time
//    code). The page.route fake tailnet state above makes it render as "serving".
await shot('pairing', {
  url: lh + '/#remote',
  width: 1320,
  height: 860,
  theme: 'dark',
  before: async (page) => { await page.waitForTimeout(800); },
});
// 5. Phone — the real dashboard on a paired phone.
await shot('phone-dashboard', { url: remote + '/', width: 412, height: 880, theme: 'dark', paired: true });

await b.close();
if (sm.stopServer) await sm.stopServer();
await new Promise((r) => s.close(r));
console.log('done -> docs/assets/');
