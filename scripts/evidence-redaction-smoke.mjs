#!/usr/bin/env node
/*
 * Command Deck evidence redaction smoke.
 *
 * Verifies that evidence capture refuses sensitive Command Deck control URLs,
 * token-bearing URLs, credentialed URLs, and unsafe private targets before
 * browser automation can run. Also proves safe degraded evidence metadata does
 * not contain auth/provider secret markers.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandDeckRegistry } from '../src/registry.js';
import { validateEvidenceUrl } from '../src/url-policy.js';

const log = (label, info = '') => console.log(`[evidence-redaction] ${label}${info ? ' — ' + info : ''}`);

function assertRejectsSensitive(url, messagePattern) {
  assert.throws(
    () => validateEvidenceUrl(url, {
      allowedUrls: [url],
      oneTimeApproved: true,
    }),
    (error) => error.status === 422 && messagePattern.test(error.message),
  );
}

assertRejectsSensitive('http://127.0.0.1:3000/api/auth/status', /sensitive route/i);
assertRejectsSensitive('http://127.0.0.1:3000/api/providers/openai-compatible/health', /sensitive route/i);
assertRejectsSensitive('http://127.0.0.1:3000/?apiToken=manual-test-token', /sensitive route|token-like/i);
assert.throws(
  () => validateEvidenceUrl('https://user:pass@example.ts.net', {
    allowedUrls: ['https://user:pass@example.ts.net'],
    oneTimeApproved: true,
  }),
  (error) => error.status === 422 && /credentials/i.test(error.message),
);
assert.throws(
  () => validateEvidenceUrl('http://169.254.169.254/latest/meta-data', {
    allowedUrls: ['http://169.254.169.254/latest/meta-data'],
    oneTimeApproved: true,
  }),
  (error) => error.status === 422 && /blocked private|metadata/i.test(error.message),
);

const previousCwd = process.cwd();
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'command-deck-evidence-smoke-'));
process.chdir(tempDir);
try {
  const registry = new CommandDeckRegistry({ heartbeatIntervalMs: 5 });
  try {
    const project = registry.createProject({
      name: 'Evidence Redaction',
      quickLinks: [{ label: 'Safe app', url: 'http://127.0.0.1:4173/' }],
    }, { actor: 'smoke', approved: true });
    const session = registry.createSession(project.id, {
      name: 'Evidence session',
    }, { actor: 'smoke', approved: true });
    const lane = registry.createLane(session.id, {
      title: 'Evidence lane',
      executorType: 'mock',
      targetUrl: 'http://127.0.0.1:4173/',
    }, { actor: 'smoke', approved: true });

    await assert.rejects(
      () => registry.captureLaneEvidence(lane.id, {
        url: 'http://127.0.0.1:4173/api/auth/status',
        modes: ['screenshot'],
        approved: true,
        oneTimeUrlApproved: true,
      }),
      (error) => error.status === 422 && /sensitive route/i.test(error.message),
    );

    const result = await registry.captureLaneEvidence(lane.id, {
      url: 'http://127.0.0.1:4173/',
      modes: ['log'],
      approved: true,
    });
    const serialized = JSON.stringify(result);
    for (const forbidden of [
      'COMMAND_DECK_API_TOKEN',
      'COMMAND_DECK_WORKER_TOKEN',
      'apiKey',
      'sessionToken',
      'manual-test-token',
      'sk-command-deck',
    ]) {
      assert.equal(serialized.includes(forbidden), false, `evidence response leaked ${forbidden}`);
    }
    assert.notEqual(registry.getLane(lane.id).lastEvidence.sensitive, true);
    assert.equal(registry.listAuditEvents({ laneId: lane.id }).some((event) => event.type === 'lane_evidence_captured' || event.type === 'lane_evidence_failed'), true);
  } finally {
    registry.stopScheduler();
    await registry.drainPendingWrites();
  }
  log('done', 'sensitive evidence routes are refused and safe metadata is redacted');
} finally {
  process.chdir(previousCwd);
  await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
}
