import { api } from './api.js';
import { renderAlert } from './dom.js';
import { shell } from './state.js';

const POLL_MS = 450;
const MAX_CHARS = 200000;

let _timer = null;
let _activeTerminalId = null;

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

function mountFor(terminalId) {
  return typeof document !== 'undefined' ? document.getElementById(`operator-terminal-stream-${terminalId}`) : null;
}

function paintTerminal(terminalId) {
  const el = mountFor(terminalId);
  if (!el) return;
  const value = shell.operatorTerminalBuffers?.[terminalId] || '';
  const html = value ? renderAnsi(value) : 'Waiting for terminal output...';
  if (el.innerHTML !== html) el.innerHTML = html;
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  if (nearBottom) el.scrollTop = el.scrollHeight;
}

export function fillOperatorTerminal(terminalId) {
  if (!terminalId) return;
  paintTerminal(terminalId);
}

export function stopOperatorTerminalPolling() {
  if (_timer) clearTimeout(_timer);
  _timer = null;
  _activeTerminalId = null;
}

async function pollOnce(terminalId) {
  const offset = shell.operatorTerminalOffsets?.[terminalId] ?? '';
  const query = offset === '' ? '' : `?offset=${encodeURIComponent(String(offset))}&maxChars=32768`;
  const response = await api(`/api/terminals/${encodeURIComponent(terminalId)}/tail${query}`);
  if (!response.ok) {
    const el = mountFor(terminalId);
    if (el) el.textContent = response.data?.error || 'Terminal output is unavailable.';
    return;
  }
  const text = response.data?.text || '';
  shell.operatorTerminalOffsets = shell.operatorTerminalOffsets || {};
  shell.operatorTerminalBuffers = shell.operatorTerminalBuffers || {};
  shell.operatorTerminalOffsets[terminalId] = response.data?.nextOffset ?? offset;
  if (text) {
    shell.operatorTerminalBuffers[terminalId] = ((shell.operatorTerminalBuffers[terminalId] || '') + text).slice(-MAX_CHARS);
  }
  paintTerminal(terminalId);
}

export function watchOperatorTerminal(terminalId) {
  if (!terminalId) { stopOperatorTerminalPolling(); return; }
  if (_activeTerminalId === terminalId && _timer) {
    fillOperatorTerminal(terminalId);
    return;
  }
  stopOperatorTerminalPolling();
  _activeTerminalId = terminalId;
  const tick = async () => {
    if (_activeTerminalId !== terminalId) return;
    await pollOnce(terminalId).catch(() => {});
    if (_activeTerminalId === terminalId) _timer = setTimeout(tick, POLL_MS);
  };
  tick();
}

export async function handleStartOperatorTerminal(event) {
  const sessionId = event.currentTarget.dataset.sessionId || shell.route.sessionId;
  if (!sessionId) return;
  const response = await api(`/api/sessions/${encodeURIComponent(sessionId)}/terminals`, {
    method: 'POST',
    body: { actor: 'dashboard', title: 'Command tab' },
  });
  if (!response.ok) {
    renderAlert(response.data?.error || 'Could not start terminal.', 'bad');
    return;
  }
  shell.operatorTerminalActiveBySession = shell.operatorTerminalActiveBySession || {};
  shell.operatorTerminalActiveBySession[sessionId] = response.data.id;
  shell.chatTerminalTabBySession = shell.chatTerminalTabBySession || {};
  shell.chatTerminalTabBySession[sessionId] = 'command';
  shell.operatorTerminalOffsets[response.data.id] = '';
  shell.operatorTerminalBuffers[response.data.id] = '';
  return true;
}

export async function handleOperatorTerminalInput(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const terminalId = form.dataset.terminalId;
  const input = form.querySelector('input[name="input"]');
  const value = input?.value || '';
  if (!terminalId || !value.trim()) return;
  if (input) input.value = '';
  const response = await api(`/api/terminals/${encodeURIComponent(terminalId)}/input`, {
    method: 'POST',
    body: { actor: 'dashboard', input: value },
  });
  if (!response.ok) {
    renderAlert(response.data?.error || 'Could not write terminal input.', 'bad');
    return;
  }
  await pollOnce(terminalId).catch(() => {});
}

export async function handleStopOperatorTerminal(event) {
  const terminalId = event.currentTarget.dataset.terminalId;
  if (!terminalId) return;
  const response = await api(`/api/terminals/${encodeURIComponent(terminalId)}/stop`, {
    method: 'POST',
    body: { actor: 'dashboard' },
  });
  renderAlert(response.ok ? 'Terminal stopped.' : (response.data?.error || 'Could not stop terminal.'), response.ok ? 'ok' : 'bad');
  return response.ok;
}
