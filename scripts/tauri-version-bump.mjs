import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv.find((arg) => !arg.startsWith('--') && arg !== process.argv[1] && arg !== process.argv[0]);
const dryRun = process.argv.includes('--dry-run');
const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

if (!version || !semverPattern.test(version)) {
  console.error('[tauri-version-bump] usage: npm run tauri:version -- 0.2.0 [--dry-run]');
  process.exit(1);
}

async function readJson(relativePath) {
  return JSON.parse(await fs.readFile(path.join(root, relativePath), 'utf8'));
}

async function writeJson(relativePath, value) {
  if (dryRun) return;
  await fs.writeFile(path.join(root, relativePath), `${JSON.stringify(value, null, 2)}\n`);
}

const packageJson = await readJson('package.json');
const packageLock = await readJson('package-lock.json');
const tauriConfig = await readJson('src-tauri/tauri.conf.json');

const previous = {
  packageJson: packageJson.version,
  packageLock: packageLock.version,
  tauriConfig: tauriConfig.version,
};

packageJson.version = version;
packageLock.version = version;
if (packageLock.packages?.['']) {
  packageLock.packages[''].version = version;
}
tauriConfig.version = version;

await writeJson('package.json', packageJson);
await writeJson('package-lock.json', packageLock);
await writeJson('src-tauri/tauri.conf.json', tauriConfig);

const action = dryRun ? 'would update' : 'updated';
console.log(`[tauri-version-bump] ${action} package.json ${previous.packageJson} -> ${version}`);
console.log(`[tauri-version-bump] ${action} package-lock.json ${previous.packageLock} -> ${version}`);
console.log(`[tauri-version-bump] ${action} src-tauri/tauri.conf.json ${previous.tauriConfig} -> ${version}`);
