#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const artifactDir = path.join(root, 'artifacts', 'completion-audit');
const artifactPath = path.join(artifactDir, 'completion-audit-summary.json');

function readJson(relativePath) {
  const file = path.join(root, relativePath);
  if (!existsSync(file)) return { exists: false, path: relativePath, data: null };
  try {
    return { exists: true, path: relativePath, data: JSON.parse(readFileSync(file, 'utf8')) };
  } catch (error) {
    return { exists: true, path: relativePath, error: error.message, data: null };
  }
}

function readText(relativePath) {
  const file = path.join(root, relativePath);
  if (!existsSync(file)) return { exists: false, path: relativePath, text: '' };
  return { exists: true, path: relativePath, text: readFileSync(file, 'utf8') };
}

function gitStatus() {
  try {
    return execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' }).trim();
  } catch (error) {
    return `git status failed: ${error.message}`;
  }
}

function parseLedger(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const match = line.match(/^\| `([^`]+)` \| `([^`]+)` \|/);
    if (match) rows.push({ area: match[1], status: match[2] });
  }
  const counts = rows.reduce((acc, row) => {
    acc[row.status] = (acc[row.status] || 0) + 1;
    return acc;
  }, {});
  return {
    rows,
    counts,
    incomplete: rows.filter((row) => row.status !== 'implemented_and_proven'),
  };
}

function requirement(id, status, evidence, blocker = null) {
  return { id, status, evidence, blocker };
}

const acceptance = readJson('artifacts/acceptance/acceptance-summary.json');
const phone = readJson('artifacts/operator-phone-check/phone-check-summary.json');
const ledgerFile = readText('docs/full-buildout-ledger.md');
const ledger = ledgerFile.exists ? parseLedger(ledgerFile.text) : { rows: [], counts: {}, incomplete: [] };
const statusText = gitStatus();

const requirements = [];
requirements.push(requirement(
  'acceptance_matrix',
  acceptance.data?.status === 'passed' ? 'proven' : 'missing_or_failed',
  acceptance.exists
    ? { artifact: acceptance.path, status: acceptance.data?.status || null, steps: acceptance.data?.steps?.length || 0 }
    : { artifact: acceptance.path, exists: false },
));
requirements.push(requirement(
  'full_buildout_ledger',
  ledger.incomplete.some((row) => ['missing', 'implemented_not_proven'].includes(row.status)) ? 'incomplete' : 'proven_with_external_blockers',
  { artifact: ledgerFile.path, counts: ledger.counts, incomplete: ledger.incomplete },
));
requirements.push(requirement(
  'phone_preflight',
  phone.data?.status === 'passed' ? 'proven_preflight_only' : 'missing_or_failed',
  phone.exists
    ? { artifact: phone.path, status: phone.data?.status || null, pairingCodeStored: phone.data?.pairing?.codeStored ?? null }
    : { artifact: phone.path, exists: false },
  phone.data?.status === 'passed' ? 'real phone-side browser confirmation still manual' : null,
));
requirements.push(requirement(
  'repo_cleanliness',
  statusText ? 'dirty' : 'clean',
  { gitStatusShort: statusText || '' },
));
requirements.push(requirement(
  'native_packaging',
  'external_later_phase',
  { policy: 'PWA phone-first is v1; native Tauri/iOS/Android requires explicit product approval.' },
  'later product phase',
));

const hasMissingOrFailed = requirements.some((item) => ['missing_or_failed', 'incomplete', 'dirty'].includes(item.status));
const externalBlockers = ledger.incomplete.filter((row) => row.status === 'externally_blocked').map((row) => row.area);
const summary = {
  kind: 'orca.completion-audit-summary',
  generatedAt: new Date().toISOString(),
  status: hasMissingOrFailed ? 'local_requirements_incomplete' : externalBlockers.length ? 'local_ready_external_manual_required' : 'complete',
  requirements,
  externalBlockers,
  nextActions: externalBlockers.includes('private-access-tailscale')
    ? ['Confirm the private URL loads from the user phone on the same tailnet and pairing succeeds.']
    : [],
};

mkdirSync(artifactDir, { recursive: true });
writeFileSync(artifactPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(`[operator-completion-audit] status — ${summary.status}`);
console.log(`[operator-completion-audit] summary — ${artifactPath}`);
if (summary.nextActions.length) {
  for (const action of summary.nextActions) console.log(`[operator-completion-audit] next — ${action}`);
}
if (hasMissingOrFailed) process.exitCode = 1;
