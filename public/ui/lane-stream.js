// Client side of the per-lane LIVE terminal stream. Subscribes to
// /api/lanes/:id/stream (SSE) for the ONE lane whose detail view is open, appends
// raw output into a stable <pre id="lane-stream-<id>"> mount in real time, and
// tears the connection down when you navigate away. Only one lane streams at a
// time (the focused one) — that's what keeps "terminal feel" cheap on mobile.

const MAX_CHARS = 200000; // cap retained output so a long-running lane can't grow unbounded
let _es = null;
let _laneId = null;
const _buffers = new Map(); // laneId -> accumulated text
const _notices = new Map(); // laneId -> "stream unavailable" explanation

function mountFor(laneId) {
  return typeof document !== 'undefined' ? document.getElementById(`lane-stream-${laneId}`) : null;
}

// Replace the "Connecting to live output…" placeholder with an explanation when
// the stream can't run — otherwise the terminal sits on "Connecting…" forever
// (EventSource missing, or SSE auth unavailable on token-in-page remote clients).
// Persisted in _notices so it survives the poll re-render (which rebuilds the <pre>
// with the placeholder); fillLaneStream repaints it. Never shown once real output
// exists, and cleared as soon as a snapshot arrives.
function writeStreamNotice(laneId, message) {
  if (_buffers.get(laneId)) return;
  _notices.set(laneId, message);
  const el = mountFor(laneId);
  if (el) el.textContent = message;
}

function autoscroll(el) {
  // Only stick to the bottom if the user is already near it (don't yank them up
  // while they're scrolled back reading earlier output).
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  if (nearBottom) el.scrollTop = el.scrollHeight;
}

// Re-paint the mount from the buffer (after a re-render rebuilt the <pre> empty).
// Falls back to a persisted "stream unavailable" notice so it survives re-render;
// if neither exists, leaves the render's "Connecting…" placeholder untouched.
export function fillLaneStream(laneId) {
  if (!laneId) return;
  const el = mountFor(laneId);
  if (!el) return;
  const buffered = _buffers.get(laneId);
  if (buffered) {
    if (el.textContent !== buffered) { el.textContent = buffered; el.scrollTop = el.scrollHeight; }
    return;
  }
  const notice = _notices.get(laneId);
  if (notice && el.textContent !== notice) el.textContent = notice;
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
  if (typeof EventSource === 'undefined') {
    writeStreamNotice(laneId, 'Live output is not available in this view. Open the lane on the workstation to watch it stream.');
    return;
  }
  let es;
  try {
    es = new EventSource(`/api/lanes/${encodeURIComponent(laneId)}/stream`);
    _notices.delete(laneId); // fresh attempt — clear any stale "unavailable" notice
  } catch {
    writeStreamNotice(laneId, 'Live output could not start on this device. Open the lane on the workstation to watch it stream.');
    return;
  }
  _es = es;
  es.addEventListener('snapshot', (event) => {
    if (_laneId !== laneId) return;
    try {
      const data = JSON.parse(event.data);
      const prefix = data.truncated ? '…(earlier output trimmed)\n' : '';
      _notices.delete(laneId); // real output arrived — drop any "unavailable" notice
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
  es.addEventListener('error', () => {
    if (_laneId !== laneId) return;
    // EventSource auto-reconnects while readyState is CONNECTING; only surface a
    // notice once the browser has given up (CLOSED) and we never got any output —
    // e.g. SSE auth failed on a token-in-page remote client.
    if (es.readyState === EventSource.CLOSED) {
      writeStreamNotice(laneId, 'Live output is unavailable on this device. Open the lane on the workstation to watch it stream.');
    }
  });
}
