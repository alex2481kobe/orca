// Sidebar ordering persistence + list-reorder helpers. Extracted from app.js.

import { SIDEBAR_ORDER_STORAGE_KEY } from './constants.js';

export function readSidebarOrder() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SIDEBAR_ORDER_STORAGE_KEY) || '{}');
    return {
      projects: Array.isArray(parsed.projects) ? parsed.projects : [],
      sessions: parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {},
    };
  } catch {
    return { projects: [], sessions: {} };
  }
}

export function writeSidebarOrder(order) {
  window.localStorage.setItem(SIDEBAR_ORDER_STORAGE_KEY, JSON.stringify(order));
}

export function orderItems(items, ids) {
  const positions = new Map((ids || []).map((id, index) => [id, index]));
  return [...items].sort((a, b) => {
    const aIndex = positions.has(a.id) ? positions.get(a.id) : Number.MAX_SAFE_INTEGER;
    const bIndex = positions.has(b.id) ? positions.get(b.id) : Number.MAX_SAFE_INTEGER;
    if (aIndex !== bIndex) return aIndex - bIndex;
    return items.indexOf(a) - items.indexOf(b);
  });
}

export function moveId(ids, sourceId, targetId) {
  const next = ids.filter((id) => id !== sourceId);
  const targetIndex = next.indexOf(targetId);
  if (targetIndex === -1) {
    next.push(sourceId);
  } else {
    next.splice(targetIndex, 0, sourceId);
  }
  return next;
}
