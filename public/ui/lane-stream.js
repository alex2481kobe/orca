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

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function applyBackspaces(value) {
  const out = [];
  for (const char of String(value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')) {
    if (char === '\b') { out.pop(); continue; }
    out.push(char);
  }
  return out.join('').replace(/[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g, '');
}

function ansiClass(codes) {
  const classes = [];
  for (const raw of codes) {
    const code = Number.parseInt(raw || '0', 10);
    if (code === 1) classes.push('ansi-bold');
    if (code === 2) classes.push('ansi-dim');
    if (code >= 30 && code <= 37) classes.push(`ansi-fg-${code - 30}`);
    if (code >= 90 && code <= 97) classes.push(`ansi-fg-bright-${code - 90}`);
  }
  return [...new Set(classes)].join(' ');
}

function renderAnsi(value) {
  const text = applyBackspaces(value);
  let html = '';
  let cursor = 0;
  let open = false;
  const sgr = /\x1b\[([0-9;]*)m/g;
  let match;
  while ((match = sgr.exec(text))) {
    html += escapeHtml(text.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    const codes = String(match[1] || '0').split(';');
    if (open) { html += '</span>'; open = false; }
    if (codes.includes('0')) continue;
    const cls = ansiClass(codes);
    if (cls) { html += `<span class="${cls}">`; open = true; }
  }
  html += escapeHtml(text.slice(cursor));
  if (open) html += '</span>';
  return html.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

function paintTerminal(el, value) {
  const html = renderAnsi(value);
  if (el.innerHTML !== html) el.innerHTML = html;
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
  if (el) paintTerminal(el, message);
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
    if (el.textContent !== applyBackspaces(buffered)) { paintTerminal(el, buffered); el.scrollTop = el.scrollHeight; }
    return;
  }
  const notice = _notices.get(laneId);
  if (notice && el.textContent !== notice) paintTerminal(el, notice);
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
        paintTerminal(el, _buffers.get(laneId) || '');
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
