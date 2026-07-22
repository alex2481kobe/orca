import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PrivateAccessStore } from '../src/private-access/store.js';
import {
  detectTailnetState,
  clearTailnetStateCache,
  buildSetupPlan,
  fakeTailnetState,
} from '../src/private-access/tailnet.js';
import { validateAccessUrl } from '../src/private-access/validation.js';

test('private access URL validation rejects unsafe protocols, credentials, and Funnel URLs', () => {
  assert.equal(validateAccessUrl('http://127.0.0.1:3000', { mode: 'local' }), 'http://127.0.0.1:3000/');
  assert.throws(() => validateAccessUrl('file:///tmp/nope', { mode: 'local' }), (error) => /http or https/.test(error.message));
  assert.throws(() => validateAccessUrl('https://user:pass@example.ts.net', { mode: 'tailnet-https-serve' }), (error) => /credentials/.test(error.message));
  assert.throws(() => validateAccessUrl('https://orca.funnel.ts.net', { mode: 'tailnet-https-serve' }), (error) => /Funnel/.test(error.message));
  assert.throws(() => validateAccessUrl('https://example.com', { mode: 'local' }), (error) => /localhost|loopback/.test(error.message));
  assert.throws(() => validateAccessUrl('http://169.254.169.254/latest/meta-data', { mode: 'local' }), (error) => /blocked private/.test(error.message));
  assert.throws(() => validateAccessUrl('http://192.168.1.20:3000', { mode: 'tailnet-http' }), (error) => /blocked private/.test(error.message));
});

test('private access setup plan is dry-run/read-only and never emits Funnel commands', () => {
  const plan = buildSetupPlan({ localUrl: 'http://127.0.0.1:3042', httpPort: 80, httpsPort: 443 });
  assert.equal(plan.localUrl, 'http://127.0.0.1:3042/');
  assert.equal(plan.commands.some((command) => String(command.copyText || '').includes('tailscale serve')), true);
  assert.equal(plan.commands.some((command) => String(command.copyText || '').toLowerCase().includes('funnel')), false);
  assert.equal(plan.commands.every((command) => command.mutatesMachine === false || command.status === 'dry_run_only'), true);

  const fallbackPlan = buildSetupPlan({ localPort: 3042 });
  assert.equal(fallbackPlan.localUrl, 'http://127.0.0.1:3042/');
  assert.throws(
    () => buildSetupPlan({ localUrl: 'https://orca.funnel.ts.net' }),
    (error) => /Funnel/.test(error.message),
  );
  assert.throws(
    () => buildSetupPlan({ localUrl: 'http://169.254.169.254/latest/meta-data' }),
    (error) => /blocked private/.test(error.message),
  );
});

test('fake tailnet provider covers setup states without real Tailscale', () => {
  assert.equal(fakeTailnetState('missing').binaryAvailable, false);
  assert.equal(fakeTailnetState('installed').binaryAvailable, true);
  assert.equal(fakeTailnetState('logged-in').loggedIn, true);
  assert.equal(fakeTailnetState('serve-http').serveMode, 'tailnet-http');
  assert.equal(fakeTailnetState('serve-https').serveMode, 'tailnet-https-serve');
  assert.equal(fakeTailnetState('funnel').serveMode, 'funnel');
  assert.equal(fakeTailnetState('funnel').blockers.some((item) => item.includes('Funnel')), true);
});

test('private access settings default to auto and accept explicit modes; tailnet state persists', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-private-access-settings-'));
  const store = new PrivateAccessStore({ stateFile: path.join(dir, 'private-access.json') });
  try {
    const state = await store.describe({ fakeTailnetState: 'serve-https' });
    assert.equal(state.settings.preferredMode, 'auto');
    const remoteOriginState = await store.describe({
      origin: 'https://orca.funnel.ts.net',
      fakeTailnetState: 'serve-https',
    });
    assert.match(remoteOriginState.setupPlan.localUrl, /^http:\/\/127\.0\.0\.1:/);

    const settings = await store.updateSettings({ preferredMode: 'tailnet-https-serve' });
    assert.equal(settings.preferredMode, 'tailnet-https-serve');

    const nextStore = new PrivateAccessStore({ stateFile: path.join(dir, 'private-access.json') });
    const reloaded = await nextStore.describe({ fakeTailnetState: 'serve-http' });
    assert.equal(reloaded.settings.preferredMode, 'tailnet-https-serve');
    assert.equal(reloaded.tailnet.provider, 'fake');
    assert.equal(reloaded.tailnet.serveMode, 'tailnet-http');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('configureServe runs Serve commands, refreshes detected state, and persists audit', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-private-access-serve-'));
  const calls = [];
  let serveConfigured = false;
  const onlineRunner = (bin, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'version') return { status: 0, stdout: '1.0' };
    if (args[0] === 'status') return { status: 0, stdout: JSON.stringify({ Self: { DNSName: 'mac.tailnet.ts.net.' } }) };
    if (args[0] === 'serve' && args[1] === 'status') {
      return { status: 0, stdout: serveConfigured ? 'http://mac.tailnet.ts.net (tailnet only)\n|-- / proxy http://localhost:3000' : '' };
    }
    if (args[0] === 'serve') {
      serveConfigured = args[1] !== 'reset';
      return { status: 0, stdout: '' };
    }
    return { status: 1, stdout: '' };
  };
  try {
    const stateFile = path.join(dir, 'private-access.json');
    const store = new PrivateAccessStore({ stateFile, runner: onlineRunner });
    const enabled = await store.configureServe({ action: 'enable', port: 3000 });
    assert.equal(enabled.ok, true);
    assert.ok(calls.includes('serve --bg http://127.0.0.1:3000'), 'enable runs the HTTP serve command');
    assert.equal(enabled.tailnet.servedUrl, 'http://mac.tailnet.ts.net');
    const disabled = await store.configureServe({ action: 'disable' });
    assert.ok(calls.includes('serve reset'), 'disable runs serve reset');
    assert.equal(disabled.ok, true);

    const reloaded = new PrivateAccessStore({ stateFile, runner: onlineRunner });
    await reloaded.ensureLoaded();
    const serveAudits = reloaded.state.auditEvents.filter((event) => event.type === 'tailscale_serve_configured');
    assert.equal(serveAudits.length, 2);
    assert.equal(serveAudits[0].status, 'passed');

    // Not signed in -> refuses without running serve.
    const offlineCalls = [];
    const offline = new PrivateAccessStore({
      stateFile: path.join(dir, 'offline.json'),
      runner: (bin, args) => {
        offlineCalls.push(args.join(' '));
        return args[0] === 'version' ? { status: 0, stdout: '1.0' } : { status: 1, stdout: '' };
      },
    });
    const refused = await offline.configureServe({ action: 'enable' });
    assert.equal(refused.ok, false);
    assert.equal(offlineCalls.some((call) => call.startsWith('serve --bg')), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('detectTailnetState surfaces the real Serve URL (no :3000) and ignores non-Orca serve', () => {
  const base = (serveStdout) => (bin, args) => {
    if (args[0] === 'version') return { status: 0, stdout: '1.0' };
    if (args[0] === 'status') return { status: 0, stdout: JSON.stringify({ Self: { DNSName: 'mac.tailnet.ts.net.' } }) };
    if (args[0] === 'serve' && args[1] === 'status') return { status: 0, stdout: serveStdout };
    return { status: 1, stdout: '' };
  };
  // Serve proxies our Orca port -> servedUrl is the port-80 tailnet name (no :3000).
  const serving = detectTailnetState({ runner: base('http://mac.tailnet.ts.net (tailnet only)\n|-- / proxy http://localhost:3000') });
  assert.equal(serving.serveConfigured, true);
  assert.equal(serving.servedUrl, 'http://mac.tailnet.ts.net');
  assert.ok(!serving.servedUrl.includes(':3000'), 'phone URL must not carry the loopback port');
  // Serve proxies a different app -> not treated as ours.
  const other = detectTailnetState({ runner: base('http://mac.tailnet.ts.net\n|-- / proxy http://localhost:9999') });
  assert.equal(other.serveConfigured, false);
  assert.equal(other.servedUrl, null);

  const customPort = detectTailnetState({
    runner: base('https://mac.tailnet.ts.net\n|-- / proxy http://localhost:4173'),
    localPort: 4173,
  });
  assert.equal(customPort.serveConfigured, true);
  assert.equal(customPort.servedUrl, 'https://mac.tailnet.ts.net');
});

test('detectTailnetState can force-refresh the cached real-probe state', () => {
  clearTailnetStateCache();
  let serveConfigured = false;
  const runner = (bin, args) => {
    if (args[0] === 'version') return { status: 0, stdout: '1.0' };
    if (args[0] === 'status') return { status: 0, stdout: JSON.stringify({ Self: { DNSName: 'mac.tailnet.ts.net.' } }) };
    if (args[0] === 'serve' && args[1] === 'status') {
      return { status: 0, stdout: serveConfigured ? 'http://mac.tailnet.ts.net\n|-- / proxy http://localhost:3000' : '' };
    }
    return { status: 1, stdout: '' };
  };

  const initial = detectTailnetState({ runner, cache: true, localPort: 3000 });
  assert.equal(initial.serveConfigured, false);
  serveConfigured = true;
  const cached = detectTailnetState({ runner, cache: true, localPort: 3000 });
  assert.equal(cached.serveConfigured, false);
  const refreshed = detectTailnetState({ runner, cache: true, forceRefresh: true, localPort: 3000 });
  assert.equal(refreshed.serveConfigured, true);
  assert.equal(refreshed.servedUrl, 'http://mac.tailnet.ts.net');
  clearTailnetStateCache();
});
