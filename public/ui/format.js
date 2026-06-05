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
  // Handle BOTH past and future. A paired session's expiry is ~24h in the FUTURE;
  // the old code clamped future deltas to 0 and rendered "just now" for the whole
  // 24h ("expires just now" that never changed). Now future reads "in 23h".
  const diffMs = timestamp - Date.now();
  const future = diffMs > 0;
  const deltaSeconds = Math.round(Math.abs(diffMs) / 1000);
  const phrase = (text) => (future ? `in ${text}` : `${text} ago`);
  // Coarse buckets (no per-second count) so an idle paired/workstation page doesn't
  // re-render its HTML every tick — that would defeat skip-if-identical.
  if (deltaSeconds < 60) return future ? 'in under a minute' : 'just now';
  const deltaMinutes = Math.round(deltaSeconds / 60);
  if (deltaMinutes < 60) return phrase(`${deltaMinutes}m`);
  const deltaHours = Math.round(deltaMinutes / 60);
  if (deltaHours < 24) return phrase(`${deltaHours}h`);
  const deltaDays = Math.round(deltaHours / 24);
  return phrase(`${deltaDays}d`);
}

export function latestTimestamp(items) {
  const timestamps = (items || [])
    .map((item) => new Date(item.updatedAt || item.completedAt || item.createdAt || 0).getTime())
    .filter(Number.isFinite);
  if (!timestamps.length) return null;
  return new Date(Math.max(...timestamps)).toISOString();
}
