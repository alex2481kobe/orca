// Visual check of the connect screen, the disconnected mobile Settings, and the
// desktop welcome home. Not part of the smoke suite.
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Isolate .orca state (see verify-pairpanel.mjs): chdir to a throwaway dir before
// importing the server so this never writes into the real auth-sessions.json.
const projectCwd = process.cwd();
process.chdir(await fs.mkdtemp(path.join(os.tmpdir(), 'orca-verify-state-')));

process.env.PORT = '0';
process.env.ORCA_HOST = '127.0.0.1';
process.env.ORCA_API_TOKEN = 'verify-token';
process.env.ORCA_CREDENTIAL_BACKEND = 'memory';
process.env.ORCA_RATE_LIMIT_DISABLED = 'true';

const serverModule = await import('../src/server.js');
const server = await serverModule.startServer(0, '127.0.0.1');
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const outDir = path.join(projectCwd, 'artifacts/verify');
await fs.mkdir(outDir, { recursive: true });

// --- Mobile app (faked Tauri + iPhone UA): connect + disconnected settings ---
const phone = await browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
});
await phone.addInitScript(() => { window.__TAURI__ = { mock: true }; });
const p1 = await phone.newPage();
await p1.goto(base, { waitUntil: 'networkidle' });
await p1.waitForTimeout(500);
await p1.screenshot({ path: path.join(outDir, 'mobile-connect.png'), fullPage: true });

await p1.goto(base + '/#system', { waitUntil: 'networkidle' });
await p1.waitForTimeout(500);
const settings = await p1.evaluate(() => ({
  title: document.getElementById('topbar-title')?.textContent || '',
  hasAppearance: /Appearance/.test(document.body.textContent || ''),
  hasThemeToggle: Boolean(document.querySelector('[data-action="setTheme"]')),
  hasConnectBack: Boolean(document.querySelector('.connect-go-link')),
}));
await p1.screenshot({ path: path.join(outDir, 'mobile-disconnected-settings.png'), fullPage: true });
await phone.close();

// --- Mobile WEB (iPhone Safari, no Tauri), unpaired: connect-styled pair gate + App Store promo ---
const web = await browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
});
const pw1 = await web.newPage();
await pw1.goto(base, { waitUntil: 'networkidle' });
await pw1.waitForTimeout(500);
const pairGate = await pw1.evaluate(() => ({
  hasConnectShell: Boolean(document.querySelector('.connect-shell')),
  hasPairInput: Boolean(document.getElementById('pairing-code-input')),
  hasPromo: Boolean(document.querySelector('.ios-promo')),
  hasLock: /🔒/.test(document.body.textContent || ''),
  // App Store badge should be to the RIGHT of (or below) the icon, never the icon on top of it.
  iconLeftOfBadge: (() => { const i = document.querySelector('.ios-promo-icon')?.getBoundingClientRect(); const b = document.querySelector('.appstore-badge')?.getBoundingClientRect(); return i && b ? i.right <= b.left + 2 : null; })(),
}));
await pw1.screenshot({ path: path.join(outDir, 'mobile-web-pairgate.png'), fullPage: true });
// Error popup: inject a bad alert and screenshot to confirm the border is even
// all the way around (no bold left edge).
const alertBorders = await pw1.evaluate(() => {
  const host = document.getElementById('alerts');
  host.innerHTML = '<div class="alert bad" role="alert">Could not reach the workstation. Check the URL and your Tailscale connection.</div>';
  const el = host.querySelector('.alert');
  const s = getComputedStyle(el);
  return { top: s.borderTopWidth, right: s.borderRightWidth, bottom: s.borderBottomWidth, left: s.borderLeftWidth };
});
await pw1.waitForTimeout(150);
await pw1.screenshot({ path: path.join(outDir, 'mobile-alert.png') });
await web.close();
console.log('[verify] pairGate:', JSON.stringify(pairGate));
console.log('[verify] alertBorders:', JSON.stringify(alertBorders));

// --- Desktop web (workstation, localhost browser): welcome home ---
// Pair a browser session so the home renders instead of the access gate.
const token = process.env.ORCA_API_TOKEN;
const pc = await fetch(base + '/api/auth/pairing-codes', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-orca-token': token },
  body: JSON.stringify({ actor: 'verify', label: 'verify browser', ttlMs: 60000 }),
}).then((r) => r.json());
const pairRes = await fetch(base + '/api/auth/pair', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code: pc.pairing.code, label: 'verify browser' }),
});
const setCookie = pairRes.headers.get('set-cookie') || '';
const desk = await browser.newContext({ viewport: { width: 1100, height: 800 }, deviceScaleFactor: 1 });
if (setCookie) {
  const [cp] = setCookie.split(';');
  const [name, ...vp] = cp.split('=');
  await desk.addCookies([{ name: name.trim(), value: vp.join('=').trim(), url: base, httpOnly: true, sameSite: 'Lax' }]);
}
const p2 = await desk.newPage();
await p2.goto(base, { waitUntil: 'networkidle' });
await p2.waitForTimeout(700);
const home = await p2.evaluate(() => ({
  heroTitle: document.querySelector('.home-hero-title')?.textContent || '',
  hasPairLink: Boolean(document.querySelector('.home-hero-link')),
  hasLogo: Boolean(document.querySelector('.home-hero-logo')),
  bodyMentionsPairFirst: /Pair a phone or laptop/.test(document.body.textContent || ''),
}));
await p2.screenshot({ path: path.join(outDir, 'desktop-home.png') });
await desk.close();

console.log('[verify] settings:', JSON.stringify(settings));
console.log('[verify] home:', JSON.stringify(home));
await browser.close();
if (serverModule.stopServer) await serverModule.stopServer();
await new Promise((r) => server.close(r));
const ok = settings.hasAppearance && settings.hasThemeToggle && settings.hasConnectBack
  && /Welcome to Orca/.test(home.heroTitle) && !home.hasPairLink && home.hasLogo;
console.log(ok ? '[verify] PASS' : '[verify] FAIL');
process.exit(ok ? 0 : 1);
