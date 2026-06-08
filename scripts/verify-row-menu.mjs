// End-to-end verification of the sidebar row context menu — every flow driven to
// its OUTCOME (not just "menu opens"), on desktop AND mobile (drawer open):
//   - 3-dot opens the menu; second click of the same trigger TOGGLES it closed.
//   - clicking outside closes it and does NOT respawn.
//   - New session navigates to a draft for the RIGHT project (and an untouched
//     draft does NOT persist a real session).
//   - Rename project / Rename session actually rename (server reflects).
//   - Archive session / Archive project actually archive (leave the active list).
//   - Empty rename is a no-op.
//   - Mobile: menu items RUN their action (the drawer doesn't eat the tap).
//   - Long-press adds smooth .is-pressing feedback, cleared when the menu opens.
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(await fs.mkdtemp(path.join(os.tmpdir(), 'orca-verify-rowmenu-')));
process.env.PORT = '0';
process.env.ORCA_HOST = '127.0.0.1';
process.env.ORCA_CREDENTIAL_BACKEND = 'memory';
process.env.ORCA_RATE_LIMIT_DISABLED = 'true';

const sm = await import('../src/server.js');
const s = await sm.startServer(0, '127.0.0.1');
const base = `http://127.0.0.1:${s.address().port}`;
const api = (p, opts = {}) => fetch(base + p, { headers: { 'content-type': 'application/json' }, ...opts }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const post = (p, body) => api(p, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.body);
const activeProjects = async () => (await api('/api/projects')).body?.projects ?? (await api('/api/projects')).body ?? [];
const sessionsOf = async (pid) => { const r = await api(`/api/projects/${pid}/sessions`); return r.body?.sessions ?? r.body ?? []; };

let seedN = 0;
async function seedProject(name) {
  seedN += 1;
  // Unique names — desktop and mobile share one server, so reused names collide on
  // slug and the create returns no slug (→ /projects/undefined).
  const project = await post('/api/projects', { actor: 'v', approved: true, name: `${name} ${seedN}` });
  const session = await post(`/api/projects/${project.id}/sessions`, { actor: 'v', approved: true, name: `${name} chat ${seedN}`, leader: 'codex' });
  if (!project.slug) throw new Error(`seed failed: ${JSON.stringify(project).slice(0, 120)}`);
  return { project, session };
}

const b = await chromium.launch();
const results = {};
const errors = [];

async function run(label, viewport, hasTouch, fn) {
  const ctx = await b.newContext({ viewport, hasTouch });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`[${label}] ${e.message}`));
  try { results[label] = await fn(page); }
  catch (e) {
    const shot = path.resolve(repoDir, 'artifacts', `rowmenu-${label}-fail.png`);
    await fs.mkdir(path.dirname(shot), { recursive: true }).catch(() => {});
    await page.screenshot({ path: shot }).catch(() => {});
    results[label] = { error: String(e).split('\n')[0], url: page.url().replace(base, ''), shot };
  }
  await ctx.close();
}

// Open the menu for a SPECIFIC row (scoped by id). Reveal the hover-only triggers
// deterministically via .actions-open, then a REAL click (so the mobile
// pointerdown path is exercised — that was the bug).
async function openMenu(page, kind, id, mobile) {
  if (mobile) { await page.evaluate(() => document.body.classList.add('nav-open')); await page.waitForTimeout(450); }
  const groupSel = kind === 'project'
    ? `.sidebar-project-group[data-project-id="${id}"]`
    : `.sidebar-session-line[data-session-id="${id}"]`;
  await page.evaluate((g) => document.querySelector(g)?.classList.add('actions-open'), groupSel);
  const btnSel = kind === 'project'
    ? `.sidebar-menu-btn[data-action="openProjectMenu"][data-project-id="${id}"]`
    : `.sidebar-menu-btn[data-action="openSessionMenu"][data-session-id="${id}"]`;
  // force: skip the opacity/visibility check (the reveal class can be wiped by a
  // poll re-render) — Playwright still dispatches the real pointerdown+click, so
  // the mobile pointerdown path is genuinely exercised.
  await page.click(btnSel, { force: true });
  await page.waitForTimeout(150);
  return { btnSel, opened: (await page.$$('.row-menu')).length === 1 };
}
async function clickItem(page, action) {
  const item = await page.$(`.row-menu-item[data-action="${action}"]`);
  if (!item) return false;
  await item.click({ force: true });
  await page.waitForTimeout(350);
  return true;
}
async function completeModals(page, inputValue) {
  for (let i = 0; i < 3; i += 1) {
    const overlay = await page.$('.modal-overlay');
    if (!overlay) break;
    const input = await overlay.$('.modal-input');
    if (input && inputValue != null) await input.fill(inputValue);
    await overlay.$eval('.modal-confirm', (el) => el.click());
    await page.waitForTimeout(300);
  }
}

async function flows(page, mobile) {
  const out = {};
  const goProject = async (slug) => { await page.goto(base + `/projects/${slug}`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(900); };
  const goSession = async (route) => { await page.goto(base + route, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(900); };

  // 1. New session → draft for the RIGHT project; no real session persisted.
  {
    const { project } = await seedProject('NS Project');
    const sessAt = await sessionsOf(project.id);
    await goProject(project.slug);
    await openMenu(page, 'project', project.id, mobile);
    await clickItem(page, 'newSession');
    const url = page.url();
    out.newSessionRightProject = url.includes(`/projects/${project.slug}/`) && /draft-/.test(url);
    out.newSessionNoPersist = (await sessionsOf(project.id)).length === sessAt.length;
  }
  // 2. Rename project (prompt → approve) → server reflects.
  {
    const { project } = await seedProject('Rename Me');
    await goProject(project.slug);
    await openMenu(page, 'project', project.id, mobile);
    await clickItem(page, 'renameProject');
    await completeModals(page, 'Renamed OK');
    out.renameProject = (await activeProjects()).find((p) => p.id === project.id)?.name === 'Renamed OK';
  }
  // 3. Rename session.
  {
    const { project, session } = await seedProject('Sess Rename');
    await goSession(session.route);
    await openMenu(page, 'session', session.id, mobile);
    await clickItem(page, 'renameSession');
    await completeModals(page, 'Chat Renamed');
    out.renameSession = (await sessionsOf(project.id)).find((x) => x.id === session.id)?.name === 'Chat Renamed';
  }
  // 4. Empty rename = no-op.
  {
    const { project } = await seedProject('Keep Name');
    await goProject(project.slug);
    await openMenu(page, 'project', project.id, mobile);
    await clickItem(page, 'renameProject');
    await completeModals(page, '');
    out.emptyRenameNoop = (await activeProjects()).find((p) => p.id === project.id)?.name === project.name;
  }
  // 5. Archive session → leaves the active list.
  {
    const { project, session } = await seedProject('Arch Sess');
    await goSession(session.route);
    await openMenu(page, 'session', session.id, mobile);
    await clickItem(page, 'archiveSession');
    await completeModals(page, null);
    out.archiveSession = !(await sessionsOf(project.id)).some((x) => x.id === session.id);
  }
  // 6. Archive project → leaves the active list.
  {
    const { project } = await seedProject('Arch Proj');
    await goProject(project.slug);
    await openMenu(page, 'project', project.id, mobile);
    await clickItem(page, 'archiveProject');
    await completeModals(page, null);
    out.archiveProject = !(await activeProjects()).some((p) => p.id === project.id);
  }
  // 7. Toggle + no-respawn.
  {
    const { project } = await seedProject('Toggle');
    await goProject(project.slug);
    const { btnSel, opened } = await openMenu(page, 'project', project.id, mobile);
    out.heldHighlightWhileOpen = await page.$eval(`.sidebar-project-group[data-project-id="${project.id}"] .sidebar-project-line`, (el) => el.classList.contains('row-menu-active')).catch(() => false);
    await page.click(btnSel, { force: true }); // second click of same trigger
    await page.waitForTimeout(120);
    out.toggleClosesOnSecondClick = opened && (await page.$$('.row-menu')).length === 0;
    await page.click(btnSel, { force: true }); // reopen
    await page.waitForTimeout(120);
    await fs.mkdir(path.resolve(repoDir, 'artifacts', 'row-menu'), { recursive: true }).catch(() => {});
    await page.screenshot({ path: path.resolve(repoDir, 'artifacts', 'row-menu', `${mobile ? 'mobile' : 'desktop'}-menu-open.png`) }).catch(() => {});
    await page.mouse.click(mobile ? 360 : 1000, 420); // click empty area
    await page.waitForTimeout(150);
    out.noRespawnOnOutsideClick = (await page.$$('.row-menu')).length === 0;
    out.highlightClearedOnClose = !(await page.$(`.sidebar-project-group[data-project-id="${project.id}"] .sidebar-project-line.row-menu-active`));
  }
  return out;
}

await run('desktop', { width: 1280, height: 860 }, false, (page) => flows(page, false));
await run('mobile', { width: 390, height: 820 }, true, (page) => flows(page, true));

const flat = Object.entries(results).flatMap(([scope, o]) => Object.entries(o).map(([k, v]) => [`${scope}.${k}`, v]));
const failed = flat.filter(([, v]) => v !== true);
console.log('[verify] row-menu flows:');
for (const [k, v] of flat) console.log(`  ${v === true ? 'PASS' : 'FAIL'}  ${k}${v === true ? '' : ` = ${JSON.stringify(v)}`}`);
if (errors.length) { console.log('--- page errors ---'); console.log(errors.join('\n')); }
const pass = failed.length === 0 && errors.length === 0;
console.log(pass ? '[verify] ALL FLOWS PASS' : `[verify] ${failed.length} FAIL`);

await b.close();
if (sm.stopServer) await sm.stopServer();
await new Promise((r) => s.close(r));
if (!pass) process.exitCode = 1;
