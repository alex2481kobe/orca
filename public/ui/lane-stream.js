// Client side of the per-lane LIVE terminal stream. Subscribes to
// /api/lanes/:id/stream (SSE) for the ONE lane whose detail view is open, appends
// raw output into a stable <pre id="lane-stream-<id>"> mount in real time, and
// tears the connection down when you navigate away. Only one lane streams at a
// time (the focused one) — that's what keeps "terminal feel" cheap on mobile.

const MAX_CHARS = 200000; // cap retained output so a long-running lane can't grow unbounded
let _es = null;
let _laneId = null;
const _buffers = new Map(); // laneId -> accumulated text

function mountFor(laneId) {
  return typeof document !== 'undefined' ? document.getElementById(`lane-stream-${laneId}`) : null;
}

function autoscroll(el) {
  // Only stick to the bottom if the user is already near it (don't yank them up
  // while they're scrolled back reading earlier output).
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  if (nearBottom) el.scrollTop = el.scrollHeight;
}

// Re-paint the mount from the buffer (after a re-render rebuilt the <pre> empty).
export function fillLaneStream(laneId) {
  if (!laneId) return;
  const el = mountFor(laneId);
  if (!el) return;
  const text = _buffers.get(laneId) || '';
  if (el.textContent !== text) {
    el.textContent = text;
    el.scrollTop = el.scrollHeight;
  }
}

export function unsubscribeLaneStream() {
  if (_es) { try { _es.close(); } catch { /* ignore */ } _es = null; }
  _laneId = null;
}

export function subscribeLaneStream(laneId) {
  if (!laneId) { unsubscribeLaneStream(); return; }
  if (_laneId === laneId && _es) { fillLaneStream(laneId); return; } // already streaming this lane
  unsubscribeLaneStream();
  _laneId = laneId;
  if (typeof EventSource === 'undefined') return;
  let es;
  try { es = new EventSource(`/api/lanes/${encodeURIComponent(laneId)}/stream`); } catch { return; }
  _es = es;
  es.addEventListener('snapshot', (event) => {
    if (_laneId !== laneId) return;
    try {
      const data = JSON.parse(event.data);
      const prefix = data.truncated ? '…(earlier output trimmed)\n' : '';
      _buffers.set(laneId, (prefix + (data.text || '')).slice(-MAX_CHARS));
      fillLaneStream(laneId);
    } catch { /* ignore malformed frame */ }
  });
  es.addEventListener('append', (event) => {
    if (_laneId !== laneId) return;
    try {
      const data = JSON.parse(event.data);
      const chunk = data.text || '';
      if (!chunk) return;
      _buffers.set(laneId, ((_buffers.get(laneId) || '') + chunk).slice(-MAX_CHARS));
      const el = mountFor(laneId);
      if (el) {
        el.textContent += chunk;
        if (el.textContent.length > MAX_CHARS) el.textContent = el.textContent.slice(-MAX_CHARS);
        autoscroll(el);
      }
    } catch { /* ignore */ }
  });
  // EventSource auto-reconnects on error; nothing to do (server re-sends a snapshot).
}
