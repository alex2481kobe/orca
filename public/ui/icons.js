// Icon source of truth for the Orca design system.
//
// ADD NEW ICONS HERE — never inline a raw <svg> in a render module. Two kinds:
//   1. Stroke icons (the common case): line glyphs that inherit text color and
//      scale via size. Use icon(name, { cls, size }). Pass `cls` when CSS targets
//      the svg (e.g. a chevron that rotates on open); pass `size` to override the
//      default 16px square.
//   2. Bespoke decorative glyphs: their own multi-path designs / CSS-driven fill.
//      Exported as ready-to-drop-in markup strings.

// Stroke-icon registry: viewBox, stroke-width, and inner markup. Everything else
// (currentColor, round caps/joins, no fill, aria-hidden) is applied by icon().
const STROKE_ICONS = {
  'chevron-down': { vb: '0 0 20 20', sw: 1.7, inner: '<path d="M5 8l5 5 5-5"/>' },
  'chevron-right': { vb: '0 0 20 20', sw: 1.7, inner: '<path d="M8 5l5 5-5 5"/>' },
  'chevron-up': { vb: '0 0 20 20', sw: 1.7, inner: '<path d="M5 12l5-5 5 5"/>' },
  close: { vb: '0 0 20 20', sw: 1.7, inner: '<path d="M5 5l10 10M15 5L5 15"/>' },
  plus: { vb: '0 0 20 20', sw: 1.7, inner: '<path d="M10 4.5v11M4.5 10h11"/>' },
  send: { vb: '0 0 20 20', sw: 2, inner: '<path d="M10 15.5V5M5.5 9.5L10 5l4.5 4.5"/>' },
  branch: { vb: '0 0 20 20', sw: 1.6, inner: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="15" r="2"/><circle cx="14" cy="7" r="2"/><path d="M6 7v6M14 9c0 3-3 3.5-6 3.5"/>' },
  'panel-right': { vb: '0 0 20 20', sw: 1.5, inner: '<rect x="2.5" y="3.5" width="15" height="13" rx="2.2"/><path d="M12.5 3.5v13"/>' },
  terminal: { vb: '0 0 20 20', sw: 1.6, inner: '<rect x="2.5" y="4" width="15" height="12" rx="2.2"/><path d="M6 8l2.2 2L6 12M10 12h4"/>' },
  code: { vb: '0 0 20 20', sw: 1.7, inner: '<path d="M7.5 6 4 10l3.5 4M12.5 6 16 10l-3.5 4"/>' },
  'folder-rounded': { vb: '0 0 24 24', sw: 1.6, inner: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.2h6a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>' },
  info: { vb: '0 0 20 20', sw: 1.7, inner: '<circle cx="10" cy="10" r="7"/><path d="M10 9v4M10 6.8h.01"/>' },
  more: { vb: '0 0 20 20', sw: 0, inner: '<circle cx="4.5" cy="10" r="1.4" fill="currentColor"/><circle cx="10" cy="10" r="1.4" fill="currentColor"/><circle cx="15.5" cy="10" r="1.4" fill="currentColor"/>' },
  // Settings as control sliders (reads as "configure", lighter than a cog).
  settings: { vb: '0 0 20 20', sw: 1.7, inner: '<path d="M3 6.5h6M13 6.5h4M3 13.5h2M9 13.5h8"/><circle cx="11" cy="6.5" r="2"/><circle cx="7" cy="13.5" r="2"/>' },
  // Microphone (voice dictation into the composer).
  mic: { vb: '0 0 20 20', sw: 1.6, inner: '<rect x="7.5" y="2.5" width="5" height="9" rx="2.5"/><path d="M5 9.5a5 5 0 0 0 10 0M10 14.5v3M7.5 17.5h5"/>' },
};

export function icon(name, { cls = '', size = 16 } = {}) {
  const it = STROKE_ICONS[name];
  if (!it) return '';
  const klass = cls ? ` class="${cls}"` : '';
  return `<svg${klass} viewBox="${it.vb}" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${it.sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${it.inner}</svg>`;
}

// Bespoke decorative glyphs (own designs; fill/size driven by their CSS).
export const FOLDER_ICON = `
  <span class="sidebar-folder" aria-hidden="true">
    <svg viewBox="0 0 20 16" focusable="false">
      <path d="M1.5 4.5h6l1.4 2h9.6v7.2c0 .7-.6 1.3-1.3 1.3H2.8c-.7 0-1.3-.6-1.3-1.3V4.5Z"></path>
      <path d="M1.5 4.5V3c0-.8.6-1.4 1.4-1.4h4.4l1.5 1.8h8c.8 0 1.4.6 1.4 1.4v1.7"></path>
    </svg>
  </span>
`;
export const COMPOSE_ICON = `
  <svg viewBox="0 0 20 20" focusable="false" aria-hidden="true">
    <path d="M4.2 2.8h7.2a1.4 1.4 0 0 1 1.4 1.4v2.4"></path>
    <path d="M9.8 17.2H4.2a1.4 1.4 0 0 1-1.4-1.4V4.2a1.4 1.4 0 0 1 1.4-1.4"></path>
    <path d="m11.1 14.7 4.9-4.9 2.1 2.1-4.9 4.9-2.7.6.6-2.7Z"></path>
  </svg>
`;
export const ARCHIVE_ICON = `
  <svg viewBox="0 0 20 20" focusable="false" aria-hidden="true">
    <path d="M3.2 6.5h13.6"></path>
    <path d="M5 6.5v9.2c0 .8.6 1.4 1.4 1.4h7.2c.8 0 1.4-.6 1.4-1.4V6.5"></path>
    <path d="M7.2 3.3h5.6l.8 3.2H6.4l.8-3.2Z"></path>
    <path d="M8 10h4"></path>
  </svg>
`;
