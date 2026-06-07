#!/usr/bin/env node
// Guard: no hardcoded theme colors in public/styles.css.
//
// The design system is token-driven (var(--bg/--text/--ok/...)) so the app can
// flip between dark and light themes. A raw hex like `color: #c2c2c2` silently
// breaks that — it looks fine in the theme it was eyeballed in and wrong in the
// other (the "looks right in dark, broken in light" bug class). This guard fails
// CI if any rule reintroduces a raw theme color.
//
// What is allowed:
//   1. The token DEFINITIONS themselves (the `:root { ... }` blocks). That's the
//      single place raw values are supposed to live.
//   2. `var(--token, #fallback)` — the fallback after a token reference is fine.
//   3. Theme-neutral primitives: pure white / black in any form, and rgb()/rgba()
//      whose channels are all-0 or all-255 (used for hover/line/shadow overlays
//      that read correctly on any surface).
//   4. A small, explicit allowlist of EXEMPT SURFACES that intentionally fix both
//      their background AND foreground so they stay constant across themes
//      (a terminal is dark; a QR code is light for camera scanning; a code block
//      keeps its own palette). These must set both bg and text to be self-consistent.
//
// Anything else is a violation. Run: npm run smoke:no-hardcoded-colors

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const cssPath = resolve(here, '..', 'public', 'styles.css');
const css = readFileSync(cssPath, 'utf8');

// Selectors whose rule bodies may carry fixed (non-token) colors because they are
// deliberately theme-constant surfaces. Keep this list short and justified.
const EXEMPT_SELECTOR = /(^|[\s,])(pre\b|\.qr-code|\.qr-fallback|\.lane-stream|\.picker-row-icon|\.ios-promo-icon)/;

// White/black in any common spelling — theme-neutral contrast primitives.
const isNeutralHex = (hex) => /^#(fff|000|ffffff|000000)$/i.test(hex);

// Strip comments first so a hex inside /* ... */ is never flagged.
// Blank out comment CONTENT but keep newlines, so reported line numbers stay accurate.
const noComments = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

// Walk top-level rules: prelude `{` body `}`. styles.css has no nested at-rules
// with their own braces around color decls except @media, which we descend into
// by treating the whole @media block's inner rules the same way (the regex below
// matches the innermost `selector { decls }` pairs, so @media wrappers are skipped
// naturally and their inner rules are still checked).
const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
const violations = [];
let m;
while ((m = ruleRe.exec(noComments)) !== null) {
  const prelude = m[1];
  const body = m[2];
  const bodyStart = m.index + m[1].length + 1;

  // Token definition blocks: the one legal home for raw values.
  if (/(^|[\s,]):root\b/.test(prelude)) continue;
  // @media / @supports / @keyframes preludes carry no color decls themselves.
  if (/^@/.test(prelude.trim()) && !body.includes(':')) continue;
  if (EXEMPT_SELECTOR.test(prelude)) continue;

  // Remove var(--token, fallback) so the fallback hex is not flagged.
  const scrubbed = body.replace(/var\([^)]*\)/g, ' ');

  // Hex colors.
  const hexRe = /#[0-9a-fA-F]{3,8}\b/g;
  let h;
  while ((h = hexRe.exec(scrubbed)) !== null) {
    if (isNeutralHex(h[0])) continue;
    const absIdx = bodyStart + h.index;
    const line = noComments.slice(0, absIdx).split('\n').length;
    violations.push({ line, selector: prelude.trim().split('\n').pop().trim(), color: h[0] });
  }

  // Non-neutral rgb()/rgba().
  const rgbRe = /rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)/g;
  let r;
  while ((r = rgbRe.exec(scrubbed)) !== null) {
    const [rr, gg, bb] = [r[1], r[2], r[3]].map(Number);
    const allZero = rr === 0 && gg === 0 && bb === 0;
    const allMax = rr === 255 && gg === 255 && bb === 255;
    if (allZero || allMax) continue;
    const absIdx = bodyStart + r.index;
    const line = noComments.slice(0, absIdx).split('\n').length;
    violations.push({ line, selector: prelude.trim().split('\n').pop().trim(), color: r[0] + ')' });
  }
}

if (violations.length) {
  console.error(`\n✗ Found ${violations.length} hardcoded theme color(s) in public/styles.css.`);
  console.error('  Use a design token (var(--…)) or color-mix(... var(--token) ...) instead,');
  console.error('  or add a justified selector to EXEMPT_SELECTOR if it must stay theme-constant.\n');
  for (const v of violations) {
    console.error(`  styles.css:${v.line}  ${v.color}   (${v.selector})`);
  }
  console.error('');
  process.exit(1);
}

console.log('✓ No hardcoded theme colors outside token definitions / exempt surfaces.');
