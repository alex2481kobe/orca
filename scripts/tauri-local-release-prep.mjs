import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const getArgValue = (name) => {
  const prefix = `${name}=`;
  const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : '';
};

const skipTests = args.has('--skip-tests');
const buildDmg = args.has('--dmg');
const manifestUrl = getArgValue('--manifest-url') || process.env.COMMAND_DECK_UPDATE_ARTIFACT_URL || '';

function run(command, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    console.log(`[tauri-local-release-prep] run — ${command} ${commandArgs.join(' ')}`);
    const child = spawn(command, commandArgs, {
      cwd: root,
      env: { ...process.env, ...options.env },
      stdio: 'inherit',
    });
    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`${command} terminated by ${signal}`));
      } else if (code) {
        reject(new Error(`${command} exited with ${code}`));
      } else {
        resolve();
      }
    });
  });
}

try {
  await run('npm', ['run', 'tauri:release-preflight', '--', '--local']);
  await run('npm', ['run', 'build:web']);
  await run('npm', ['run', 'tauri:check']);
  await run('cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml']);
  if (!skipTests) {
    await run('npm', ['test']);
    await run('npm', ['run', 'smoke:full-buildout-ledger']);
  }
  await run('npm', ['run', 'tauri:build:release']);
  if (buildDmg) {
    await run('npm', ['run', 'tauri:build:dmg']);
  }
  if (manifestUrl) {
    await run('npm', ['run', 'tauri:release-manifest'], {
      env: { COMMAND_DECK_UPDATE_ARTIFACT_URL: manifestUrl },
    });
  } else {
    console.log('[tauri-local-release-prep] skip — latest.json not generated because --manifest-url was not provided');
  }
  console.log('[tauri-local-release-prep] done');
} catch (error) {
  console.error(`[tauri-local-release-prep] failed — ${error.message}`);
  process.exit(1);
}
