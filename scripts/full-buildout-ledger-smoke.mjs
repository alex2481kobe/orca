#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const ledgerPath = path.resolve('docs', 'full-buildout-ledger.md');
const allowedStatuses = new Set([
  'implemented_and_proven',
  'implemented_not_proven',
  'missing',
  'externally_blocked',
]);

const requiredAreas = [
  'ui-design-system',
  'route-security-matrix',
  'auth-pairing-sessions',
  'credentials-os-env',
  'provider-profiles',
  'codex-claude-cli',
  'custom-cli-provider',
  'api-provider-execution',
  'process-lifecycle-worktrees',
  'orchestration-capacity-audit',
  'critique-self-verification',
  'mcp-tool-contract',
  'evidence-artifacts',
  'artifact-path-security',
  'private-access-tailscale',
  'pwa-static-cache',
  'notifications',
  'app-backup-support',
  'cleanup-retention',
  'state-migrations-recovery',
  'streaming-live-updates',
  'security-headers-rate-ssrf',
  'mobile-screenshots-flow',
  'full-flow-smoke',
  'native-packaging-tauri',
];

function fail(label, detail = '') {
  console.error(`[full-buildout-ledger FAIL] ${label}${detail ? ' — ' + detail : ''}`);
  process.exitCode = 1;
  throw new Error(`${label}${detail ? `: ${detail}` : ''}`);
}

function log(label, detail = '') {
  console.log(`[full-buildout-ledger] ${label}${detail ? ' — ' + detail : ''}`);
}

function stripTicks(value) {
  return String(value || '').trim().replace(/^`|`$/g, '').trim();
}

function parseRows(markdown) {
  const rows = [];
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('| `')) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length !== 7) {
      fail('ledger row must have exactly 7 cells', line);
    }
    rows.push({
      area: stripTicks(cells[0]),
      status: stripTicks(cells[1]),
      code: cells[2],
      ui: cells[3],
      proof: cells[4],
      evidence: cells[5],
      blocker: cells[6],
    });
  }
  return rows;
}

const markdown = await fs.readFile(ledgerPath, 'utf8');
if (!markdown.includes('Allowed status values')) {
  fail('ledger must document allowed status values');
}
for (const status of allowedStatuses) {
  if (!markdown.includes(`\`${status}\``)) {
    fail('ledger missing allowed status definition', status);
  }
}

const rows = parseRows(markdown);
const byArea = new Map();
for (const row of rows) {
  if (byArea.has(row.area)) fail('duplicate ledger area', row.area);
  byArea.set(row.area, row);
  if (!allowedStatuses.has(row.status)) fail('invalid status', `${row.area}: ${row.status}`);
  for (const key of ['code', 'ui', 'proof', 'evidence', 'blocker']) {
    if (!row[key] || row[key].toLowerCase() === 'todo') {
      fail('ledger row has empty or todo cell', `${row.area}: ${key}`);
    }
  }
  if (row.status === 'implemented_and_proven') {
    if (!/npm run|npm test|test\//.test(row.proof)) {
      fail('implemented_and_proven row needs concrete proof command/test', row.area);
    }
    if (row.blocker.toLowerCase() !== 'none') {
      fail('implemented_and_proven row must have blocker "none"', row.area);
    }
  }
  if (row.status === 'implemented_not_proven' && row.blocker.toLowerCase() === 'none') {
    fail('implemented_not_proven row must name remaining proof gap', row.area);
  }
  if (row.status === 'missing' && row.blocker.toLowerCase() === 'none') {
    fail('missing row must name missing work', row.area);
  }
  if (row.status === 'externally_blocked' && !/external|approval|setup|manual|later-phase/i.test(row.blocker)) {
    fail('externally_blocked row must name external blocker', row.area);
  }
}

const missingAreas = requiredAreas.filter((area) => !byArea.has(area));
if (missingAreas.length) {
  fail('ledger missing required areas', missingAreas.join(', '));
}

const statusCounts = rows.reduce((counts, row) => {
  counts[row.status] = (counts[row.status] || 0) + 1;
  return counts;
}, {});
const incomplete = rows.filter((row) => row.status !== 'implemented_and_proven');

log('rows', `${rows.length} area(s)`);
log('status', JSON.stringify(statusCounts));
if (incomplete.length) {
  log('incomplete', incomplete.map((row) => `${row.area}:${row.status}`).join(', '));
}
log('done', 'ledger contract is valid');
