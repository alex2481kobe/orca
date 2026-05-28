import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ROUTE_INVENTORY,
  ROUTE_INVENTORY_VERSION,
  buildRouteInventory,
} from '../src/route-inventory.js';

test('route inventory has complete security metadata for every inventoried route', () => {
  const inventory = buildRouteInventory();
  assert.equal(inventory.contractVersion, ROUTE_INVENTORY_VERSION);
  assert.equal(inventory.publicSafe, true);
  assert.equal(inventory.routeCount, ROUTE_INVENTORY.length);
  assert.ok(inventory.routeCount >= 70);

  const requiredFields = inventory.requiredFields;
  const seen = new Set();
  for (const item of inventory.routes) {
    for (const field of requiredFields) {
      assert.ok(Object.prototype.hasOwnProperty.call(item, field), `${item.method} ${item.route} missing ${field}`);
      if (Array.isArray(item[field])) {
        assert.ok(item[field].length > 0, `${item.method} ${item.route} has empty ${field}`);
      } else {
        assert.ok(String(item[field] ?? '').trim(), `${item.method} ${item.route} has blank ${field}`);
      }
    }
    const key = `${item.method} ${item.route}`;
    assert.equal(seen.has(key), false, `duplicate ${key}`);
    seen.add(key);
    assert.equal(item.rateLimit.includes('src/rate-limiter.js'), true, `${key} must reference central rate limiter`);
    assert.equal(item.rateLimit.includes('not-yet'), false, `${key} has stale rate limit metadata`);
    if (item.method !== 'GET') {
      assert.notEqual(item.auth, 'none', `${key} must not be unauthenticated`);
      assert.notEqual(item.bodyLimit, 'none', `${key} must declare a body limit`);
      assert.notEqual(item.validation, 'none', `${key} must declare validation`);
    }
    if (['high', 'critical', 'high_frequency_medium'].includes(item.mutationRisk)) {
      assert.notEqual(item.approval, 'none', `${key} must declare approval/policy`);
      assert.notEqual(item.auditEvent, 'none', `${key} must declare audit/high-frequency exception`);
    }
  }

  for (const group of [
    'agent-tools',
    'audit',
    'auth',
    'capacity',
    'cleanup',
    'critique',
    'evidence',
    'private-access',
    'providers',
    'pwa',
    'system',
  ]) {
    assert.ok(inventory.groups[group] > 0, `missing group ${group}`);
  }
});
