// Render view module (split from render-views.js).

import { getExecutorProfile, getExecutorScopedMcpTools, getProviderProfile, isApiExecutorType, normalizeExecutorType } from './executor.js';
import { formatMeta, safeAttr, safeText } from './format.js';
import { refs, shell } from './state.js';
import { agentEventLabel, agentEventTone } from './render-helpers.js';

export function renderLaneExecutorGuidance(form) {
  if (!form || form.id !== 'create-lane-form') return;
  const profileEl = document.getElementById('lane-command-guidance');
  if (!profileEl) return;
  const selectedType = normalizeExecutorType(form.executorType?.value || 'mock');
  const profile = getExecutorProfile(selectedType);
  const providerProfile = getProviderProfile(selectedType);
  const lowerType = normalizeExecutorType(selectedType);
  const commandInput = form.elements.command;
  const binaryInput = form.elements.executorBinary;
  const scopedTools = getExecutorScopedMcpTools(selectedType);
  // Populate MCP picker select with executor-scoped tools.
  const mcpSelect = form.querySelector('select[name="mcpToolIds"]');
  if (mcpSelect) {
    const previous = new Set(Array.from(mcpSelect.selectedOptions || []).map((opt) => opt.value));
    mcpSelect.innerHTML = scopedTools.map((tool) => {
      const value = safeText(tool.id || tool.name);
      const label = safeText(tool.name || tool.id);
      return `<option value="${value}" ${previous.has(value) ? 'selected' : ''}>${label}</option>`;
    }).join('');
    if (!scopedTools.length) {
      mcpSelect.innerHTML = '<option disabled>No tools available for this executor</option>';
    }
  }
  // Dynamic per-executor controls: repopulate permission/intelligence/model
  // options from THIS executor's detected capabilities so each CLI shows its own
  // modes (codex sandbox/approval, Claude acceptEdits/bypassPermissions, etc.),
  // effort/intelligence levels, model values, and background-agents/workflows.
  const controls = profile?.capabilities?.controls || {};
  const repopulateSelect = (name, values, { keepFirstDefault = false } = {}) => {
    const select = form.querySelector(`select[name="${name}"]`);
    if (!select || !Array.isArray(values) || !values.length) return;
    const previous = select.value;
    const opts = (keepFirstDefault ? [''] : []).concat(values);
    select.innerHTML = opts.map((value) => {
      const label = value === '' ? 'Default (use CLI config)' : value;
      const selected = value === previous ? ' selected' : '';
      return `<option value="${safeAttr(value)}"${selected}>${safeText(label)}</option>`;
    }).join('');
    if (previous && values.includes(previous)) select.value = previous;
  };
  if (controls.permissions?.values?.length) repopulateSelect('permissionsProfile', controls.permissions.values);
  if (controls.intelligence?.values?.length) repopulateSelect('intelligenceProfile', controls.intelligence.values);
  // Model: keep the free-text input but offer this executor's known models as a datalist.
  const modelInput = form.elements.model;
  if (modelInput && Array.isArray(controls.model?.values)) {
    let listEl = document.getElementById('lane-model-options');
    if (!listEl) {
      listEl = document.createElement('datalist');
      listEl.id = 'lane-model-options';
      modelInput.insertAdjacentElement('afterend', listEl);
      modelInput.setAttribute('list', 'lane-model-options');
    }
    listEl.innerHTML = controls.model.values.map((value) => `<option value="${safeAttr(value)}"></option>`).join('');
    if (!modelInput.value) {
      const suggestions = (controls.model.aliases?.length ? controls.model.aliases : controls.model.values).slice(0, 3);
      if (controls.model.defaultValue) modelInput.placeholder = `${controls.model.defaultValue} (CLI default)`;
      else if (suggestions.length) modelInput.placeholder = `e.g. ${suggestions.join(', ')} — or blank for CLI default`;
      else modelInput.placeholder = "leave blank for the CLI's default model";
    }
  }
  const capabilitySummary = (() => {
    const bits = [];
    if (controls.permissions?.values?.length) bits.push(`modes: ${controls.permissions.values.join(', ')}`);
    if (controls.intelligence?.supported && controls.intelligence?.values?.length) bits.push(`intelligence: ${controls.intelligence.values.join(', ')}`);
    else if (controls.intelligence?.passthrough) bits.push('intelligence: passthrough to CLI config');
    if (controls.model?.values?.length) bits.push(`models: ${controls.model.values.slice(0, 6).join(', ')}`);
    if (controls.backgroundAgents?.supported) bits.push(`workflows/background agents: ${(controls.backgroundAgents.commands || ['agents']).join(', ')}`);
    if (controls.structuredOutput?.supported) bits.push('structured agent events');
    return bits.length ? `Detected ${lowerType} capabilities — ${bits.join(' · ')}. Leave a field on Default to use the CLI's own configured rules.` : '';
  })();

  const defaultBinary = safeText(profile?.defaultBinary || '');
  const defaultArgs = Array.isArray(profile?.defaultArgs) ? profile.defaultArgs.join(' ') : '';
  const allowedBinaries = Array.isArray(profile?.allowedBinaries) ? profile.allowedBinaries : [];
  const allowedList = allowedBinaries.length ? `Allowed binaries: ${safeText(allowedBinaries.join(', '))}` : 'No curated binary allowlist available';
  const toolSummary = scopedTools.length
    ? `${scopedTools.length} MCP tool${scopedTools.length === 1 ? '' : 's'} available`
    : '';

  const defaultArgsText = defaultArgs ? ` ${safeText(defaultArgs)}` : '';
  const binaryHint = defaultBinary ? `Try ${defaultBinary}${defaultArgsText} for ${lowerType}-led lanes.` : '';

  if (lowerType === 'codex' || lowerType === 'claude') {
    commandInput.placeholder = defaultBinary
      ? `${defaultBinary} run --help`
      : `${lowerType} <args>`;
    binaryInput.placeholder = defaultBinary || `${lowerType}`;
    profileEl.innerHTML = `
      <div class="tiny muted">
        Executor guidance: command or binary must contain "${lowerType}".
        ${binaryHint ? `${binaryHint} ` : ''}
        ${allowedList ? `${allowedList}` : ''}
        <br/>${toolSummary}
        ${capabilitySummary ? `<br/>${safeText(capabilitySummary)}` : ''}
      </div>
    `.trim();
    return;
  }

  if (lowerType === 'mock') {
    commandInput.placeholder = 'e.g., node';
    binaryInput.placeholder = 'e.g., codex, claude, node, ./scripts/run.sh';
    profileEl.innerHTML = `
      <div class="tiny muted">
        ${toolSummary}
      </div>
    `.trim();
    return;
  }

  if (isApiExecutorType(lowerType)) {
    const credentialLabel = providerProfile?.apiKeyEnv || providerProfile?.secretRef || 'configured provider secret';
    commandInput.placeholder = 'Not used for API provider lanes';
    binaryInput.placeholder = 'Not used for API provider lanes';
    profileEl.innerHTML = `
      <div class="tiny muted">
        API lane: uses ${safeText(providerProfile?.displayName || lowerType)} provider settings,
        ${safeText(providerProfile?.apiStyle || 'configured')} request shape,
        and secret reference ${safeText(credentialLabel)}. Configure secrets in Providers settings.
        <br/>${toolSummary}
      </div>
    `.trim();
    return;
  }

  commandInput.placeholder = 'e.g., node';
  binaryInput.placeholder = 'e.g., codex, claude, node, ./scripts/run.sh';
  profileEl.textContent = toolSummary;
}

// A stable identity for a <details> disclosure so its open/closed state survives
// a background re-render even if the *number* of disclosures on the page changes
// (positional index was fragile: a lane appearing would shift indices and snap an
// open disclosure shut — one cause of "it opens then auto-closes"). Keyed by an
// explicit data-uikey when present, else the summary text.
function disclosureKey(detail, index) {
  const explicit = detail.dataset ? detail.dataset.uikey : '';
  if (explicit) return `k:${explicit}`;
  const summary = detail.querySelector('summary');
  const text = (summary && summary.textContent ? summary.textContent : '').replace(/\s+/g, ' ').trim();
  return text ? `s:${text}` : `i:${index}`;
}

// A stable-ish key for a form control so its in-progress value survives a
// background re-render (the cause of "I change it and it changes back").
function controlKey(el) {
  const form = el.closest('form');
  const formId = form?.id || form?.getAttribute('data-session-id') || form?.getAttribute('data-lane-id') || '';
  const name = el.name || el.id || '';
  if (!name) return null;
  return `${formId}::${el.tagName}::${name}`;
}

export function captureContentUiState() {
  if (!refs.content) return null;
  // Snapshot unsaved values of editable controls so a poll/SSE re-render does not
  // revert what the user just typed or selected before they hit save.
  const controlValues = {};
  let focusKey = null;
  let focusStart = null;
  let focusEnd = null;
  refs.content.querySelectorAll('input, textarea, select').forEach((el) => {
    if (el.type === 'file' || el.type === 'password') return;
    const key = controlKey(el);
    if (!key) return;
    controlValues[key] = el.type === 'checkbox' || el.type === 'radio' ? el.checked : el.value;
    if (el === document.activeElement) {
      focusKey = key;
      try { focusStart = el.selectionStart; focusEnd = el.selectionEnd; } catch { /* not a text field */ }
    }
  });
  const detailsOpen = {};
  Array.from(refs.content.querySelectorAll('details')).forEach((detail, index) => {
    detailsOpen[disclosureKey(detail, index)] = detail.open;
  });
  return {
    detailsOpen,
    projectToolsOpen: Boolean(refs.content.querySelector('.project-shell.tools-open')),
    controlValues,
    focusKey,
    focusStart,
    focusEnd,
  };
}

export function restoreContentUiState(state) {
  if (!state || !refs.content) return;
  const detailsOpen = state.detailsOpen || {};
  Array.from(refs.content.querySelectorAll('details')).forEach((detail, index) => {
    const key = disclosureKey(detail, index);
    if (key in detailsOpen) {
      detail.open = detailsOpen[key];
    }
  });
  const projectShell = refs.content.querySelector('.project-shell');
  if (projectShell && state.projectToolsOpen) {
    projectShell.classList.add('tools-open');
  }
  if (state.controlValues) {
    refs.content.querySelectorAll('input, textarea, select').forEach((el) => {
      if (el.type === 'file' || el.type === 'password') return;
      const key = controlKey(el);
      if (!key || !(key in state.controlValues)) return;
      const value = state.controlValues[key];
      if (el.type === 'checkbox' || el.type === 'radio') {
        el.checked = Boolean(value);
      } else if (el.value !== value) {
        el.value = value;
      }
      if (key === state.focusKey && typeof el.focus === 'function') {
        el.focus();
        if (state.focusStart != null && typeof el.setSelectionRange === 'function') {
          try { el.setSelectionRange(state.focusStart, state.focusEnd); } catch { /* non-text */ }
        }
      }
    });
  }
}

export function activeOrchestratorLaneForSession(session) {
  const thread = session?.orchestratorThread || {};
  if (thread.activeLaneId) {
    const active = shell.lanes.find((lane) => lane.id === thread.activeLaneId);
    if (active) return active;
  }
  const laneIds = Array.isArray(thread.laneIds) ? thread.laneIds : [];
  for (let i = laneIds.length - 1; i >= 0; i -= 1) {
    const lane = shell.lanes.find((item) => item.id === laneIds[i]);
    if (lane) return lane;
  }
  return shell.lanes
    .filter((lane) => lane.sessionId === session?.id && lane.owner === 'orchestrator')
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))[0] || null;
}

export function orchestratorLanesForSession(session) {
  const sessionId = session?.id;
  const thread = session?.orchestratorThread || {};
  const seen = new Set();
  const lanes = [];
  const push = (lane) => {
    if (!lane || lane.sessionId !== sessionId || lane.owner !== 'orchestrator' || seen.has(lane.id)) return;
    seen.add(lane.id);
    lanes.push(lane);
  };
  for (const laneId of Array.isArray(thread.laneIds) ? thread.laneIds : []) {
    push(shell.lanes.find((lane) => lane.id === laneId));
  }
  shell.lanes
    .filter((lane) => lane.sessionId === sessionId && lane.owner === 'orchestrator')
    .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0))
    .forEach(push);
  return lanes;
}

export function chatTerminalLaneForSession(session) {
  const lanes = orchestratorLanesForSession(session);
  const selectedId = shell.chatTerminalAgentLaneBySession?.[session?.id] || '';
  return lanes.find((lane) => lane.id === selectedId)
    || activeOrchestratorLaneForSession(session)
    || lanes.at(-1)
    || null;
}

export function pinChatTerminalLaneForSession(session, laneId = '') {
  const lane = laneId
    ? orchestratorLanesForSession(session).find((item) => item.id === laneId)
    : chatTerminalLaneForSession(session);
  if (!session?.id || (!lane && !laneId)) return null;
  shell.chatTerminalAgentLaneBySession = shell.chatTerminalAgentLaneBySession || {};
  shell.chatTerminalAgentLaneBySession[session.id] = lane?.id || laneId;
  return lane || { id: laneId };
}

export function renderAgentEventTimeline(lane, { limit = 80, compact = false } = {}) {
  const events = Array.isArray(lane?.agentEvents) ? lane.agentEvents.slice(-limit) : [];
  if (!events.length) {
    return '<div class="agent-event-empty muted">No structured agent events yet. Raw terminal output will appear below.</div>';
  }
  return `
    <div class="agent-event-list ${compact ? 'compact' : ''}">
      ${events.map((item) => {
        const type = String(item.type || 'event');
        const tone = agentEventTone(type);
        const content = item.command || item.content || item.title || '';
        const meta = [
          item.toolName,
          item.stream,
          item.source,
          formatMeta(item.at),
        ].filter(Boolean).join(' · ');
        return `
          <article class="agent-event ${safeAttr(type.replaceAll('.', '-'))}">
            <div class="agent-event-topline">
              <span class="tag ${tone}">${safeText(agentEventLabel(type))}</span>
              <span class="tiny muted">${safeText(meta)}</span>
            </div>
            ${content ? `<pre>${safeText(content)}</pre>` : ''}
          </article>
        `;
      }).join('')}
    </div>
  `;
}

function isGenericCompletionText(value, lane) {
  const text = String(value || '').trim().toLowerCase();
  const executor = String(lane?.executorType || '').trim().toLowerCase();
  return !text
    || text === 'agent completed'
    || text === `${executor} execution completed`
    || text.endsWith(' execution completed')
    || text.includes('self-verification required before audit');
}

function readableCommandOutput(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^[{[]/.test(text)) {
    try {
      const parsed = JSON.parse(text);
      const item = parsed?.item && typeof parsed.item === 'object' ? parsed.item : null;
      const itemType = String(item?.type || '').toLowerCase();
      if ((itemType === 'agent_message' || itemType === 'assistant_message') && (item.text || item.content)) {
        return String(item.text || item.content || '').trim();
      }
    } catch { /* raw JSON remains hidden */ }
    return '';
  }
  return text;
}

export function assistantEventTranscriptText(lane, { limit = 80 } = {}) {
  const events = Array.isArray(lane?.agentEvents) ? lane.agentEvents.slice(-limit) : [];
  const finalText = String(lane?.resultText || '').trim() || events
    .filter((item) => String(item.type || '') === 'message.assistant.final')
    .map((item) => String(item.content || '').trim())
    .filter(Boolean)
    .at(-1);
  const deltaText = events
    .filter((item) => String(item.type || '') === 'message.assistant.delta')
    .map((item) => String(item.content || '').trim())
    .filter(Boolean)
    .join('');
  const doneText = events
    .filter((item) => String(item.type || '') === 'agent.done')
    .map((item) => String(item.content || '').trim())
    .filter((content) => content && !isGenericCompletionText(content, lane))
    .at(-1);
  const stdoutText = events
    .filter((item) => String(item.type || '') === 'command.output' && String(item.stream || 'stdout') !== 'stderr')
    .map((item) => readableCommandOutput(item.content))
    .filter(Boolean)
    .slice(-3)
    .join('\n');
  const errorText = events
    .filter((item) => String(item.type || '') === 'error')
    .map((item) => String(item.content || '').trim())
    .filter(Boolean)
    .at(-1);
  return finalText || deltaText || doneText || stdoutText || (lane?.state === 'failed' ? errorText : '') || '';
}

export function modelPresetOptions(selected = '') {
  const normalized = String(selected || '').trim();
  // No hardcoded model version numbers — they go stale (e.g. Opus 4.7 -> 4.8).
  // Real per-CLI values come from detected capabilities (modelPresetOptionsFor);
  // this fallback only offers Default and preserves a custom selection so a
  // typed model (any current slug) is never dropped.
  const options = [['', 'Default (CLI config)']];
  if (normalized && !options.some(([value]) => value === normalized)) options.push([normalized, normalized]);
  return options.map(([value, label]) => `<option value="${safeAttr(value)}"${normalized === value ? ' selected' : ''}>${safeText(label)}</option>`).join('');
}

export function intelligenceOptions(selected = 'high') {
  const normalized = String(selected || 'high').trim().toLowerCase();
  return [
    ['low', 'Low'],
    ['medium', 'Medium'],
    ['high', 'High'],
    ['xhigh', 'Extra high'],
    ['max', 'Max'],
  ].map(([value, label]) => `<option value="${safeAttr(value)}"${normalized === value ? ' selected' : ''}>${safeText(label)}</option>`).join('');
}

export function runModeOptions(selected = 'auto-edit') {
  const normalized = String(selected || 'auto-edit').trim();
  return [
    ['plan', 'Plan'],
    ['read-only', 'Read only'],
    ['auto-edit', 'Auto edit'],
    ['acceptEdits', 'Accept edits'],
    ['bypassPermissions', 'Bypass permissions'],
  ].map(([value, label]) => `<option value="${safeAttr(value)}"${normalized === value ? ' selected' : ''}>${safeText(label)}</option>`).join('');
}

// --- Dynamic per-executor control options --------------------------------
// Build <option> HTML from a SELECTED executor's detected capabilities
// (controls.permissions / .intelligence / .model) so each CLI shows its own
// real modes, effort levels, and models. When capabilities aren't available
// (mock, undetected CLI, offline) we fall back to the static superset so the
// form is never empty.
function optionListHtml(values, selected) {
  const normalized = String(selected || '').trim();
  return values
    .map((value) => `<option value="${safeAttr(value)}"${normalized === value ? ' selected' : ''}>${safeText(value)}</option>`)
    .join('');
}

function executorControl(executorType, control) {
  const profile = getExecutorProfile(executorType);
  const node = profile?.capabilities?.controls?.[control];
  return node && typeof node === 'object' ? node : null;
}

export function runModeOptionsFor(executorType, selected = 'auto-edit') {
  const node = executorControl(executorType, 'permissions');
  if (!node || !Array.isArray(node.values) || !node.values.length) return runModeOptions(selected);
  return optionListHtml(node.values, selected);
}

export function intelligenceOptionsFor(executorType, selected = 'high') {
  const node = executorControl(executorType, 'intelligence');
  if (!node) return intelligenceOptions(selected);
  // Always offer the effort levels when the CLI declares them, even if it's a
  // passthrough (config-driven) flag — the operator still wants to pick effort.
  if (Array.isArray(node.values) && node.values.length) return optionListHtml(node.values, selected);
  if (node.supported === false || node.passthrough) {
    return '<option value="" selected>Default (CLI config)</option>';
  }
  return intelligenceOptions(selected);
}

export function modelPresetOptionsFor(executorType, selected = '') {
  const node = executorControl(executorType, 'model');
  if (!node || !Array.isArray(node.values) || !node.values.length) return modelPresetOptions(selected);
  const normalized = String(selected || '').trim();
  const defaultLabel = node.defaultValue ? `Default (${node.defaultValue})` : 'Default';
  const head = `<option value=""${normalized === '' ? ' selected' : ''}>${safeText(defaultLabel)}</option>`;
  return head + optionListHtml(node.values, selected);
}

// Repopulate the permission/intelligence/model selects of a form (orchestrator
// composer or any executor-scoped form) when its executor changes, preserving
// the prior selection when the new executor still supports it.
export function repopulateExecutorScopedControls(form) {
  if (!form) return;
  const executorType = normalizeExecutorType(form.executorType?.value || '');
  const mode = form.querySelector('select[name="permissionsProfile"]');
  if (mode) mode.innerHTML = runModeOptionsFor(executorType, mode.value);
  const intelligence = form.querySelector('select[name="intelligenceProfile"]');
  if (intelligence) intelligence.innerHTML = intelligenceOptionsFor(executorType, intelligence.value);
  const modelPreset = form.querySelector('select[name="modelPreset"]');
  if (modelPreset) modelPreset.innerHTML = modelPresetOptionsFor(executorType, modelPreset.value);
}
