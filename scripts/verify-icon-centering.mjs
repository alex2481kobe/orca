// Full-UI pass: find icon-only buttons whose glyph/icon is NOT centered within the
// button. For each candidate (single glyph ≤2 chars, or a single svg/img/icon
// child) it compares the content's center to the button's center; |offset| > 1.6px
// on either axis = off-center. Audits the workstation view AND the remote pair gate.
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
const base = `http://127.0.0.1:${port}`;

// Pair one device (admin via token) so the workstation shows a device row + Revoke.
const pc = await fetch(base + '/api/auth/pairing-codes', { method: 'POST', headers: { 'content-type': 'application/json', 'x-orca-token': 'verify-token' }, body: JSON.stringify({ actor: 'v', label: 'v', ttlMs: 60000 }) }).then((r) => r.json());
const pr = await fetch(base + '/api/auth/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pc.pairing.code, label: 'Alex iPhone', deviceId: 'd1' }) });
const adminCookie = (pr.headers.get('set-cookie') || '').split(';')[0];

const AUDIT_FN = () => {
  const out = [];
  const els = Array.from(document.querySelectorAll('button, .ws-forget, .device-revoke, .seg-btn, .shell-toggle, .sidebar-collapse, .sidebar-reopen'));
  for (const el of els) {
    if (el.getClientRects().length === 0) continue; // not visible
    const text = (el.textContent || '').replace(/\s+/g, '').trim();
    const kids = Array.from(el.children);
    const iconKids = kids.filter((c) => /^(svg|img)$/i.test(c.tagName)
      || /icon|check|plus|mark/i.test(c.className || ''));
    const glyphOnly = text.length > 0 && text.length <= 2 && kids.length === 0;
    const singleIcon = iconKids.length === 1 && kids.length === 1 && text.length <= 2;
    if (!glyphOnly && !singleIcon) continue;
    const br = el.getBoundingClientRect();
    let cr;
    if (singleIcon) { cr = iconKids[0].getBoundingClientRect(); }
    else { const r = document.createRange(); r.selectNodeContents(el); cr = r.getBoundingClientRect(); }
    if (!cr || !cr.width) continue;
    const dx = +((cr.left + cr.width / 2) - (br.left + br.width / 2)).toFixed(1);
    const dy = +((cr.top + cr.height / 2) - (br.top + br.height / 2)).toFixed(1);
    out.push({ cls: (el.className || el.tagName).toString().slice(0, 40), text: text.slice(0, 3), w: Math.round(br.width), h: Math.round(br.height), dx, dy, ok: Math.abs(dx) <= 1.6 && Math.abs(dy) <= 1.6 });
  }
  return out;
};

const b = await chromium.launch({ args: ['--host-resolver-rules=MAP remote.test 127.0.0.1'] });
const results = {};

// Workstation view (#pair shows create-code, paired device Revoke, sidebar toggles).
{
  const ctx = await b.newContext({ viewport: { width: 1200, height: 900 }, colorScheme: 'dark' });
  if (adminCookie) { const [n, ...v] = adminCookie.split('='); await ctx.addCookies([{ name: n, value: v.join('='), url: base, httpOnly: true, sameSite: 'Lax' }]); }
  const p = await ctx.newPage();
  await p.goto(base + '/#pair', { waitUntil: 'networkidle' });
  await p.waitForTimeout(1200);
  await p.evaluate(() => document.querySelectorAll('details').forEach((d) => { d.open = true; }));
  await p.waitForTimeout(200);
  results.workstation = await p.evaluate(AUDIT_FN);
  await ctx.close();
}

// Remote pair gate (mobile) — has the ws-forget × in the switch list.
{
  const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  const ctx = await b.newContext({ userAgent: IPHONE_UA, viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
  await ctx.addInitScript((pp) => {
    localStorage.setItem('orca.workstations', JSON.stringify([`http://remote.test:${pp}`, 'http://other-mac.ts.net']));
  }, port);
  const p = await ctx.newPage();
  await p.goto(`http://remote.test:${port}/`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(700);
  await p.evaluate(() => { const d = document.querySelector('details[data-uikey="switch-workstation"]'); if (d) d.open = true; });
  await p.waitForTimeout(200);
  results.pairGate = await p.evaluate(AUDIT_FN);
  await ctx.close();
}

const all = [...results.workstation, ...results.pairGate];
const offCenter = all.filter((x) => !x.ok);
console.log('[icon-audit] total icon buttons:', all.length, '| off-center:', offCenter.length);
console.log(JSON.stringify({ offCenter, sample: all }, null, 2));
await b.close(); if (sm.stopServer) await sm.stopServer(); await new Promise((r) => s.close(r));
