// Regression guard for the iOS bottom-toolbar bug: when a (min-)height is
// declared twice with both `vh` and `dvh`, the `dvh` line MUST come last so it
// wins on modern browsers. The reverse order lets `100vh` (the LARGE iOS
// viewport, toolbar hidden) override `100dvh` and push content behind Safari/
// Chrome's bottom toolbar, cutting off the bottom of the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.join(here, '..', 'public', 'styles.css'), 'utf8');

// Index of the first standalone `vh` (not the tail of `dvh`) in a string, or -1.
// Units are preceded by digits, so no leading word-boundary on the unit itself.
function vhIndex(s) {
  const m = /(?<!d)vh\b/.exec(s);
  return m ? m.index : -1;
}

test('viewport-height fallbacks declare dvh AFTER vh (never dvh-then-vh)', () => {
  const lines = css.split('\n');
  const isHeightDecl = (l) => /\b(min-height|height)\s*:/.test(l);
  const hasDvh = (l) => /dvh\b/.test(l);
  const hasStandaloneVh = (l) => vhIndex(l) !== -1;
  const offenders = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // Same-line pair: both units present, dvh must come AFTER vh.
    if (isHeightDecl(line) && hasDvh(line) && hasStandaloneVh(line)) {
      if (line.indexOf('dvh') < vhIndex(line)) offenders.push(`L${i + 1}: ${line.trim()}`);
    }
    // Adjacent-line pair: a dvh height line immediately followed by a vh one.
    const next = lines[i + 1] || '';
    if (isHeightDecl(line) && hasDvh(line) && !hasStandaloneVh(line)
        && isHeightDecl(next) && hasStandaloneVh(next) && !hasDvh(next)) {
      offenders.push(`L${i + 1}-${i + 2}: ${line.trim()} / ${next.trim()}`);
    }
  }

  assert.equal(offenders.length, 0, `dvh declared before vh (will break iOS bottom toolbar):\n${offenders.join('\n')}`);
});
