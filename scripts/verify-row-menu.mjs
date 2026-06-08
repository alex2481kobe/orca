// Verify the sidebar row context menu (project/session 3-dot + the actions it
// offers). Boots an isolated server from a temp cwd, seeds a project + session,
// then drives the 3-dot triggers and asserts the floating menu opens with the
// right items and closes on an outside click.
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

const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const project = await post('/api/projects', { actor: 'verify', approved: true, name: 'Menu Test Project' });
const session = await post(`/api/projects/${project.id}/sessions`, { actor: 'verify', approved: true, name: 'Menu Test Session', leader: 'codex' });

const b = await chromium.launch();
const p = await b.newContext().then((c) => c.newPage());
await p.goto(base + (session.route || '/'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(1500);

async function openAndRead(triggerSel, rowSel) {
  // Reveal + click the (opacity:0) trigger.
  await p.hover(rowSel).catch(() => {});
  await p.click(triggerSel, { force: true });
  await p.waitForTimeout(150);
  const items = await p.$$eval('.row-menu .row-menu-item', (els) => els.map((e) => ({ label: e.textContent.trim(), action: e.getAttribute('data-action') })));
  // Close again (outside click).
  await p.mouse.click(5, 5);
  await p.waitForTimeout(100);
  const closed = (await p.$$('.row-menu')).length === 0;
  return { items, closed };
}

// Toggle: clicking the SAME trigger again closes the menu instead of reopening.
await p.hover('.sidebar-session-line').catch(() => {});
await p.click('.sidebar-menu-btn[data-action="openSessionMenu"]', { force: true });
await p.waitForTimeout(120);
const openedAfterFirstClick = (await p.$$('.row-menu')).length === 1;
await p.click('.sidebar-menu-btn[data-action="openSessionMenu"]', { force: true });
await p.waitForTimeout(120);
const closedAfterSecondClick = (await p.$$('.row-menu')).length === 0;

const sessionMenu = await openAndRead('.sidebar-menu-btn[data-action="openSessionMenu"]', '.sidebar-session-line');
const projectMenu = await openAndRead('.sidebar-menu-btn[data-action="openProjectMenu"]', '.sidebar-project-line');

// Screenshot the project menu open, for a visual eyeball.
await p.hover('.sidebar-project-line').catch(() => {});
await p.click('.sidebar-menu-btn[data-action="openProjectMenu"]', { force: true });
await p.waitForTimeout(150);
const shotDir = path.resolve(repoDir, 'artifacts', 'row-menu');
await fs.mkdir(shotDir, { recursive: true }).catch(() => {});
await p.screenshot({ path: path.join(shotDir, 'project-menu-open.png') }).catch(() => {});
await p.mouse.click(5, 5);

// Press feedback (mobile/touch): pointerdown adds .is-pressing immediately for a
// smooth grey-in (no laggy native tap highlight); a long-press opens the menu and
// clears the press state; a move/scroll drops it.
const mp = await b.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true }).then((c) => c.newPage());
await mp.goto(base + (session.route || '/'), { waitUntil: 'domcontentloaded' });
await mp.waitForTimeout(1200);
const press = await mp.evaluate(async () => {
  const row = document.querySelector('.sidebar-session-line');
  if (!row) return { err: 'no row' };
  const fire = (target, type, x = 120, y = 120) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, clientX: x, clientY: y }));
  fire(row, 'pointerdown');
  const pressedImmediately = row.classList.contains('is-pressing');
  await new Promise((r) => setTimeout(r, 540)); // past the 450ms long-press
  const menuOpen = Boolean(document.querySelector('.row-menu'));
  const pressedClearedAfterMenu = !row.classList.contains('is-pressing');
  fire(document, 'pointerup');
  // Quick-tap case: pointerdown then immediate pointerup clears the press state.
  fire(row, 'pointerdown');
  fire(document, 'pointerup');
  await new Promise((r) => setTimeout(r, 20));
  const clearedAfterTap = !row.classList.contains('is-pressing');
  return { pressedImmediately, menuOpen, pressedClearedAfterMenu, clearedAfterTap };
});
await mp.close();

const has = (menu, action) => menu.items.some((i) => i.action === action);
const result = {
  sessionMenuItems: sessionMenu.items,
  projectMenuItems: projectMenu.items,
  sessionClosesOnOutside: sessionMenu.closed,
  projectClosesOnOutside: projectMenu.closed,
  openedAfterFirstClick,
  closedAfterSecondClick,
  press,
};
result.pass = has(sessionMenu, 'renameSession')
  && has(sessionMenu, 'archiveSession')
  && has(projectMenu, 'newSession')
  && has(projectMenu, 'renameProject')
  && has(projectMenu, 'archiveProject')
  && sessionMenu.closed
  && projectMenu.closed
  && openedAfterFirstClick
  && closedAfterSecondClick
  && press.pressedImmediately
  && press.menuOpen
  && press.pressedClearedAfterMenu
  && press.clearedAfterTap;

console.log('[verify] row-menu:', JSON.stringify(result, null, 2));

// Bonus: project archive actually flips state (the backend half of archiveProject).
const archived = await fetch(base + `/api/projects/${project.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actor: 'verify', approved: true, state: 'archived' }) });
const archivedOk = archived.ok;
console.log('[verify] project archive PATCH ok:', archivedOk);

await b.close();
if (sm.stopServer) await sm.stopServer();
await new Promise((r) => s.close(r));
if (!result.pass || !archivedOk) process.exitCode = 1;
void repoDir;
