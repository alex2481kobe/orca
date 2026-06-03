// Custom modal dialogs (confirm / prompt) so the native browser confirm()/
// prompt() chrome never appears. Drop-in async replacements:
//   await confirmDialog(message, { danger, confirmLabel })  -> boolean
//   await promptDialog(message, defaultValue)               -> string | null

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = String(value ?? '');
  return div.innerHTML;
}

function openDialog(cfg) {
  return new Promise((resolve) => {
    const isPrompt = cfg.kind === 'prompt';
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        ${cfg.title ? `<h3 class="modal-title">${escapeHtml(cfg.title)}</h3>` : ''}
        <div class="modal-message">${escapeHtml(cfg.message)}</div>
        ${isPrompt ? '<input class="modal-input" type="text" />' : ''}
        <div class="modal-actions">
          <button class="modal-cancel secondary" type="button">${escapeHtml(cfg.cancelLabel || 'Cancel')}</button>
          <button class="modal-confirm${cfg.danger ? ' danger' : ''}" type="button">${escapeHtml(cfg.confirmLabel || (isPrompt ? 'Save' : 'Confirm'))}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('.modal-input');
    const previousFocus = document.activeElement;

    const finish = (value) => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      try { previousFocus && previousFocus.focus && previousFocus.focus(); } catch { /* ignore */ }
      resolve(value);
    };
    const onConfirm = () => finish(isPrompt ? (input ? input.value : '') : true);
    const onCancel = () => finish(isPrompt ? null : false);

    overlay.querySelector('.modal-confirm').addEventListener('click', onConfirm);
    overlay.querySelector('.modal-cancel').addEventListener('click', onCancel);
    overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) onCancel(); });
    const onKey = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); onCancel(); }
      else if (event.key === 'Enter' && (!isPrompt || document.activeElement === input)) { event.preventDefault(); onConfirm(); }
    };
    document.addEventListener('keydown', onKey, true);

    if (input) {
      input.value = cfg.defaultValue != null ? String(cfg.defaultValue) : '';
      input.focus();
      input.select();
    } else {
      overlay.querySelector('.modal-confirm').focus();
    }
  });
}

export function confirmDialog(message, options = {}) {
  return openDialog({ kind: 'confirm', message, ...options });
}

export function promptDialog(message, defaultValue = '', options = {}) {
  return openDialog({ kind: 'prompt', message, defaultValue, ...options });
}
