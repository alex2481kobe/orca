import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await fs.readFile(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const archMap = {
  arm64: 'aarch64',
  x64: 'x86_64',
};
const platformMap = {
  darwin: 'darwin',
  win32: 'windows',
  linux: 'linux',
};

const target = platformMap[os.platform()];
const arch = archMap[os.arch()] || os.arch();
if (!target) {
  throw new Error(`Unsupported updater manifest platform: ${os.platform()}`);
}

const bundleDir = path.join(root, 'src-tauri', 'target', 'release', 'bundle', 'macos');
const artifactName = process.env.ORCA_UPDATE_ARTIFACT || `${config.productName}.app.tar.gz`;
const signaturePath = process.env.ORCA_UPDATE_SIGNATURE || path.join(bundleDir, `${artifactName}.sig`);
const artifactUrl = process.env.ORCA_UPDATE_ARTIFACT_URL;

if (!artifactUrl) {
  console.error('[tauri-release-manifest] missing ORCA_UPDATE_ARTIFACT_URL');
  console.error('Example: ORCA_UPDATE_ARTIFACT_URL=https://github.com/alex2481kobe/orca/releases/download/v0.1.0/Command%20Deck.app.tar.gz npm run tauri:release-manifest');
  process.exit(1);
}

if (!existsSync(signaturePath)) {
  console.error(`[tauri-release-manifest] missing signature file: ${signaturePath}`);
  process.exit(1);
}

const signature = (await fs.readFile(signaturePath, 'utf8')).trim();
const now = new Date().toISOString();
const manifest = {
  version: config.version,
  notes: process.env.ORCA_UPDATE_NOTES || `Orca ${config.version}`,
  pub_date: process.env.ORCA_UPDATE_PUB_DATE || now,
  platforms: {
    [`${target}-${arch}`]: {
      signature,
      url: artifactUrl,
    },
  },
};

const output = process.env.ORCA_UPDATE_MANIFEST || path.join(root, 'artifacts', 'tauri', 'latest.json');
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`[tauri-release-manifest] wrote ${output}`);
