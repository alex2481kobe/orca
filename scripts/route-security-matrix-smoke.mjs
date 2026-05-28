#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROUTE_INVENTORY } from '../src/route-inventory.js';

const matrixPath = path.resolve('docs', 'route-security-matrix.md');
const requiredColumns = [
  'Method',
  'Route',
  'Auth',
  'CSRF / Origin',
  'Token / Lease',
  'Risk',
  'Body limit',
  'Rate limit',
  'Validation',
  'Cache',
  'Audit',
  'UI',
  'Mobile',
  'Smoke',
];

const fail = (label, detail = '') => {
  console.error(`[route-security-matrix FAIL] ${label}${detail ? ' — ' + detail : ''}`);
  process.exitCode = 1;
  throw new Error(`${label}${detail ? `: ${detail}` : ''}`);
};

const log = (label, detail = '') => {
  console.log(`[route-security-matrix] ${label}${detail ? ' — ' + detail : ''}`);
};

function routeKey(route) {
  return `${route.method} ${route.route}`;
}

function parseMatrixRows(markdown) {
  const rows = new Map();
  for (const line of markdown.split('\n')) {
    const match = line.match(/^\|\s*`([A-Z]+)`\s*\|\s*`([^`]+)`\s*\|/);
    if (!match) continue;
    rows.set(`${match[1]} ${match[2]}`, line);
  }
  return rows;
}

const markdown = await fs.readFile(matrixPath, 'utf8');

for (const column of requiredColumns) {
  if (!markdown.includes(column)) {
    fail('matrix missing required column', column);
  }
}

const matrixRows = parseMatrixRows(markdown);
const inventoryKeys = new Set(ROUTE_INVENTORY.map(routeKey));
const missing = [...inventoryKeys].filter((key) => !matrixRows.has(key));
if (missing.length) {
  fail('matrix missing route rows', missing.join(', '));
}

const extra = [...matrixRows.keys()].filter((key) => !inventoryKeys.has(key));
if (extra.length) {
  fail('matrix documents routes not present in inventory', extra.join(', '));
}

for (const route of ROUTE_INVENTORY) {
  const row = matrixRows.get(routeKey(route));
  if (!row) continue;
  const smokeItems = Array.isArray(route.smokeCoverage) ? route.smokeCoverage : [];
  if (!smokeItems.length || !smokeItems.some((item) => row.includes(item))) {
    fail('matrix row missing smoke coverage', routeKey(route));
  }
  if (!row.includes(route.auth)) fail('matrix row missing auth contract', routeKey(route));
  if (!row.includes(route.mutationRisk)) fail('matrix row missing risk contract', routeKey(route));
  if (!row.includes(route.auditEvent)) fail('matrix row missing audit contract', routeKey(route));
}

log('done', `${matrixRows.size} route(s) documented`);
