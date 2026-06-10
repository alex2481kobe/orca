// Install the freshest built Orca.app onto the connected iPhone via devicectl.
//
// Why a script (and not Xcode's ▶): the Tauri iOS Rust build-script panics under
// a bare Xcode run (it needs the dev-server addr file only `tauri ios dev` writes),
// so device installs go through the CLI. And `tauri ios build` does NOT reliably
// refresh the exported .ipa, so we install the freshly-built .app DIRECTLY from
// DerivedData instead of the (often stale) IPA.
//
// Usage:
//   npm run ios:install            # installs the freshest build (release preferred)
//   npm run ios:install -- debug   # force the debug build
//   npm run ios:install -- release # force the release build
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const want = (process.argv[2] || '').toLowerCase(); // '', 'debug', or 'release'

function sh(cmd) { return execSync(cmd, { encoding: 'utf8' }); }

// 1) Find a connected, paired device + its identifier (UUID).
const devLines = sh('xcrun devicectl list devices').split('\n');
const devRow = devLines.find((l) => /available \(paired\)/.test(l) && /iPhone|iPad/i.test(l));
if (!devRow) {
  console.error('No paired iPhone/iPad found. Connect + unlock the device (Developer Mode on) and retry.');
  process.exit(1);
}
const udid = (devRow.match(/[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/) || [])[0];
const devName = devRow.trim().split(/\s{2,}/)[0];
if (!udid) { console.error('Could not parse the device identifier from devicectl output.'); process.exit(1); }

// 2) Find the freshest Orca.app under DerivedData. Prefer release unless overridden.
const ddRoot = path.join(os.homedir(), 'Library/Developer/Xcode/DerivedData');
const candidates = [];
for (const dir of fs.existsSync(ddRoot) ? fs.readdirSync(ddRoot) : []) {
  if (!dir.startsWith('orca-desktop-')) continue;
  for (const cfg of ['release-iphoneos', 'debug-iphoneos']) {
    const app = path.join(ddRoot, dir, 'Build/Products', cfg, 'Orca.app');
    const bin = path.join(app, 'Orca');
    if (fs.existsSync(bin)) {
      candidates.push({ app, cfg: cfg.startsWith('release') ? 'release' : 'debug', mtime: fs.statSync(bin).mtimeMs });
    }
  }
}
const pool = (want === 'release' || want === 'debug')
  ? candidates.filter((c) => c.cfg === want)
  : candidates;
// Prefer release over debug; within the same config, the freshest build wins.
pool.sort((a, b) => (a.cfg === b.cfg ? b.mtime - a.mtime : a.cfg === 'release' ? -1 : 1));
const target = pool[0];
if (!target) {
  console.error(`No built Orca.app found${want ? ` for ${want}` : ''}. Build first: npm run ios:build (release) or npm run ios:dev (debug).`);
  process.exit(1);
}

// 3) Report size, then install.
const sizeMB = (Number(sh(`du -sk "${target.app}"`).split('\t')[0]) / 1024).toFixed(1);
console.log(`[ios-install] device: ${devName} (${udid})`);
console.log(`[ios-install] app:    ${target.cfg} build — ${sizeMB} MB — ${target.app}`);
console.log('[ios-install] installing…');
execSync(`xcrun devicectl device install app --device ${udid} "${target.app}"`, { stdio: 'inherit' });
console.log('[ios-install] done. Launch Orca on the device.');
