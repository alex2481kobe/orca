import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  PrivateAccessStore,
  detectTailnetState,
  buildSetupPlan,
  fakeTailnetState,
  validateAccessUrl,
} from '../src/private-access.js';

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

test('private access settings default to auto while targets require explicit modes', async () => {
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

    await assert.rejects(
      () => store.createTarget({
        label: 'Ambiguous target',
        mode: 'auto',
        localUrl: 'http://127.0.0.1:3000',
      }),
      (error) => /Unsupported private access mode/.test(error.message),
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('private access store persists targets and rejects Funnel targets', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-private-access-'));
  const store = new PrivateAccessStore({ stateFile: path.join(dir, 'private-access.json') });
  try {
    const target = await store.createTarget({
      label: 'Local app',
      mode: 'local',
      localUrl: 'http://localhost:4173',
      favorite: true,
    });
    assert.equal(target.label, 'Local app');
    assert.equal(target.favorite, true);

    await assert.rejects(
      () => store.createTarget({
        label: 'Bad public funnel',
        mode: 'tailnet-https-serve',
        localUrl: 'http://127.0.0.1:3000',
        httpsServeUrl: 'https://bad.funnel.ts.net',
      }),
      (error) => /Funnel/.test(error.message),
    );

    const nextStore = new PrivateAccessStore({ stateFile: path.join(dir, 'private-access.json') });
    const state = await nextStore.describe({ fakeTailnetState: 'serve-http' });
    assert.equal(state.targets.length, 1);
    assert.equal(state.tailnet.provider, 'fake');
    assert.equal(state.tailnet.serveMode, 'tailnet-http');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('private access targets are capped to avoid unbounded state growth', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-private-access-cap-'));
  const store = new PrivateAccessStore({ stateFile: path.join(dir, 'private-access.json') });
  try {
    for (let index = 0; index < 100; index += 1) {
      await store.createTarget({
        label: `Local app ${index}`,
        mode: 'local',
        localUrl: 'http://127.0.0.1:4173',
      });
    }

    await assert.rejects(
      () => store.createTarget({
        label: 'One too many',
        mode: 'local',
        localUrl: 'http://127.0.0.1:5173',
      }),
      (error) => error.status === 409 && /target limit/.test(error.message),
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('configureServe runs Serve commands and reflects detected state; refuses when not signed in', () => {
  const calls = [];
  const onlineRunner = (bin, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'version') return { status: 0, stdout: '1.0' };
    if (args[0] === 'status') return { status: 0, stdout: JSON.stringify({ Self: { DNSName: 'mac.tailnet.ts.net.' } }) };
    if (args[0] === 'serve' && args[1] === 'status') return { status: 0, stdout: 'http://mac.tailnet.ts.net (tailnet only)\n|-- / proxy http://localhost:3000' };
    if (args[0] === 'serve') return { status: 0, stdout: '' };
    return { status: 1, stdout: '' };
  };
  const store = new PrivateAccessStore({ stateFile: null, runner: onlineRunner });
  const enabled = store.configureServe({ action: 'enable', port: 3000 });
  assert.equal(enabled.ok, true);
  assert.ok(calls.includes('serve --bg http://127.0.0.1:3000'), 'enable runs the HTTP serve command');
  assert.equal(enabled.tailnet.servedUrl, 'http://mac.tailnet.ts.net');
  const disabled = store.configureServe({ action: 'disable' });
  assert.ok(calls.includes('serve reset'), 'disable runs serve reset');
  assert.equal(disabled.ok, true);

  const customCalls = [];
  const customRunner = (bin, args) => {
    customCalls.push(args.join(' '));
    if (args[0] === 'version') return { status: 0, stdout: '1.0' };
    if (args[0] === 'status') return { status: 0, stdout: JSON.stringify({ Self: { DNSName: 'mac.tailnet.ts.net.' } }) };
    if (args[0] === 'serve' && args[1] === 'status') return { status: 0, stdout: 'https://mac.tailnet.ts.net (tailnet only)\n|-- / proxy http://localhost:4173' };
    if (args[0] === 'serve') return { status: 0, stdout: '' };
    return { status: 1, stdout: '' };
  };
  const customStore = new PrivateAccessStore({ stateFile: null, runner: customRunner });
  const customEnabled = customStore.configureServe({ action: 'enable', port: 4173 });
  assert.equal(customEnabled.ok, true);
  assert.ok(customCalls.includes('serve --bg http://127.0.0.1:4173'), 'enable uses the requested Orca port');
  assert.equal(customEnabled.tailnet.servedUrl, 'https://mac.tailnet.ts.net');
  assert.equal(customEnabled.tailnet.serveMode, 'tailnet-https-serve');

  // Not signed in -> refuses without running serve.
  const offline = new PrivateAccessStore({ stateFile: null, runner: (bin, args) => (args[0] === 'version' ? { status: 0, stdout: '1.0' } : { status: 1, stdout: '' }) });
  const refused = offline.configureServe({ action: 'enable' });
  assert.equal(refused.ok, false);
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
