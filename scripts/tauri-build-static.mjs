import fs from 'node:fs';
import path from 'node:path';

const requiredAssets = [
  'index.html',
  'app.js',
  'styles.css',
  'manifest.webmanifest',
  'service-worker.js',
];

const publicDir = path.resolve('public');
const missing = requiredAssets.filter((asset) => !fs.existsSync(path.join(publicDir, asset)));

if (missing.length) {
  console.error(`[tauri-build-static] missing public asset(s): ${missing.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log(`[tauri-build-static] static frontend ready: ${publicDir}`);
}
