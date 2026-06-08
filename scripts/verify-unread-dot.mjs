// Verify the "unread" session dot: computeUnreadSessions logic + the rendered dot
// + that opening a session clears it. Isolated server from a temp cwd.
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.chdir(await fs.mkdtemp(path.join(os.tmpdir(), 'orca-unread-')));
process.env.PORT = '0';
process.env.ORCA_HOST = '127.0.0.1';
process.env.ORCA_CREDENTIAL_BACKEND = 'memory';
process.env.ORCA_RATE_LIMIT_DISABLED = 'true';

const sm = await import('../src/server.js');
const s = await sm.startServer(0, '127.0.0.1');
const base = `http://127.0.0.1:${s.address().port}`;
const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const project = await post('/api/projects', { actor: 'u', approved: true, name: 'Unread Test' });
const a = await post(`/api/projects/${project.id}/sessions`, { actor: 'u', approved: true, name: 'Session A', leader: 'codex' });
const b = await post(`/api/projects/${project.id}/sessions`, { actor: 'u', approved: true, name: 'Session B', leader: 'codex' });

const browser = await chromium.launch();
const p = await browser.newContext().then((c) => c.newPage());
await p.goto(base + a.route, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(1200);

// --- Logic checks (call the exported helper with crafted inputs) ---
const logic = await p.evaluate(async () => {
  const rh = await import('/ui/render-helpers.js');
  localStorage.setItem('orca.sessionSeen:v1', JSON.stringify({ x: '2020-01-01T00:00:00Z', y: '2020-01-01T00:00:00Z' }));
  const sessions = [
    { id: 'x', updatedAt: '2030-01-01T00:00:00Z', createdAt: '2019-01-01T00:00:00Z' }, // new activity, seen old
    { id: 'y', updatedAt: '2030-01-01T00:00:00Z', createdAt: '2019-01-01T00:00:00Z' }, // same, but has a live lane
    { id: 'z', updatedAt: '2030-01-01T00:00:00Z', createdAt: '2019-01-01T00:00:00Z' }, // first-observed → baseline, no dot
  ];
  const lanes = [{ sessionId: 'y', state: 'running', updatedAt: '2030-01-01T00:00:00Z' }];
  const unreadClosed = [...rh.computeUnreadSessions(sessions, lanes, null)];
  // x open → should be marked seen (not unread)
  const unreadXOpen = [...rh.computeUnreadSessions(sessions, lanes, 'x')];
  return {
    xUnread: unreadClosed.includes('x'),         // expect true
    yUnreadWhileLive: unreadClosed.includes('y'), // expect false (live lane)
    zUnreadFirstSeen: unreadClosed.includes('z'), // expect false (baselined)
    xClearedWhenOpen: !unreadXOpen.includes('x'), // expect true
  };
});

// --- Render check: B unread shows the dot, A does not; opening B clears it ---
await p.evaluate((bid) => localStorage.setItem('orca.sessionSeen:v1', JSON.stringify({ [bid]: '2020-01-01T00:00:00Z' })), b.id);
await p.goto(base + a.route, { waitUntil: 'domcontentloaded' }); // open A, B not open
await p.waitForTimeout(1200);
const dotOnB = Boolean(await p.$(`.sidebar-session-line[data-session-id="${b.id}"] .session-unread-dot`));
const dotOnA = Boolean(await p.$(`.sidebar-session-line[data-session-id="${a.id}"] .session-unread-dot`));
await p.goto(base + b.route, { waitUntil: 'domcontentloaded' }); // open B → should clear
await p.waitForTimeout(1200);
await p.goto(base + a.route, { waitUntil: 'domcontentloaded' }); // back to A; B should no longer be unread
await p.waitForTimeout(1200);
const dotOnBAfterOpen = Boolean(await p.$(`.sidebar-session-line[data-session-id="${b.id}"] .session-unread-dot`));

const result = { ...logic, dotShownForUnreadB: dotOnB, noDotForOpenA: !dotOnA, dotClearedAfterOpeningB: !dotOnBAfterOpen };
console.log('[verify] unread-dot:', JSON.stringify(result, null, 2));
result.pass = result.xUnread && !result.yUnreadWhileLive && !result.zUnreadFirstSeen && result.xClearedWhenOpen
  && result.dotShownForUnreadB && result.noDotForOpenA && result.dotClearedAfterOpeningB;
console.log(result.pass ? '[verify] PASS' : '[verify] FAIL');

await browser.close();
if (sm.stopServer) await sm.stopServer();
await new Promise((r) => s.close(r));
if (!result.pass) process.exitCode = 1;
