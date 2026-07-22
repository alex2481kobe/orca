// Icon source of truth for the Orca design system. Never inline a raw <svg> in a
// render module — add it here and use icon(name, {cls, size}).
const STROKE_ICONS = {
  'chevron-down': { vb: '0 0 20 20', sw: 1.7, inner: '<path d="M5 8l5 5 5-5"/>' },
  'chevron-right': { vb: '0 0 20 20', sw: 1.7, inner: '<path d="M8 5l5 5-5 5"/>' },
  'chevron-left': { vb: '0 0 20 20', sw: 1.7, inner: '<path d="M12 5l-5 5 5 5"/>' },
  close: { vb: '0 0 20 20', sw: 1.7, inner: '<path d="M5 5l10 10M15 5L5 15"/>' },
  info: { vb: '0 0 20 20', sw: 1.7, inner: '<circle cx="10" cy="10" r="7"/><path d="M10 9v4M10 6.8h.01"/>' },
  // Settings as control sliders (reads as "configure", lighter than a cog).
  settings: { vb: '0 0 20 20', sw: 1.7, inner: '<path d="M3 6.5h6M13 6.5h4M3 13.5h2M9 13.5h8"/><circle cx="11" cy="6.5" r="2"/><circle cx="7" cy="13.5" r="2"/>' },
  // Sidebar collapse toggle (a panel with a divider).
  'panel-left': { vb: '0 0 20 20', sw: 1.5, inner: '<rect x="2.5" y="3.5" width="15" height="13" rx="2.2"/><path d="M7.5 3.5v13"/>' },
  // Remote / broadcast (the phone-over-Tailscale screen).
  remote: { vb: '0 0 20 20', sw: 1.6, inner: '<path d="M4 12a8.5 8.5 0 0 1 12 0M6.5 9.5a5 5 0 0 1 7 0"/><circle cx="10" cy="14.5" r="1.3" fill="currentColor" stroke="none"/>' },
  // An agent/orchestrator glyph (a friendly bot head).
  agent: { vb: '0 0 20 20', sw: 1.6, inner: '<rect x="4.5" y="6.5" width="11" height="8" rx="2.4"/><path d="M10 6.5V4M8 10.5h.01M12 10.5h.01"/><circle cx="10" cy="3.2" r="1"/>' },
  // External link / open-preview (a registered dev-server port, opened over Tailscale).
  external: { vb: '0 0 20 20', sw: 1.6, inner: '<path d="M11 4h5v5M16 4l-7 7"/><path d="M14 11.5V15a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 4 15V8a1.5 1.5 0 0 1 1.5-1.5H9"/>' },
  // Refresh / regenerate (new pairing code). A ~270° arc centered at (10,10) with
  // an OBVIOUS ~90° gap at the top and an arrowhead at the top-right terminus, so
  // it clearly reads as a circular arrow (not a closed circle).
  refresh: { vb: '0 0 20 20', sw: 1.5, inner: '<path d="M14.2 5.8A6 6 0 1 1 5.8 5.8"/><path d="M11.4 4.2l2.8 1.6 1.5-2.9"/>' },
};

export function icon(name, { cls = '', size = 16 } = {}) {
  const it = STROKE_ICONS[name];
  if (!it) return '';
  const klass = cls ? ` class="${cls}"` : '';
  return `<svg${klass} viewBox="${it.vb}" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${it.sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${it.inner}</svg>`;
}

// Bespoke folder glyph for projects (its own design; fill/size via CSS).
export const FOLDER_ICON = `
  <span class="side-folder" aria-hidden="true">
    <svg viewBox="0 0 20 16" focusable="false">
      <path d="M1.5 4.5h6l1.4 2h9.6v7.2c0 .7-.6 1.3-1.3 1.3H2.8c-.7 0-1.3-.6-1.3-1.3V4.5Z"></path>
      <path d="M1.5 4.5V3c0-.8.6-1.4 1.4-1.4h4.4l1.5 1.8h8c.8 0 1.4.6 1.4 1.4v1.7"></path>
    </svg>
  </span>`;
