import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv.includes('--local') ? 'local' : 'ci';
const requireUploadToken = mode === 'ci' || process.argv.includes('--require-upload-token');
const env = process.env;

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function exists(relativePathOrAbsolute) {
  const filePath = path.isAbsolute(relativePathOrAbsolute)
    ? relativePathOrAbsolute
    : path.join(root, relativePathOrAbsolute);
  return fs.existsSync(filePath);
}

function envPresent(name) {
  return Boolean(String(env[name] || '').trim());
}

function fileEnvPresent(name) {
  return envPresent(name) && fs.existsSync(env[name]);
}

function record(checks, ok, label, fix) {
  checks.push({ ok, label, fix });
}

const checks = [];
const packageJson = readJson('package.json');
const tauriConfig = readJson('src-tauri/tauri.conf.json');
const releaseConfig = readJson('src-tauri/tauri.release.conf.json');

record(
  checks,
  packageJson.version === tauriConfig.version,
  'package.json version matches src-tauri/tauri.conf.json version',
  'Update both version fields before cutting a release.',
);

record(
  checks,
  Boolean(releaseConfig?.plugins?.updater?.pubkey),
  'Tauri updater public key is configured',
  'Generate an updater keypair and commit only the public key in src-tauri/tauri.release.conf.json.',
);

record(
  checks,
  Array.isArray(releaseConfig?.plugins?.updater?.endpoints)
    && releaseConfig.plugins.updater.endpoints.every((endpoint) => /^https:\/\//i.test(endpoint)),
  'Tauri updater endpoints are HTTPS',
  'Set plugins.updater.endpoints to the HTTPS latest.json location.',
);

const localUpdaterKey = exists('.tauri/orca-updater.key');
const updaterKeyReady = envPresent('TAURI_SIGNING_PRIVATE_KEY')
  || fileEnvPresent('TAURI_SIGNING_PRIVATE_KEY_PATH')
  || (mode === 'local' && localUpdaterKey);

record(
  checks,
  updaterKeyReady,
  mode === 'local'
    ? 'Updater private key is available from env or local ignored .tauri key'
    : 'Updater private key is available from CI secrets',
  'Set TAURI_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY_PATH. For local dry runs, use --local after generating .tauri/orca-updater.key.',
);

const appleCertificateReady = envPresent('APPLE_CERTIFICATE') && envPresent('APPLE_CERTIFICATE_PASSWORD');
const localSigningIdentityReady = mode === 'local' && envPresent('APPLE_SIGNING_IDENTITY');

record(
  checks,
  appleCertificateReady || localSigningIdentityReady,
  mode === 'local'
    ? 'Apple signing material is available from CI certificate secrets or local signing identity'
    : 'Apple signing certificate is available from CI secrets',
  'Set APPLE_CERTIFICATE and APPLE_CERTIFICATE_PASSWORD in CI, or APPLE_SIGNING_IDENTITY for local signing from Keychain.',
);

const appStoreConnectReady = envPresent('APPLE_API_ISSUER')
  && envPresent('APPLE_API_KEY')
  && (fileEnvPresent('APPLE_API_KEY_PATH') || envPresent('APPLE_API_PRIVATE_KEY'));
const appleIdNotaryReady = envPresent('APPLE_ID') && envPresent('APPLE_PASSWORD') && envPresent('APPLE_TEAM_ID');

record(
  checks,
  appStoreConnectReady || appleIdNotaryReady,
  'Apple notarization credentials are available',
  'Prefer APPLE_API_ISSUER, APPLE_API_KEY, and APPLE_API_KEY_PATH/APPLE_API_PRIVATE_KEY. Apple ID fallback requires APPLE_ID, APPLE_PASSWORD, and APPLE_TEAM_ID.',
);

if (requireUploadToken) {
  record(
    checks,
    envPresent('GITHUB_TOKEN') || envPresent('GH_TOKEN'),
    'GitHub release token is available',
    'Set GITHUB_TOKEN or GH_TOKEN so CI can upload release assets and latest.json.',
  );
} else {
  console.log('[tauri-release-preflight] skip — GitHub release token not required for local/manual upload');
}

const missing = checks.filter((check) => !check.ok);
for (const check of checks) {
  const prefix = check.ok ? 'ok' : 'missing';
  console.log(`[tauri-release-preflight] ${prefix} — ${check.label}`);
  if (!check.ok) console.log(`[tauri-release-preflight] fix — ${check.fix}`);
}

if (missing.length) {
  console.error(`[tauri-release-preflight] blocked — ${missing.length} release requirement(s) missing`);
  process.exit(1);
}

console.log(`[tauri-release-preflight] ready — ${mode} release environment is configured`);
