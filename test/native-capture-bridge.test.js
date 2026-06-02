import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { PlaywrightEvidenceRunner } from '../src/evidence-runner.js';

// A 1x1 transparent PNG — what the native bridge would normally write.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64',
);

// Stub the Tauri native-capture bridge: token-gated, writes the PNG the client
// asked for, then closes the socket after each response exactly like tiny_http
// does (Connection: close). This is the scenario that broke the old undici
// keep-alive client on the *second* capture.
function startBridgeStub({ token, mode = 'ok' }) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      const authorized = req.headers['x-orca-native-token'] === token;
      const payload = (() => { try { return JSON.parse(body); } catch { return {}; } })();
      seen.push({ url: req.url, authorized, payload, connection: req.headers.connection });
      const finish = (status) => {
        res.setHeader('Connection', 'close'); // mimic tiny_http closing the socket
        res.statusCode = status;
        res.end();
      };
      if (!authorized || req.url !== '/capture') return finish(403);
      if (mode === 'fail') return finish(502);
      if (mode === 'no-write') return finish(200); // 200 but never wrote the PNG
      try {
        await fs.writeFile(payload.outPath, TINY_PNG);
        finish(200);
      } catch {
        finish(500);
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, endpoint: `http://127.0.0.1:${port}`, seen });
    });
  });
}

async function withTempCwd(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-native-capture-'));
  const prevCwd = process.cwd();
  process.chdir(dir);
  try {
    return await run(dir);
  } finally {
    process.chdir(prevCwd);
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function lane(i) {
  return { id: `lane-${i}`, sessionId: 'sess-1', projectId: 'proj-1' };
}

test('native bridge fast-path captures repeatedly without keep-alive errors', async () => {
  const token = 'native-token-abc';
  const { server, endpoint, seen } = await startBridgeStub({ token });
  const prevUrl = process.env.ORCA_NATIVE_CAPTURE_URL;
  const prevToken = process.env.ORCA_NATIVE_CAPTURE_TOKEN;
  process.env.ORCA_NATIVE_CAPTURE_URL = endpoint;
  process.env.ORCA_NATIVE_CAPTURE_TOKEN = token;
  try {
    await withTempCwd(async () => {
      const runner = new PlaywrightEvidenceRunner();
      // Three back-to-back captures: the old undici client failed on #2 because
      // it reused the socket the bridge had just closed.
      for (let i = 0; i < 3; i += 1) {
        const result = await runner.capture(lane(i), {
          modes: ['screenshot'],
          url: 'http://127.0.0.1:7777/some-page',
          timeoutMs: 4000,
        });
        assert.equal(result.captured, true, `capture #${i} should succeed natively`);
        assert.equal(result.evidence.backend, 'native-webview');
        assert.ok(result.files.some((f) => f.endsWith('-shot.png')));
      }
    });
    assert.equal(seen.length, 3, 'bridge should have received all three captures');
    assert.ok(seen.every((s) => s.authorized), 'all requests must carry the native token');
    assert.ok(seen.every((s) => s.connection === 'close'), 'client must request connection: close');
  } finally {
    server.close();
    if (prevUrl === undefined) delete process.env.ORCA_NATIVE_CAPTURE_URL; else process.env.ORCA_NATIVE_CAPTURE_URL = prevUrl;
    if (prevToken === undefined) delete process.env.ORCA_NATIVE_CAPTURE_TOKEN; else process.env.ORCA_NATIVE_CAPTURE_TOKEN = prevToken;
  }
});

test('native bridge 502 degrades to the Playwright path instead of crashing', async () => {
  const token = 'native-token-fail';
  const { server, endpoint } = await startBridgeStub({ token, mode: 'fail' });
  const prevUrl = process.env.ORCA_NATIVE_CAPTURE_URL;
  const prevToken = process.env.ORCA_NATIVE_CAPTURE_TOKEN;
  process.env.ORCA_NATIVE_CAPTURE_URL = endpoint;
  process.env.ORCA_NATIVE_CAPTURE_TOKEN = token;
  try {
    await withTempCwd(async () => {
      const runner = new PlaywrightEvidenceRunner();
      const result = await runner.capture(lane(0), {
        modes: ['screenshot'],
        url: 'http://127.0.0.1:7777/some-page',
        timeoutMs: 4000,
      });
      // Playwright is not installed in the test env, so the fallback degrades
      // gracefully (captured:false) rather than throwing on the native failure.
      assert.equal(result.captured, false);
      assert.notEqual(result.evidence.backend, 'native-webview');
    });
  } finally {
    server.close();
    if (prevUrl === undefined) delete process.env.ORCA_NATIVE_CAPTURE_URL; else process.env.ORCA_NATIVE_CAPTURE_URL = prevUrl;
    if (prevToken === undefined) delete process.env.ORCA_NATIVE_CAPTURE_TOKEN; else process.env.ORCA_NATIVE_CAPTURE_TOKEN = prevToken;
  }
});
