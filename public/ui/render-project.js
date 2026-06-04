// Render view module (split from render-views.js).

import { shell } from './state.js';
import { safeAttr, safeText } from './format.js';

const PICKER_FOLDER_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2.2h6a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/></svg>';
const PICKER_CHEVRON = '<svg class="picker-chevron" viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M8 5l5 5-5 5"/></svg>';

export function renderWorkstationPickerPanel(forInput) {
  const picker = shell.workstationPicker;
  if (!picker || !picker.open || picker.forInput !== forInput) return '';
  const entries = Array.isArray(picker.entries) ? picker.entries : [];
  const current = picker.path || '';
  const folderName = current ? (current.split('/').filter(Boolean).pop() || current) : 'Home';
  const rows = entries.map((entry) => `
    <button class="picker-row" data-action="workstationOpenDir" data-dir="${safeAttr(entry.path)}" data-for-input="${safeAttr(forInput)}" type="button">
      <span class="picker-row-icon">${PICKER_FOLDER_ICON}</span>
      <span class="picker-row-name">${safeText(entry.name)}</span>
      ${entry.isGitRepo ? '<span class="picker-row-tag">git</span>' : ''}
      ${PICKER_CHEVRON}
    </button>`).join('');
  return `
    <div class="picker" role="group" aria-label="Choose a project folder">
      <div class="picker-titlebar">
        <strong>Choose a project folder</strong>
        <button class="picker-x" data-action="workstationPickerClose" type="button" aria-label="Close">
          <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M5 5l10 10M15 5L5 15"/></svg>
        </button>
      </div>
      <div class="picker-toolbar">
        <button class="picker-up" data-action="workstationOpenDir" data-dir="${safeAttr(picker.parent || '')}" data-for-input="${safeAttr(forInput)}" type="button" ${picker.parent ? '' : 'disabled'} aria-label="Up one level">
          <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5-5 5 5"/></svg>
        </button>
        <span class="picker-path" title="${safeAttr(current)}">${safeText(current || 'Home')}</span>
      </div>
      ${picker.error ? `<div class="picker-error">${safeText(picker.error)}</div>` : ''}
      <div class="picker-list">
        ${picker.loading ? '<div class="picker-empty">Loading…</div>' : (rows || '<div class="picker-empty">This folder has no subfolders.</div>')}
      </div>
      <div class="picker-footer">
        <span class="picker-footer-name">${safeText(folderName)}</span>
        <div class="picker-footer-actions">
          <button class="btn-ghost" data-action="workstationPickerClose" type="button">Cancel</button>
          <button class="btn" data-action="workstationUseDir" data-dir="${safeAttr(current)}" data-for-input="${safeAttr(forInput)}" type="button" ${current ? '' : 'disabled'}>Open this folder</button>
        </div>
      </div>
    </div>`;
}
