// Client side of the per-lane LIVE terminal stream. Subscribes to
// /api/lanes/:id/stream (SSE) for the focused lane and renders it through
// xterm.js when possible, falling back to bounded ANSI text when the browser
// cannot load the terminal emulator.

import { api } from './api.js';
import { renderAlert } from './dom.js';

const MAX_CHARS = 200000;
const XTERM_MODULE_URL = '/vendor/xterm/xterm.mjs';

let _es = null;
let _laneId = null;
let _xtermModulePromise = null;
const _buffers = new Map();
const _notices = new Map();
const _xterms = new Map();
const _rawInputQueues = new Map();

function mountFor(laneId) {
  return typeof document !== 'undefined' ? document.getElementById(`lane-stream-${laneId}`) : null;
}

function isInteractiveTerminal(laneId) {
  return mountFor(laneId)?.dataset?.interactiveTerminal === 'true';
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

function cssVar(name, fallback = '') {
  if (typeof getComputedStyle === 'undefined' || typeof document === 'undefined') return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function xtermTheme() {
  return {
    background: cssVar('--terminal-bg', cssVar('--panel')),
    foreground: cssVar('--terminal-text', cssVar('--text')),
    cursor: cssVar('--accent', cssVar('--text')),
    selectionBackground: cssVar('--surface-strong', cssVar('--terminal-line')),
  };
}

function estimateGeometry(mount) {
  const width = Math.max(320, mount?.clientWidth || 820);
  const height = Math.max(180, mount?.clientHeight || 420);
  return {
    cols: Math.max(20, Math.min(240, Math.floor(width / 8.6))),
    rows: Math.max(8, Math.min(80, Math.floor(height / 18))),
  };
}

function loadXterm() {
  if (!_xtermModulePromise) {
    _xtermModulePromise = import(XTERM_MODULE_URL).catch((error) => {
      _xtermModulePromise = null;
      throw error;
    });
  }
  return _xtermModulePromise;
}

function disposeXterm(laneId) {
  const existing = _xterms.get(laneId);
  if (!existing) return;
  try { existing.dataDisposable?.dispose?.(); } catch { /* ignore */ }
  try { existing.term?.dispose?.(); } catch { /* ignore */ }
  _xterms.delete(laneId);
}

function sendRawLaneInput(laneId, input) {
  if (!laneId || !input) return;
  if (!isInteractiveTerminal(laneId)) return;
  const previous = _rawInputQueues.get(laneId) || Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const response = await api(`/api/lanes/${encodeURIComponent(laneId)}/terminal-input`, {
      method: 'POST',
      body: { actor: 'dashboard', input, raw: true },
    });
    if (!response.ok) throw new Error(response.data?.error || 'Lane terminal input failed.');
  });
  _rawInputQueues.set(laneId, next);
  next.catch(() => renderAlert('Lane terminal input failed.', 'bad')).finally(() => {
    if (_rawInputQueues.get(laneId) === next) _rawInputQueues.delete(laneId);
  });
}

async function resizeBackendLane(laneId, cols, rows) {
  if (!laneId || !cols || !rows) return;
  if (!isInteractiveTerminal(laneId)) return;
  await api(`/api/lanes/${encodeURIComponent(laneId)}/terminal-resize`, {
    method: 'POST',
    body: { actor: 'dashboard', cols, rows },
  }).catch(() => {});
}

async function ensureXterm(laneId) {
  const mount = mountFor(laneId);
  if (!mount) return null;
  const existing = _xterms.get(laneId);
  if (existing?.mount === mount) return existing;
  disposeXterm(laneId);
  try {
    const { Terminal } = await loadXterm();
    const dims = estimateGeometry(mount);
    mount.textContent = '';
    mount.classList.add('terminal-xterm-host');
    const term = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      cols: dims.cols,
      rows: dims.rows,
      fontFamily: cssVar('--mono-font', 'ui-monospace, SFMono-Regular, Menlo, monospace'),
      fontSize: 13,
      scrollback: 5000,
      theme: xtermTheme(),
    });
    term.open(mount);
    term.write(_buffers.get(laneId) || '');
    const dataDisposable = term.onData((data) => sendRawLaneInput(laneId, data));
    resizeBackendLane(laneId, dims.cols, dims.rows);
    term.focus();
    const created = { term, mount, dataDisposable };
    _xterms.set(laneId, created);
    return created;
  } catch (error) {
    mount.dataset.xtermError = error?.message || 'xterm failed';
    return null;
  }
}

function paintFallbackTerminal(el, value) {
  const html = renderAnsi(value);
  if (el.innerHTML !== html) el.innerHTML = html;
}

function writeStreamNotice(laneId, message) {
  if (_buffers.get(laneId)) return;
  _notices.set(laneId, message);
  const el = mountFor(laneId);
  if (el) paintFallbackTerminal(el, message);
}

function autoscroll(el) {
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  if (nearBottom) el.scrollTop = el.scrollHeight;
}

export function fillLaneStream(laneId) {
  if (!laneId) return;
  const el = mountFor(laneId);
  if (!el) return;
  ensureXterm(laneId).then((record) => {
    if (record) return;
    const buffered = _buffers.get(laneId);
    if (buffered) {
      paintFallbackTerminal(el, buffered);
      el.scrollTop = el.scrollHeight;
      return;
    }
    const notice = _notices.get(laneId);
    if (notice) paintFallbackTerminal(el, notice);
  });
}

export function unsubscribeLaneStream() {
  if (_es) { try { _es.close(); } catch { /* ignore */ } _es = null; }
  if (_laneId) disposeXterm(_laneId);
  _laneId = null;
}

export function subscribeLaneStream(laneId) {
  if (!laneId) { unsubscribeLaneStream(); return; }
  if (_laneId === laneId && _es) { fillLaneStream(laneId); return; }
  unsubscribeLaneStream();
  _laneId = laneId;
  if (typeof EventSource === 'undefined') {
    writeStreamNotice(laneId, 'Live output is not available in this view. Open the lane on the workstation to watch it stream.');
    return;
  }
  let es;
  try {
    es = new EventSource(`/api/lanes/${encodeURIComponent(laneId)}/stream`);
    _notices.delete(laneId);
  } catch {
    writeStreamNotice(laneId, 'Live output could not start on this device. Open the lane on the workstation to watch it stream.');
    return;
  }
  _es = es;
  es.addEventListener('snapshot', (event) => {
    if (_laneId !== laneId) return;
    try {
      const data = JSON.parse(event.data);
      const prefix = data.truncated ? '...(earlier output trimmed)\n' : '';
      const next = (prefix + (data.text || '')).slice(-MAX_CHARS);
      _notices.delete(laneId);
      _buffers.set(laneId, next);
      const record = _xterms.get(laneId);
      if (record) {
        record.term.reset();
        record.term.write(next);
      } else {
        fillLaneStream(laneId);
      }
    } catch { /* ignore malformed frame */ }
  });
  es.addEventListener('append', (event) => {
    if (_laneId !== laneId) return;
    try {
      const data = JSON.parse(event.data);
      const chunk = data.text || '';
      if (!chunk) return;
      _buffers.set(laneId, ((_buffers.get(laneId) || '') + chunk).slice(-MAX_CHARS));
      const record = _xterms.get(laneId);
      if (record) {
        record.term.write(chunk);
      } else {
        const el = mountFor(laneId);
        if (el) {
          paintFallbackTerminal(el, _buffers.get(laneId) || '');
          autoscroll(el);
        }
      }
    } catch { /* ignore */ }
  });
  es.addEventListener('error', () => {
    if (_laneId !== laneId) return;
    if (es.readyState === EventSource.CLOSED) {
      writeStreamNotice(laneId, 'Live output is unavailable on this device. Open the lane on the workstation to watch it stream.');
    }
  });
}
