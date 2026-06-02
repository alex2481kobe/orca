// Focused type-check gate: runs `tsc --noEmit` (loose tsconfig) but fails ONLY on
// the high-value "undefined name / broken import" error class — the bugs that
// repeatedly bit this codebase (missing imports, methods moved between modules,
// stray references). This class has zero false positives from DOM-cast noise
// (TS2339) or the OrcaRegistry prototype-mixin pattern (TS2551), so it is safe
// as a CI gate even while the broader `npm run typecheck` still reports DOM noise.
//
// Usage: node scripts/typecheck-imports.mjs   (exit 1 if any blocking error)
import { spawnSync } from 'node:child_process';

// TS2304 cannot find name | TS2552 cannot find name (did you mean) |
// TS2305 module has no exported member | TS2724 no exported member (did you mean)
const BLOCKING = /error TS(2304|2305|2552|2724):/;

const res = spawnSync('node', ['node_modules/.bin/tsc', '--noEmit'], { encoding: 'utf8' });
const lines = `${res.stdout || ''}${res.stderr || ''}`.split('\n');
const blocking = lines.filter((l) => BLOCKING.test(l));

if (blocking.length) {
  console.error('[typecheck-imports] BLOCKING undefined-name / broken-import errors:\n');
  for (const l of blocking) console.error('  ' + l);
  console.error(`\n[typecheck-imports] ${blocking.length} blocking error(s). Fix the missing imports / references.`);
  process.exit(1);
}
console.log('[typecheck-imports] ok — no undefined-name or broken-import errors.');
