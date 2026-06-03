// Pure display + escaping helpers (no DOM/shell state). Extracted from app.js.

export function safeText(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function safeAttr(value) {
  return safeText(value)
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function stateBadge(state) {
  const map = {
    queued: ['Queued', 'warn'],
    starting: ['Starting', 'warn'],
    running: ['Running', 'ok'],
    done: ['Done', 'ok'],
    stopped: ['Stopped', 'bad'],
    failed: ['Failed', 'bad'],
  };
  const [label, tone] = map[state] || [state, 'warn'];
  return `<span class="tag ${tone}">${label}</span>`;
}

export function formatMeta(timeString) {
  if (!timeString) return 'n/a';
  return new Date(timeString).toLocaleTimeString();
}

export function formatRelative(timeString) {
  if (!timeString) return 'never';
  const timestamp = new Date(timeString).getTime();
  if (!Number.isFinite(timestamp)) return 'unknown';
  const deltaSeconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  // Coarse "just now" under a minute instead of a per-second count. A per-second
  // "Ns ago" changes the rendered HTML every tick, forcing its region to rebuild
  // on every poll and defeating skip-if-identical — the opposite of keeping
  // paired/workstation pages static and updating only the region that changed.
  if (deltaSeconds < 60) return 'just now';
  const deltaMinutes = Math.round(deltaSeconds / 60);
  if (deltaMinutes < 60) return `${deltaMinutes}m ago`;
  const deltaHours = Math.round(deltaMinutes / 60);
  if (deltaHours < 24) return `${deltaHours}h ago`;
  const deltaDays = Math.round(deltaHours / 24);
  return `${deltaDays}d ago`;
}

export function latestTimestamp(items) {
  const timestamps = (items || [])
    .map((item) => new Date(item.updatedAt || item.completedAt || item.createdAt || 0).getTime())
    .filter(Number.isFinite);
  if (!timestamps.length) return null;
  return new Date(Math.max(...timestamps)).toISOString();
}
