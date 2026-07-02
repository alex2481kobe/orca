#!/usr/bin/env node
/*
 * Browser smoke for the session command terminal:
 *   chat terminal view -> Command tab -> New terminal -> run shell input -> see output.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { launchChromium } from './playwright-launch.mjs';

const previousCwd = process.cwd();
const previousEnv = { ...process.env };
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-terminal-ui-'));
const token = 'operator-terminal-smoke-token';
let server = null;
let stopServer = null;
let base = '';

const log = (label, info = '') => console.log(`[operator-terminal-smoke] ${label}${info ? ' — ' + info : ''}`);
const fail = (label, info = '') => {
  console.error(`[operator-terminal-smoke FAIL] ${label}${info ? ' — ' + info : ''}`);
  throw new Error(`${label}${info ? `: ${info}` : ''}`);
};

async function req(method, route, body) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-orca-token': token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* noop */ }
  return { status: response.status, body: data };
}

async function cleanup() {
  if (stopServer) await stopServer();
  if (server) await new Promise((resolve) => server.close(resolve));
  process.chdir(previousCwd);
  await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  for (const key of Object.keys(process.env)) {
    if (!(key in previousEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(previousEnv)) process.env[key] = value;
}

try {
  process.chdir(tempDir);
  process.env.PORT = '0';
  process.env.ORCA_HOST = '127.0.0.1';
  process.env.ORCA_API_TOKEN = token;
  process.env.ORCA_RATE_LIMIT_DISABLED = 'true';
  process.env.ORCA_CREDENTIAL_BACKEND = 'memory';

  const [{ chromium }, serverModule] = await Promise.all([
    import('playwright'),
    import('../src/server.js'),
  ]);
  server = await serverModule.startServer(0, '127.0.0.1');
  stopServer = serverModule.stopServer;
  base = `http://127.0.0.1:${server.address().port}`;
  log('server', base);

  const project = await req('POST', '/api/projects', {
    actor: 'dashboard',
    approved: true,
    name: 'Operator Terminal Smoke',
  });
  if (project.status !== 201) fail('project create', JSON.stringify(project.body));
  const session = await req('POST', `/api/projects/${project.body.id}/sessions`, {
    actor: 'dashboard',
    approved: true,
    name: 'Command terminal session',
  });
  if (session.status !== 201) fail('session create', JSON.stringify(session.body));

  const browser = await launchChromium({ chromium }, { headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 860 },
      extraHTTPHeaders: { 'x-orca-token': token },
    });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(error.stack || error.message));
    await page.goto(`${base}${session.body.route}`, {
      waitUntil: 'networkidle',
      timeout: 20000,
    });
    try {
      await page.waitForSelector('[data-action="toggleChatTerminal"]', { timeout: 15000 });
    } catch (error) {
      const text = await page.evaluate(() => (document.body.textContent || '').slice(0, 3000)).catch(() => '');
      fail('terminal toggle not rendered', `${error.message}\n${text}\n${consoleErrors.join('\n')}`);
    }
    await page.click('[data-action="toggleChatTerminal"]');
    await page.waitForSelector('.chat.chat-terminal-open .chat-terminal-tabs', { timeout: 10000 });
    await page.click('[data-action="setChatTerminalTab"][data-tab="command"]');
    await page.waitForSelector('[data-action="startOperatorTerminal"]', { timeout: 10000 });
    await page.click('[data-action="startOperatorTerminal"]');
    await page.waitForSelector('.operator-terminal-input-form input[name="input"]', { timeout: 10000 });
    try {
      await page.waitForSelector('.operator-terminal-stream .xterm', { timeout: 10000 });
    } catch (error) {
      const terminalHtml = await page.evaluate(() => document.querySelector('.operator-terminal-stream')?.outerHTML || '').catch(() => '');
      fail('xterm did not mount', `${error.message}\n${terminalHtml}\n${consoleErrors.join('\n')}`);
    }
    await page.fill(
      '.operator-terminal-input-form input[name="input"]',
      'printf "__ORCA_UI_TERMINAL__\\n"; pwd; cd ..; pwd; ls',
    );
    await page.press('.operator-terminal-input-form input[name="input"]', 'Enter');
    await page.waitForFunction(() => {
      const text = document.querySelector('.operator-terminal-stream')?.textContent || '';
      return text.includes('__ORCA_UI_TERMINAL__') && !text.includes('Connecting to terminal');
    }, { timeout: 12000 });
    const output = await page.locator('.operator-terminal-stream').innerText();
    if (!output.includes('__ORCA_UI_TERMINAL__')) fail('terminal output marker missing', output);
    const shotDir = path.join(previousCwd, 'artifacts', 'operator-terminal-smoke');
    await fs.mkdir(shotDir, { recursive: true });
    await page.screenshot({ path: path.join(shotDir, 'command-terminal.png'), fullPage: true });
    if (consoleErrors.length) fail('browser console errors', consoleErrors.join('\n'));
    await page.click('[data-action="stopOperatorTerminal"]');
    await context.close();
    log('done', 'command terminal rendered shell output');
  } finally {
    await browser.close();
  }
} finally {
  await cleanup();
}
