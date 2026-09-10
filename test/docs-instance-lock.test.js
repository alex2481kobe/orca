import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Live docs must not describe a limitation the code no longer has. Once
// src/instance-lock.js exists, a second start against a running daemon's
// working directory is refused, so no live doc may still say there is "no
// instance lock yet". Dated audit records in docs/audits/ describe the past and
// are exempt. Wording wraps across lines in Markdown, so whitespace (newlines,
// list indentation) is collapsed before matching.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCK_SOURCE = path.join(ROOT, 'src', 'instance-lock.js');

const STALE_CLAIMS = [
  /\bno instance lock\b/i,
  /\binstance lock yet\b/i,
  /\block yet\b/i,
];

function markdownUnder(dir, excluded) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (full !== excluded) found.push(...markdownUnder(full, excluded));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      found.push(full);
    }
  }
  return found;
}

function liveDocs() {
  const docsDir = path.join(ROOT, 'docs');
  return [
    path.join(ROOT, 'AGENTS.md'),
    path.join(ROOT, 'README.md'),
    ...markdownUnder(docsDir, path.join(docsDir, 'audits')),
  ].filter((file) => fs.existsSync(file));
}

test('live docs do not claim there is no instance lock while src/instance-lock.js exists', (t) => {
  if (!fs.existsSync(LOCK_SOURCE)) {
    t.skip('src/instance-lock.js does not exist');
    return;
  }
  const docs = liveDocs().map((file) => path.relative(ROOT, file));
  // Guard against passing vacuously: the scan must actually reach the docs that
  // carried the stale claim, and must not reach the exempt audit records.
  for (const required of [
    'AGENTS.md',
    'README.md',
    'docs/macos-launchd-runbook.md',
    'docs/tailscale-mobile-access.md',
    'docs/agent-orchestrator-skill.md',
  ]) {
    assert.ok(docs.includes(required), `doc scan did not reach ${required}`);
  }
  assert.ok(!docs.some((file) => file.startsWith(`docs${path.sep}audits${path.sep}`)), 'docs/audits/ must be exempt');

  const offenders = [];
  for (const rel of docs) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\s+/g, ' ');
    for (const pattern of STALE_CLAIMS) {
      const match = pattern.exec(text);
      if (match) {
        const start = Math.max(0, match.index - 60);
        offenders.push(`${rel}: "…${text.slice(start, match.index + match[0].length + 20).trim()}…"`);
        break;
      }
    }
  }
  assert.deepEqual(offenders, [], `Live docs still claim there is no instance lock:\n${offenders.join('\n')}`);
});

test('the stale-claim matcher needs whitespace normalised to see wrapped wording', () => {
  // Broken at every word, so no pattern matches the raw text: only the
  // normalisation the guard applies can catch it.
  const wrapped = 'There is no\n  instance\n  lock\n  yet, so stop the existing daemon first.';
  assert.ok(!STALE_CLAIMS.some((pattern) => pattern.test(wrapped)), 'sample must not match unnormalised');
  const normalized = wrapped.replace(/\s+/g, ' ');
  for (const pattern of STALE_CLAIMS) assert.ok(pattern.test(normalized), String(pattern));
});
