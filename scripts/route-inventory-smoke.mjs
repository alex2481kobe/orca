#!/usr/bin/env node
/*
 * Command Deck route inventory smoke.
 *
 * Fails if route metadata is incomplete, unsafe, inconsistent with the server
 * source, or missing the security/testing fields required by the full buildout
 * prompt.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const base = process.env.COMMAND_DECK_BASE_URL || '';
const routeInventoryModule = path.resolve(root, 'src', 'route-inventory.js');
const serverPath = path.resolve(root, 'src', 'server.js');
const publicDir = path.resolve(root, 'public');

const log = (label, info = '') => console.log(`[route-inventory] ${label}${info ? ' — ' + info : ''}`);
const fail = (label, info = '') => {
  console.error(`[route-inventory FAIL] ${label}${info ? ' — ' + info : ''}`);
  process.exitCode = 1;
  throw new Error(`${label}${info ? `: ${info}` : ''}`);
};

const REQUIRED_FIELDS = [
  'method',
  'route',
  'group',
  'owner',
  'auth',
  'mutationRisk',
  'approval',
  'validation',
  'auditEvent',
  'bodyLimit',
  'rateLimit',
  'uiSurface',
  'smokeCoverage',
  'mobileBehavior',
  'serverHints',
];

const VALID_METHODS = new Set(['GET', 'POST', 'PATCH', 'DELETE']);
const VALID_RISKS = new Set(['none', 'low', 'medium', 'high', 'critical', 'high_frequency_medium']);

async function loadInventory() {
  const mod = await import(`${pathToFileURL(routeInventoryModule).href}?route-smoke=${Date.now()}`);
  const built = mod.buildRouteInventory();
  if (!built || !Array.isArray(built.routes)) fail('buildRouteInventory must return routes array');
  if (built.publicSafe !== true) fail('route inventory must be publicSafe');
  return built;
}

async function readCombinedSource() {
  const files = [
    serverPath,
    path.join(publicDir, 'index.html'),
    path.join(publicDir, 'app.js'),
    path.join(publicDir, 'styles.css'),
    path.join(publicDir, 'manifest.webmanifest'),
    path.join(publicDir, 'service-worker.js'),
    path.resolve(root, 'package.json'),
  ];
  const chunks = [];
  for (const file of files) {
    chunks.push(await fs.readFile(file, 'utf8'));
  }
  return chunks.join('\n');
}

function assertNoPrivateData(payload) {
  const serialized = JSON.stringify(payload);
  const privateNeedles = [
    process.cwd(),
    process.env.HOME,
    '/Users/',
    'COMMAND_DECK_API_TOKEN=',
    'COMMAND_DECK_WORKER_TOKEN=',
    'sk-',
  ].filter(Boolean);
  for (const needle of privateNeedles) {
    if (serialized.includes(needle)) fail('inventory leaks private/local data', needle);
  }
}

function validateRouteShape(item, index) {
  for (const field of REQUIRED_FIELDS) {
    if (!(field in item)) fail(`route ${index} missing required field`, field);
    if (Array.isArray(item[field])) {
      if (!item[field].length) fail(`route ${item.route} has empty required array`, field);
    } else if (item[field] === null || item[field] === undefined || String(item[field]).trim() === '') {
      fail(`route ${item.route || index} has empty required field`, field);
    }
  }
  if (!VALID_METHODS.has(item.method)) fail('unsupported method', `${item.method} ${item.route}`);
  if (!item.route.startsWith('/')) fail('route must start with /', item.route);
  if (!VALID_RISKS.has(item.mutationRisk)) fail('unsupported mutationRisk', `${item.mutationRisk} ${item.route}`);
  if (String(item.rateLimit || '').includes('not-yet')) {
    fail('route has non-centralized rate-limit metadata', `${item.method} ${item.route}`);
  }
  if (!String(item.rateLimit || '').includes('src/rate-limiter.js')) {
    fail('route must reference central rate limiter', `${item.method} ${item.route}`);
  }
  if (item.method !== 'GET') {
    if (item.auth === 'none') fail('mutating route cannot have auth none', `${item.method} ${item.route}`);
    if (item.bodyLimit === 'none') fail('mutating route must declare body limit', `${item.method} ${item.route}`);
    if (item.validation === 'none') fail('mutating route must declare validation', `${item.method} ${item.route}`);
    if (['none', 'low'].includes(item.mutationRisk)) fail('mutating route must declare nontrivial risk', `${item.method} ${item.route}`);
  }
  if (['high', 'critical', 'high_frequency_medium'].includes(item.mutationRisk)) {
    if (item.auditEvent === 'none' && !String(item.auditEvent).includes('high_frequency')) {
      fail('high-risk route must declare audit event or high-frequency exception', `${item.method} ${item.route}`);
    }
    if (item.approval === 'none') fail('high-risk route must declare approval policy', `${item.method} ${item.route}`);
  }
  if (item.route.includes('/secret') || item.group === 'providers') {
    const joined = `${item.validation} ${item.auditEvent} ${item.uiSurface}`.toLowerCase();
    if (!joined.includes('secret') && item.route.includes('/secret')) {
      fail('secret route must explicitly mention secret handling', `${item.method} ${item.route}`);
    }
  }
}

function validateCoverage(item, source) {
  for (const hint of item.serverHints) {
    if (!source.includes(hint)) fail('server/source hint missing', `${item.method} ${item.route} -> ${hint}`);
  }
  const coverageText = item.smokeCoverage.join(' ');
  if (!/test\/|smoke:/.test(coverageText)) {
    fail('route must reference test or smoke coverage', `${item.method} ${item.route}`);
  }
}

async function validateHttpEndpoint(expectedRouteCount) {
  if (!base) return;
  const response = await fetch(`${base}/api/route-inventory`);
  if (!response.ok) fail('GET /api/route-inventory failed', String(response.status));
  const body = await response.json();
  if (body.routeCount !== expectedRouteCount) {
    fail('HTTP route inventory count mismatch', `${body.routeCount} !== ${expectedRouteCount}`);
  }
  if (!Array.isArray(body.routes) || body.routes.length !== expectedRouteCount) {
    fail('HTTP route inventory routes mismatch');
  }
  assertNoPrivateData(body);
  log('http', `${body.routeCount} route(s) from ${base}`);
}

async function main() {
  const inventory = await loadInventory();
  const source = await readCombinedSource();
  assertNoPrivateData(inventory);

  const seen = new Set();
  const groups = new Map();
  for (const [index, item] of inventory.routes.entries()) {
    validateRouteShape(item, index);
    validateCoverage(item, source);
    const key = `${item.method} ${item.route}`;
    if (seen.has(key)) fail('duplicate route inventory entry', key);
    seen.add(key);
    groups.set(item.group, (groups.get(item.group) || 0) + 1);
  }

  const requiredGroups = [
    'agent-tools',
    'audit',
    'auth',
    'capacity',
    'cleanup',
    'critique',
    'evidence',
    'executors',
    'lanes',
    'mcp',
    'mobile',
    'private-access',
    'providers',
    'pwa',
    'sessions',
    'settings',
    'static-app',
    'static-artifacts',
    'streams',
    'system',
  ];
  for (const group of requiredGroups) {
    if (!groups.has(group)) fail('missing required route group', group);
  }

  await validateHttpEndpoint(inventory.routeCount);
  log('groups', JSON.stringify(Object.fromEntries([...groups.entries()].sort())));
  log('done', `${inventory.routeCount} route(s) inventoried`);
}

await main().catch((error) => {
  console.error('[route-inventory ERROR]', error?.stack || error?.message || error);
  if (!process.exitCode) process.exitCode = 1;
});
