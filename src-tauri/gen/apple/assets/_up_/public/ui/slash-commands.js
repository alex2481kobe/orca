// Codex-style "/" command palette for the composer. Typing "/" surfaces a fuzzy,
// flat list of the things each terminal agent actually exposes — model, reasoning
// effort, fast/standard speed, git branch — plus /status and /help. Everything is
// derived from the selected agent's detected capabilities (nothing hardcoded), so
// it mirrors what that CLI supports. Selecting a row applies it to the composer's
// hidden config fields (the same ones the config pill drives).

import { shell } from './state.js';
import { normalizeExecutorType, getExecutorProfile } from './executor.js';
import {
  reasoningValues, modelItems, speedSupported, reasonLabel, shortModel, refreshConfigLabel,
} from './composer-config.js';
import { createEmptyChat } from './handlers-create.js';
import { safeText } from './format.js';

let _rows = [];
let _sel = 0;
let _info = '';

function activeForm() { return document.getElementById('orchestrator-message-form'); }
function textareaOf(form) { return form?.querySelector('textarea[name="message"]'); }
function menuOf(form) { return form?.querySelector('.slash-menu'); }
function executorOf(form) { return normalizeExecutorType(form?.querySelector('select[name="executorType"]')?.value || ''); }
function fieldOf(form, name) { return form?.querySelector(`input[name="${name}"]`); }
function val(form, name) { return fieldOf(form, name)?.value || ''; }

function statusText(form) {
  const ex = executorOf(form);
  const model = val(form, 'model');
  const speed = val(form, 'speed') || 'standard';
  const branch = val(form, 'branch') || shell.gitInfo?.[form.dataset.sessionId]?.currentBranch || '(none)';
  return `agent ${ex} · model ${model ? shortModel(model) : '(default)'} · reasoning ${reasonLabel(val(form, 'intelligenceProfile') || 'high')} · speed ${speed} · branch ${branch}`;
}

function controlsOf(ex) { return getExecutorProfile(ex)?.capabilities?.controls || {}; }

// Dashboard-action handlers we actually implement. Anything not here falls back to
// an info line so the real command is still shown, honestly, with its description.
const DASHBOARD = {
  status: (form) => showInfo(form, statusText(form)),
  new: (form) => newChat(form),
  clear: (form) => newChat(form),
  diff: (form) => showInfo(form, changedFilesText(form)),
  context: (form) => showInfo(form, usageText(form)),
  usage: (form) => showInfo(form, usageText(form)),
  cost: (form) => showInfo(form, usageText(form)),
  mcp: (form) => showInfo(form, mcpText(form)),
  agents: (form) => showInfo(form, agentsText(form)),
};

// Build the command rows from the selected agent's REAL detected slash commands
// (controls.slashCommands). apply-local commands with choices (/model, /effort) are
// expanded into one row per value; the rest behave per their detected mapping.
function buildRows(form) {
  const ex = executorOf(form);
  const list = controlsOf(ex).slashCommands;
  const rows = [];
  if (!Array.isArray(list) || !list.length) {
    // Fallback for agents with no detected slash commands (e.g. mock): local config.
    modelItems(ex).forEach((m) => rows.push(modelRow(form, m)));
    reasoningValues(ex, val(form, 'model')).forEach((r) => rows.push(effortRow(form, '/effort', r)));
    if (speedSupported(ex)) rows.push({ label: '/fast', hint: 'fast mode', run: () => applyConfig(form, 'speed', 'fast') });
    return rows;
  }
  for (const sc of list) {
    const name = sc.command.slice(1);
    if (name === 'model') { modelItems(ex).forEach((m) => rows.push(modelRow(form, m))); continue; }
    if (name === 'effort' || name === 'reasoning') {
      reasoningValues(ex, val(form, 'model')).forEach((r) => rows.push(effortRow(form, sc.command, r)));
      continue;
    }
    if (name === 'fast') { rows.push({ label: '/fast', hint: sc.description, run: () => applyConfig(form, 'speed', 'fast') }); continue; }
    rows.push(genericRow(form, sc));
  }
  return rows;
}

function modelRow(form, m) {
  return { label: `/model ${shortModel(m.v)}`, hint: m.label && m.label !== shortModel(m.v) ? m.label : 'model', run: () => applyConfig(form, 'model', m.v) };
}
function effortRow(form, cmd, r) {
  return { label: `${cmd} ${r}`, hint: reasonLabel(r), run: () => applyConfig(form, 'intelligenceProfile', r) };
}
function genericRow(form, sc) {
  const name = sc.command.slice(1);
  if (sc.mapping === 'interactive-only') return { label: sc.command, hint: `${sc.description} · terminal only`, disabled: true };
  if (sc.mapping === 'send-to-agent') return { label: sc.command, hint: `${sc.description} · send to agent`, run: () => sendToAgent(form, sc.command) };
  const action = DASHBOARD[name];
  return { label: sc.command, hint: sc.description, run: action ? () => action(form) : () => showInfo(form, `${sc.command} — ${sc.description}`) };
}

function showInfo(form, text) { _info = text; renderMenu(form); }

// Send a slash command to the agent: drop it into the composer so the user can add
// args and press Enter (the agent receives the command as the prompt).
function sendToAgent(form, command) {
  const ta = textareaOf(form);
  if (ta) {
    ta.value = `${command} `;
    if (shell.composerDrafts) shell.composerDrafts[form.dataset.sessionId] = ta.value;
  }
  hideMenu(form);
  ta?.focus();
}

function newChat(form) {
  const sid = form.dataset.sessionId;
  const session = (shell.sessions || []).find((s) => s.id === sid) || shell.draftSessions?.[sid];
  const projectId = session?.projectId;
  hideMenu(form);
  const ta = textareaOf(form); if (ta) ta.value = '';
  if (projectId) createEmptyChat(projectId);
}

function changedFilesText(form) {
  const lane = activeLane(form);
  const files = lane && Array.isArray(lane.changedFiles) ? lane.changedFiles : [];
  return files.length ? `Changed files: ${files.slice(0, 12).join(', ')}` : 'No file changes recorded yet.';
}
function usageText(form) {
  const lane = activeLane(form);
  const u = lane?.tokenUsage || lane?.usage;
  if (u && (u.total || u.input || u.output)) return `Tokens — in ${u.input ?? '?'} / out ${u.output ?? '?'} / total ${u.total ?? '?'}`;
  return 'No token usage recorded yet for this session.';
}
// Dynamic, per-agent subagent/workflow info. An agent "supports subagents" when
// it exposes the /agents command (codex, claude) or background-agent capability.
// Subagents the agent spawns appear as executor lanes in the session.
function agentsText(form) {
  const ex = executorOf(form);
  const ctrls = controlsOf(ex);
  const supports = (ctrls.slashCommands || []).some((c) => c.command === '/agents') || ctrls.backgroundAgents?.supported;
  const sid = form.dataset.sessionId;
  const subs = (shell.lanes || []).filter((l) => l.sessionId === sid && l.owner !== 'orchestrator');
  const spawned = subs.length ? ` Spawned so far: ${subs.slice(0, 8).map((l) => l.title || l.executorType).join(', ')}.` : ' None spawned yet.';
  if (supports) {
    return `${ex} can spawn subagents — just ask it in chat (e.g. "use subagents to parallelize this"). They run as lanes you can watch in the session panel.${spawned}`;
  }
  return `${ex} runs as a single agent (no separate subagents).${spawned}`;
}
function mcpText(form) {
  const lane = activeLane(form);
  const tools = (lane && Array.isArray(lane.mcpTools) ? lane.mcpTools : []).map((t) => t.id || t.name).filter(Boolean);
  return tools.length ? `MCP tools: ${tools.join(', ')}` : 'No MCP tools attached. Manage them in the session panel (New lane → MCP tools).';
}
function activeLane(form) {
  const sid = form.dataset.sessionId;
  return (shell.lanes || []).filter((l) => l.sessionId === sid).sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))[0] || null;
}

function applyConfig(form, name, value) {
  const f = fieldOf(form, name);
  if (f) f.value = value;
  refreshConfigLabel(form);
  if (name === 'branch') {
    const pill = document.querySelector('.ctx-pill[data-ctx-menu="branch"] .ctx-pill-label');
    if (pill) pill.textContent = value || shell.gitInfo?.[form.dataset.sessionId]?.currentBranch || 'branch';
  }
  const ta = textareaOf(form);
  if (ta) { ta.value = ''; if (shell.composerDrafts) shell.composerDrafts[form.dataset.sessionId] = ''; }
  hideMenu(form);
  ta?.focus();
}

function hideMenu(form) {
  const m = menuOf(form);
  if (m) { m.hidden = true; m.innerHTML = ''; }
  _rows = []; _sel = 0; _info = '';
}

function renderMenu(form) {
  const m = menuOf(form);
  if (!m) return;
  const list = _rows.map((r, i) =>
    `<button type="button" class="slash-row${i === _sel ? ' sel' : ''}${r.disabled ? ' disabled' : ''}" data-i="${i}" role="option"${r.disabled ? ' aria-disabled="true"' : ''}><span class="slash-cmd">${safeText(r.label)}</span><span class="slash-hint">${safeText(r.hint || '')}</span></button>`,
  ).join('');
  m.innerHTML = list + (_info ? `<div class="slash-info">${safeText(_info)}</div>` : '');
  m.hidden = false;
}

function refilter(form) {
  const ta = textareaOf(form);
  const text = ta?.value || '';
  if (!text.startsWith('/')) { hideMenu(form); return; }
  _info = '';
  const q = text.slice(1).toLowerCase().trim();
  const all = buildRows(form);
  _rows = q ? all.filter((r) => r.label.toLowerCase().includes(q)) : all;
  // Offer to create a branch the user is typing that doesn't exist yet.
  const git = shell.gitInfo?.[form.dataset.sessionId];
  const branchMatch = /^branch\s+(.+)$/.exec(q);
  if (git?.isGit && branchMatch) {
    const name = text.slice(1).trim().replace(/^branch\s+/i, '').trim();
    if (name && !(git.branches || []).some((b) => b.toLowerCase() === name.toLowerCase())) {
      _rows = [{ label: `/branch ${name}`, hint: 'create', run: () => applyConfig(form, 'branch', name) }, ..._rows];
    }
  }
  if (!_rows.length) { hideMenu(form); return; }
  _sel = Math.max(0, Math.min(_sel, _rows.length - 1));
  renderMenu(form);
}

function isOpen(form) { const m = menuOf(form); return m && !m.hidden; }

export function initSlashCommands() {
  // Filter as the user types.
  document.addEventListener('input', (event) => {
    const t = event.target;
    if (!t || t.name !== 'message') return;
    const form = t.closest('#orchestrator-message-form');
    if (form) refilter(form);
  });

  // Capture phase so we intercept Enter/Arrows BEFORE the Enter-to-send handler.
  document.addEventListener('keydown', (event) => {
    const t = event.target;
    if (!t || t.name !== 'message') return;
    const form = t.closest('#orchestrator-message-form');
    if (!form || !isOpen(form)) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault(); event.stopPropagation();
      _sel = (_sel + 1) % _rows.length; renderMenu(form);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault(); event.stopPropagation();
      _sel = (_sel - 1 + _rows.length) % _rows.length; renderMenu(form);
    } else if (event.key === 'Enter') {
      event.preventDefault(); event.stopPropagation();
      _rows[_sel]?.run();
    } else if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation();
      hideMenu(form);
    }
  }, true);

  // Click a row to run it.
  document.addEventListener('click', (event) => {
    const row = event.target.closest?.('.slash-row');
    if (!row) return;
    const form = row.closest('#orchestrator-message-form');
    if (!form) return;
    event.preventDefault();
    const i = Number(row.dataset.i);
    if (Number.isInteger(i)) _rows[i]?.run();
  });
}
