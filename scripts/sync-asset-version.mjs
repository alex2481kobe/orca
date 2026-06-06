#!/usr/bin/env node
/*
 * Single source of truth for the static-asset version. The service worker's
 * CACHE_NAME (precache bucket) and index.html's ?v= cache-buster MUST share one
 * token, or a release can ship a new CACHE_NAME while the browser keeps loading
 * the old ?v= document (or vice versa) — the "I deployed but see no change" bug.
 *
 * Usage:
 *   node scripts/sync-asset-version.mjs <version>   # set both to <version>
 *   node scripts/sync-asset-version.mjs             # print the current token(s)
 *
 * The pwa-cache smoke enforces that the two stay equal.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const swPath = path.join(root, 'public', 'service-worker.js');
const indexPath = path.join(root, 'public', 'index.html');

const SW_RE = /const CACHE_NAME = 'orca-static-([^']+)';/;
const INDEX_RE = /\?v=([A-Za-z0-9._-]+)/g;

function readTokens() {
  const sw = fs.readFileSync(swPath, 'utf8');
  const index = fs.readFileSync(indexPath, 'utf8');
  const swToken = (sw.match(SW_RE) || [])[1] || null;
  const indexTokens = [...index.matchAll(INDEX_RE)].map((m) => m[1]);
  return { swToken, indexTokens };
}

const version = process.argv[2];
if (!version) {
  const { swToken, indexTokens } = readTokens();
  console.log(`service-worker CACHE_NAME token: ${swToken}`);
  console.log(`index.html ?v= token(s): ${[...new Set(indexTokens)].join(', ') || '(none)'}`);
  process.exit(0);
}
if (!/^[A-Za-z0-9._-]+$/.test(version)) {
  console.error(`[sync-asset-version] invalid version "${version}" — use [A-Za-z0-9._-]`);
  process.exit(1);
}

let sw = fs.readFileSync(swPath, 'utf8');
if (!SW_RE.test(sw)) {
  console.error('[sync-asset-version] could not find CACHE_NAME in service-worker.js');
  process.exit(1);
}
sw = sw.replace(SW_RE, `const CACHE_NAME = 'orca-static-${version}';`);
fs.writeFileSync(swPath, sw);

let index = fs.readFileSync(indexPath, 'utf8');
index = index.replace(INDEX_RE, `?v=${version}`);
fs.writeFileSync(indexPath, index);

console.log(`[sync-asset-version] set CACHE_NAME + index.html ?v= to "${version}"`);
