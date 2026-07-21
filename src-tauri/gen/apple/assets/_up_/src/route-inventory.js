// Route inventory. The big data table is split into ordered chunks under
// route-inventory/; this barrel concatenates them (order preserved) and keeps the
// public surface (ROUTE_INVENTORY, ROUTE_INVENTORY_VERSION, buildRouteInventory).

import { ROUTE_INVENTORY_VERSION, corsDefault } from './route-inventory/_shared.js';
import { part1 } from './route-inventory/part1.js';
import { part2 } from './route-inventory/part2.js';
import { part3 } from './route-inventory/part3.js';
import { part4 } from './route-inventory/part4.js';
import { part5 } from './route-inventory/part5.js';
import { part6 } from './route-inventory/part6.js';
import { part7 } from './route-inventory/part7.js';

const ROUTE_INVENTORY = [
  ...part1,
  ...part2,
  ...part3,
  ...part4,
  ...part5,
  ...part6,
  ...part7,
];

function buildRouteInventory() {
  const groups = {};
  for (const item of ROUTE_INVENTORY) {
    groups[item.group] = (groups[item.group] || 0) + 1;
  }
  return {
    contractVersion: ROUTE_INVENTORY_VERSION,
    generatedAt: new Date().toISOString(),
    publicSafe: true,
    corsDefault,
    routeCount: ROUTE_INVENTORY.length,
    groups,
    requiredFields: [
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
    ],
    routes: ROUTE_INVENTORY,
  };
}

export {
  ROUTE_INVENTORY,
  ROUTE_INVENTORY_VERSION,
  buildRouteInventory,
};
