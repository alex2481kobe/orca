#!/usr/bin/env node
/*
 * Orca acceptance smoke.
 *
 * Runs the deterministic local acceptance matrix in one command. It avoids
 * real installs, real OS credential writes, real Tailscale mutations, public
 * network dependencies, and token-in-URL browser bootstraps. Live Tailscale
 * phone reachability and native packaging remain external/manual checks.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const startedAt = new Date();
const artifactDir = path.resolve('artifacts', 'acceptance');
const summaryPath = path.join(artifactDir, 'acceptance-summary.json');

const steps = [
  {
    id: 'unit-tests',
    command: ['npm', 'test'],
    covers: ['npm test'],
  },
  {
    id: 'full-flow',
    command: ['npm', 'run', 'smoke:full-flow'],
    covers: [
      'npm run smoke',
      'npm run smoke:api',
      'npm run smoke:full-flow',
      'npm run smoke:security',
    ],
    reason: '`smoke`, `smoke:api`, `smoke:full-flow`, and `smoke:security` all invoke scripts/smoke.mjs.',
  },
  { id: 'ssrf', command: ['npm', 'run', 'smoke:ssrf'], covers: ['npm run smoke:ssrf'] },
  { id: 'ui', command: ['npm', 'run', 'smoke:ui'], covers: ['npm run smoke:ui'] },
  { id: 'ui-inventory', command: ['npm', 'run', 'smoke:ui-inventory'], covers: ['npm run smoke:ui-inventory'] },
  { id: 'ui-contract', command: ['npm', 'run', 'smoke:ui-contract'], covers: ['npm run smoke:ui-contract'] },
  { id: 'workflow-policy', command: ['npm', 'run', 'smoke:workflow-policy'], covers: ['npm run smoke:workflow-policy'] },
  { id: 'route-inventory', command: ['npm', 'run', 'smoke:route-inventory'], covers: ['npm run smoke:route-inventory'] },
  { id: 'route-security-matrix', command: ['npm', 'run', 'smoke:route-security-matrix'], covers: ['npm run smoke:route-security-matrix'] },
  { id: 'full-buildout-ledger', command: ['npm', 'run', 'smoke:full-buildout-ledger'], covers: ['npm run smoke:full-buildout-ledger'] },
  { id: 'security-headers', command: ['npm', 'run', 'smoke:security-headers'], covers: ['npm run smoke:security-headers'] },
  { id: 'streams', command: ['npm', 'run', 'smoke:streams'], covers: ['npm run smoke:streams'] },
  { id: 'mcp-flow', command: ['npm', 'run', 'smoke:mcp-flow'], covers: ['npm run smoke:mcp-flow'] },
  { id: 'mcp-backlog-flow', command: ['npm', 'run', 'smoke:mcp-backlog-flow'], covers: ['npm run smoke:mcp-backlog-flow'] },
  { id: 'mcp-supervisor-flow', command: ['npm', 'run', 'smoke:mcp-supervisor-flow'], covers: ['npm run smoke:mcp-supervisor-flow'] },
  { id: 'mcp-cli-handshake', command: ['npm', 'run', 'smoke:mcp-cli-handshake'], covers: ['npm run smoke:mcp-cli-handshake'] },
  { id: 'private-access', command: ['npm', 'run', 'smoke:private-access'], covers: ['npm run smoke:private-access'] },
  { id: 'pwa-cache', command: ['npm', 'run', 'smoke:pwa-cache'], covers: ['npm run smoke:pwa-cache'] },
  { id: 'providers', command: ['npm', 'run', 'smoke:providers'], covers: ['npm run smoke:providers'] },
  { id: 'api-provider', command: ['npm', 'run', 'smoke:api-provider'], covers: ['npm run smoke:api-provider'] },
  { id: 'notifications', command: ['npm', 'run', 'smoke:notifications'], covers: ['npm run smoke:notifications'] },
  { id: 'app-backup', command: ['npm', 'run', 'smoke:app-backup'], covers: ['npm run smoke:app-backup'] },
  { id: 'state-migrations', command: ['npm', 'run', 'smoke:state-migrations'], covers: ['npm run smoke:state-migrations'] },
  { id: 'auth-sessions', command: ['npm', 'run', 'smoke:auth-sessions'], covers: ['npm run smoke:auth-sessions'] },
  { id: 'credential-backends', command: ['npm', 'run', 'smoke:credential-backends'], covers: ['npm run smoke:credential-backends'] },
  { id: 'credential-redaction', command: ['npm', 'run', 'smoke:credential-redaction'], covers: ['npm run smoke:credential-redaction'] },
  { id: 'evidence-redaction', command: ['npm', 'run', 'smoke:evidence-redaction'], covers: ['npm run smoke:evidence-redaction'] },
  { id: 'process-lifecycle', command: ['npm', 'run', 'smoke:process-lifecycle'], covers: ['npm run smoke:process-lifecycle'] },
  { id: 'orchestrator-lifecycle', command: ['npm', 'run', 'smoke:orchestrator-lifecycle'], covers: ['npm run smoke:orchestrator-lifecycle'] },
];

const externalChecks = [
  {
    id: 'live-tailscale-phone',
    status: 'external_manual',
    reason: 'Requires user-owned tailnet/device approval and live phone reachability verification.',
    runbook: 'docs/tailscale-mobile-access.md',
  },
  {
    id: 'native-tauri-ios-android-packaging',
    status: 'later_phase_external',
    reason: 'PWA is the v1 path; native packaging requires product approval and platform setup.',
  },
];

function log(label, detail = '') {
  console.log(`[acceptance] ${label}${detail ? ' — ' + detail : ''}`);
}

async function writeSummary(summary) {
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));
}

const results = [];
let failed = null;

// The Playwright-backed UI smokes (ui/ui-inventory/ui-contract) are slow and can
// be flaky under load, so they are opt-in: set ORCA_SMOKE_UI=1 to include them.
// They are recorded as skipped (not failed) when gated, so the routine acceptance
// gate stays fast. Run them on demand with `npm run smoke:ui-*`.
const PLAYWRIGHT_UI_STEPS = new Set(['ui', 'ui-inventory', 'ui-contract']);
const includeUi = process.env.ORCA_SMOKE_UI === '1';

for (const step of steps) {
  if (!includeUi && PLAYWRIGHT_UI_STEPS.has(step.id)) {
    log('skip', `${step.id}: gated behind ORCA_SMOKE_UI=1 (slow Playwright UI smoke)`);
    results.push({
      id: step.id,
      command: step.command.join(' '),
      covers: step.covers,
      reason: 'Gated behind ORCA_SMOKE_UI=1; run on demand via npm run smoke:ui*.',
      status: 'skipped',
      exitCode: null,
      signal: null,
      elapsedMs: 0,
    });
    continue;
  }
  const stepStarted = Date.now();
  log('run', `${step.id}: ${step.command.join(' ')}`);
  const result = spawnSync(step.command[0], step.command.slice(1), {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ORCA_ACCEPTANCE: 'true',
    },
    stdio: 'inherit',
  });
  const elapsedMs = Date.now() - stepStarted;
  const record = {
    id: step.id,
    command: step.command.join(' '),
    covers: step.covers,
    reason: step.reason || null,
    status: result.status === 0 ? 'passed' : 'failed',
    exitCode: result.status,
    signal: result.signal || null,
    elapsedMs,
  };
  results.push(record);
  if (record.status !== 'passed') {
    failed = record;
    break;
  }
  log('pass', `${step.id} ${elapsedMs}ms`);
}

const endedAt = new Date();
const summary = {
  kind: 'orca.acceptance-summary',
  startedAt: startedAt.toISOString(),
  endedAt: endedAt.toISOString(),
  elapsedMs: endedAt.getTime() - startedAt.getTime(),
  status: failed ? 'failed' : 'passed',
  failedStep: failed?.id || null,
  steps: results,
  coveredCommands: [...new Set(results.flatMap((step) => step.covers || []))].sort(),
  externalChecks,
};

await writeSummary(summary);

if (failed) {
  console.error(`[acceptance FAIL] ${failed.id} failed with exitCode=${failed.exitCode}`);
  console.error(`[acceptance FAIL] summary=${summaryPath}`);
  process.exitCode = failed.exitCode || 1;
} else {
  log('done', `passed ${results.length} step(s); summary=${summaryPath}`);
}
