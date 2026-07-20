import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OrcaRegistry } from '../src/registry.js';
import {
  classifyHost,
  validateEvidenceUrl,
  validateNetworkUrl,
} from '../src/url-policy.js';

async function withRegistry(callback) {
  const previousCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-url-policy-'));
  let registry = null;
  process.chdir(tempDir);
  try {
    registry = new OrcaRegistry();
    await callback(registry);
  } finally {
    if (registry && typeof registry.stopScheduler === 'function') registry.stopScheduler();
    process.chdir(previousCwd);
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
}

test('network URL policy allows loopback and tailnet while rejecting SSRF targets', () => {
  assert.equal(classifyHost('127.0.0.1'), 'loopback');
  assert.equal(classifyHost('localhost'), 'loopback');
  assert.equal(classifyHost('orca.example.ts.net'), 'tailnet');
  assert.equal(classifyHost('100.64.1.2'), 'tailnet');

  assert.equal(validateNetworkUrl('http://127.0.0.1:3000').hostClass, 'loopback');
  assert.equal(validateNetworkUrl('https://orca.example.ts.net').hostClass, 'tailnet');
  assert.equal(validateNetworkUrl('http://100.64.1.2:3000').hostClass, 'tailnet');

  assert.throws(
    () => validateNetworkUrl('file:///tmp/nope'),
    (error) => error.status === 422 && /http or https/.test(error.message),
  );
  assert.throws(
    () => validateNetworkUrl('https://user:pass@orca.example.ts.net'),
    (error) => error.status === 422 && /credentials/.test(error.message),
  );
  assert.throws(
    () => validateNetworkUrl('http://169.254.169.254/latest/meta-data'),
    (error) => error.status === 422 && /blocked private/.test(error.message),
  );
  assert.throws(
    () => validateNetworkUrl('http://192.168.1.10:3000'),
    (error) => error.status === 422 && /blocked private/.test(error.message),
  );
  assert.throws(
    () => validateNetworkUrl('http://metadata.google.internal/computeMetadata/v1'),
    (error) => error.status === 422 && /blocked private/.test(error.message),
  );
  assert.throws(
    () => validateNetworkUrl('https://public.example.com'),
    (error) => error.status === 422 && /localhost/.test(error.message),
  );
  assert.throws(
    () => validateNetworkUrl('https://orca.funnel.ts.net'),
    (error) => error.status === 422 && /Funnel/.test(error.message),
  );
});

test('evidence URL policy requires saved URLs or explicit one-time approval', () => {
  const saved = 'http://127.0.0.1:4173/';
  const allowed = validateEvidenceUrl(saved, {
    allowedUrls: [saved],
  });
  assert.equal(allowed.savedUrl, true);
  assert.equal(allowed.oneTimeApproved, false);

  assert.throws(
    () => validateEvidenceUrl('http://127.0.0.1:5173', {
      allowedUrls: [saved],
    }),
    (error) => error.status === 422 && /one-time/.test(error.message),
  );

  const oneTime = validateEvidenceUrl('http://127.0.0.1:5173', {
    allowedUrls: [saved],
    oneTimeApproved: true,
  });
  assert.equal(oneTime.savedUrl, false);
  assert.equal(oneTime.oneTimeApproved, true);

  assert.throws(
    () => validateEvidenceUrl('http://127.0.0.1:3000/api/auth/status', {
      allowedUrls: ['http://127.0.0.1:3000/api/auth/status'],
    }),
    (error) => error.status === 422 && /sensitive route/.test(error.message),
  );
});

test('registry rejects unsafe lane target URLs before browser work', async () => {
  await withRegistry(async (registry) => {
    const project = registry.createProject({
      name: 'SSRF Project',
      quickLinks: [{ label: 'Safe local app', url: 'http://127.0.0.1:4173/' }],
    }, { actor: 'test', approved: true });
    const session = registry.createSession(project.id, {
      name: 'SSRF Session',
    }, { actor: 'test', approved: true });

    assert.throws(
      () => registry.createLane(session.id, {
        title: 'Bad target',
        executorType: 'mock',
        targetUrl: 'http://169.254.169.254/latest/meta-data',
      }, { actor: 'test', approved: true }),
      (error) => error.status === 422 && /blocked private/.test(error.message),
    );

    // A safe loopback target is accepted by the same url-policy validation.
    registry.createLane(session.id, {
      title: 'Safe target',
      executorType: 'mock',
      targetUrl: 'http://127.0.0.1:4173/',
    }, { actor: 'test', approved: true });
  });
});
