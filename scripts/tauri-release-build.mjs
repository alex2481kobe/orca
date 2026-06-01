import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localUpdaterKey = path.join(root, '.tauri', 'orca-updater.key');
const releaseConfig = path.join(root, 'src-tauri', 'tauri.release.conf.json');
const bundleArgIndex = process.argv.indexOf('--bundles');
const bundles = bundleArgIndex >= 0
  ? process.argv[bundleArgIndex + 1]
  : process.env.ORCA_TAURI_BUNDLES || 'app';

if (!bundles) {
  console.error('[tauri-release-build] --bundles requires a value');
  process.exit(1);
}

if (!process.env.TAURI_SIGNING_PRIVATE_KEY && !process.env.TAURI_SIGNING_PRIVATE_KEY_PATH) {
  if (existsSync(localUpdaterKey)) {
    process.env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(localUpdaterKey, 'utf8').trim();
  } else {
    console.error('[tauri-release-build] missing updater signing key');
    console.error('Set TAURI_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY_PATH.');
    console.error(`For local testing, generate one with: npm run tauri signer generate -- --ci --write-keys ${localUpdaterKey}`);
    process.exit(1);
  }
} else if (!process.env.TAURI_SIGNING_PRIVATE_KEY && process.env.TAURI_SIGNING_PRIVATE_KEY_PATH) {
  process.env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(process.env.TAURI_SIGNING_PRIVATE_KEY_PATH, 'utf8').trim();
}

const args = [
  'run',
  'tauri',
  '--',
  'build',
  '--ci',
  '--config',
  releaseConfig,
  '--bundles',
  bundles,
];

const child = spawn('npm', args, {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`[tauri-release-build] terminated by ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
