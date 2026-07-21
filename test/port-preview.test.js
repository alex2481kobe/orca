// Port-preview-over-Tailscale backend coverage: the pure tailnetUrlForPort
// helper, the quick-link upsert auto-filling tailnetHttpUrl from a known
// MagicDNS name, and the read-only overview `previews` projection. Reuses the
// isolated-registry harness pattern from agent-tools.test.js.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  tailnetUrlForPort,
  effectiveQuickLinkUrl,
} from '../src/registry-quick-links.js';
import { OrcaRegistry } from '../src/registry.js';

async function withIsolatedRegistry(callback) {
  const previousCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-port-preview-'));
  process.chdir(tempDir);
  const registry = new OrcaRegistry({ autoCompleteMs: 60 * 60 * 1000 });
  try {
    return await callback(registry, tempDir);
  } finally {
    registry.stopScheduler();
    if (typeof registry.drainPendingWrites === 'function') {
      await registry.drainPendingWrites();
    }
    process.chdir(previousCwd);
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
}

test('tailnetUrlForPort builds http://<magicDns>:<port> and degrades gracefully', () => {
  assert.equal(
    tailnetUrlForPort(5173, 'orca.example.ts.net'),
    'http://orca.example.ts.net:5173',
  );
  // Trailing dot on the MagicDNS name is trimmed; healthPath is appended.
  assert.equal(
    tailnetUrlForPort(3000, 'orca.example.ts.net.', { healthPath: 'readyz' }),
    'http://orca.example.ts.net:3000/readyz',
  );
  assert.equal(
    tailnetUrlForPort('8080', 'orca.example.ts.net', { healthPath: '/healthz' }),
    'http://orca.example.ts.net:8080/healthz',
  );

  // Blank whenever either input is missing.
  assert.equal(tailnetUrlForPort(5173, ''), '');
  assert.equal(tailnetUrlForPort(5173, null), '');
  assert.equal(tailnetUrlForPort(null, 'orca.example.ts.net'), '');

  // Out-of-range / non-numeric ports are rejected.
  assert.equal(tailnetUrlForPort(0, 'orca.example.ts.net'), '');
  assert.equal(tailnetUrlForPort(65536, 'orca.example.ts.net'), '');
  assert.equal(tailnetUrlForPort(-1, 'orca.example.ts.net'), '');
  assert.equal(tailnetUrlForPort('not-a-port', 'orca.example.ts.net'), '');
});

test('quick-link upsert auto-fills tailnetHttpUrl from the workstation MagicDNS name', async () => {
  await withIsolatedRegistry(async (registry, cwd) => {
    // Inject a known MagicDNS name so the test never shells out to tailscale.
    registry.magicDnsResolver = () => 'orca.example.ts.net';

    const orchestrator = await registry.registerOrchestrator(
      { cwd, actor: 'claude', title: 'Preview work' },
      { leaseId: 'dashboard' },
    );
    const projectId = orchestrator.projectId;

    // A bare {port, label} dev-server registration, exactly what an orchestrator
    // sends through project.quick_link.upsert / POST .../quick-links.
    const { link } = registry.upsertProjectQuickLink(
      projectId,
      { port: 5173, label: 'Vite dev server' },
      { actor: 'claude', approved: true },
    );

    assert.equal(link.port, 5173);
    assert.equal(link.kind, 'dev-server');
    assert.equal(link.label, 'Vite dev server');
    // Loopback localUrl implied so the link still works on the host.
    assert.equal(link.localUrl, 'http://127.0.0.1:5173/');
    // Tailnet preview URL auto-filled from the MagicDNS name (URL-normalized).
    assert.equal(link.tailnetHttpUrl, 'http://orca.example.ts.net:5173/');
    assert.equal(effectiveQuickLinkUrl(link, { prefer: 'tailnet' }), 'http://orca.example.ts.net:5173/');

    // An explicit tailnetHttpUrl supplied by the caller is never overwritten.
    const { link: pinned } = registry.upsertProjectQuickLink(
      projectId,
      { port: 4000, label: 'Docs', tailnetHttpUrl: 'http://custom.example.ts.net:4000' },
      { actor: 'claude', approved: true },
    );
    assert.equal(pinned.tailnetHttpUrl, 'http://custom.example.ts.net:4000/');
  });
});

test('quick-link upsert leaves tailnetHttpUrl blank when MagicDNS is unknown', async () => {
  await withIsolatedRegistry(async (registry, cwd) => {
    // Tailscale down: resolver yields no name -> graceful blank, localUrl still set.
    registry.magicDnsResolver = () => '';

    const orchestrator = await registry.registerOrchestrator(
      { cwd, actor: 'claude', title: 'Preview work' },
      { leaseId: 'dashboard' },
    );

    const { link } = registry.upsertProjectQuickLink(
      orchestrator.projectId,
      { port: 5173, label: 'Vite dev server' },
      { actor: 'claude', approved: true },
    );

    assert.equal(link.tailnetHttpUrl, '');
    assert.equal(link.localUrl, 'http://127.0.0.1:5173/');
    assert.equal(link.kind, 'dev-server');
  });
});

test('buildOverview projects secret-free port previews for dev-server quick links', async () => {
  await withIsolatedRegistry(async (registry, cwd) => {
    registry.magicDnsResolver = () => 'orca.example.ts.net';

    const orchestrator = await registry.registerOrchestrator(
      { cwd, actor: 'claude', title: 'Preview work' },
      { leaseId: 'dashboard' },
    );
    registry.upsertProjectQuickLink(
      orchestrator.projectId,
      { port: 5173, label: 'Vite dev server' },
      { actor: 'claude', approved: true },
    );
    // A hidden link must be omitted from previews.
    registry.upsertProjectQuickLink(
      orchestrator.projectId,
      { port: 9999, label: 'Hidden internal', hidden: true },
      { actor: 'claude', approved: true },
    );

    const overview = registry.buildOverview();
    assert.equal(overview.projects.length, 1);
    const project = overview.projects[0];

    assert.equal(Array.isArray(project.previews), true);
    assert.equal(project.previews.length, 1, 'hidden links are omitted');

    const preview = project.previews[0];
    assert.equal(preview.label, 'Vite dev server');
    assert.equal(preview.port, 5173);
    assert.equal(preview.kind, 'dev-server');
    assert.equal(preview.tailnetUrl, 'http://orca.example.ts.net:5173/');
    assert.equal(preview.url, 'http://orca.example.ts.net:5173/', 'preview url prefers the tailnet URL');
    assert.equal(preview.localUrl, 'http://127.0.0.1:5173/');
    assert.equal(typeof preview.healthStatus, 'string');

    // The projection must expose no secrets / internal fields.
    assert.equal(Object.prototype.hasOwnProperty.call(preview, 'leaseId'), false);
    assert.equal(JSON.stringify(overview).includes('leaseId'), false);
  });
});
