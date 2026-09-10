#!/usr/bin/env node
/*
 * Real-CLI handshake check: confirms the actual Claude and Codex binaries can
 * load Orca's built-in MCP server (src/mcp-server.js). Claude performs a live
 * health-check connection; Codex registers + enables the stdio server. Each CLI
 * is run with an ISOLATED config home so the user's real config is untouched,
 * and is skipped gracefully when the binary is absent. No model auth required.
 *
 * It then runs the orchestrator bootstrap's OWN emitted "mcp add" commands,
 * verbatim through a shell (only the leading binary name is swapped for the
 * detected one), from one directory, and requires the server to be present from
 * two unrelated directories. That is the user-scope guarantee: a local-scope
 * registration exists only in the directory it was added from. The launcher's
 * Node path contains a space, so the emitted quoting is exercised for real.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildOrchestratorMcpConfigs } from '../src/mcp-orchestrator-bootstrap.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MCP = path.join(here, '..', 'src', 'mcp-server.js');
const log = (label, info = '') => console.log(`[mcp-cli-handshake] ${label}${info ? ' — ' + info : ''}`);
const fail = (label, info = '') => { console.error(`[mcp-cli-handshake FAIL] ${label}${info ? ' — ' + info : ''}`); throw new Error(label); };

function detect(envVar, candidates) {
  for (const c of [process.env[envVar], ...candidates].filter(Boolean)) {
    const r = spawnSync(c, ['--version'], { encoding: 'utf8', timeout: 4000 });
    if (r.status === 0 && /\d+\.\d+/.test(r.stdout || '')) return c;
  }
  return null;
}

const env = [
  'ORCA_AGENT_TOOLS_BASE_URL=http://127.0.0.1:3000',
  'ORCA_TOOL_LEASE_TOKEN=handshake',
  'ORCA_ROLE=executor',
  'ORCA_LANE_ID=lane-x',
  'ORCA_SESSION_ID=sess-x',
];

async function checkClaude(bin) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-claude-mcp-'));
  try {
    const addArgs = ['mcp', 'add', 'orca'];
    for (const e of env) addArgs.push('-e', e);
    addArgs.push('--', 'node', MCP);
    const add = spawnSync(bin, addArgs, { encoding: 'utf8', env: isolatedEnv({ HOME: home }), timeout: 30000 });
    if (add.status !== 0) fail('claude mcp add', add.stderr || add.stdout);
    const list = spawnSync(bin, ['mcp', 'list'], { encoding: 'utf8', env: isolatedEnv({ HOME: home }), timeout: 30000 });
    const out = `${list.stdout || ''}${list.stderr || ''}`;
    if (!/orca:.*(Connected|✓)/.test(out)) fail('claude mcp connection', out.slice(-400));
    log('claude', 'real CLI connected to orca MCP server (✓ Connected)');
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

async function checkCodex(bin) {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-codex-mcp-'));
  try {
    const addArgs = ['mcp', 'add', 'orca'];
    for (const e of env) addArgs.push('--env', e);
    addArgs.push('--', 'node', MCP);
    const add = spawnSync(bin, addArgs, { encoding: 'utf8', env: { ...process.env, CODEX_HOME: codexHome }, timeout: 30000 });
    if (add.status !== 0) fail('codex mcp add', add.stderr || add.stdout);
    const list = spawnSync(bin, ['mcp', 'list'], { encoding: 'utf8', env: { ...process.env, CODEX_HOME: codexHome }, timeout: 30000 });
    const out = `${list.stdout || ''}${list.stderr || ''}`;
    if (!/orca\b/.test(out) || !/enabled/.test(out)) fail('codex mcp registration', out.slice(-400));
    log('codex', 'real CLI registered + enabled orca MCP server');
  } finally {
    await fs.rm(codexHome, { recursive: true, force: true });
  }
}

const shq = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

// Child env for a client CLI: the caller's env with the config home redirected.
// CLAUDE_CONFIG_DIR / CODEX_HOME would otherwise point the CLI back at the real
// config no matter what HOME says, so they are dropped unless set on purpose.
function isolatedEnv(overrides) {
  const env = { ...process.env, ...overrides };
  if (!('CLAUDE_CONFIG_DIR' in overrides)) delete env.CLAUDE_CONFIG_DIR;
  if (!('CODEX_HOME' in overrides)) delete env.CODEX_HOME;
  return env;
}

// A fresh bootstrap whose launcher is a Node path WITH A SPACE (a symlink to the
// running node), plus the directories to register from and to check from.
async function bootstrapFixture(root) {
  const nodeDir = path.join(root, 'Node Runtime', 'bin');
  await fs.mkdir(nodeDir, { recursive: true });
  const nodePath = path.join(nodeDir, 'node');
  await fs.symlink(process.execPath, nodePath);
  const dirs = ['registered-here', 'unrelated one', 'unrelated-two'].map((name) => path.join(root, name));
  for (const dir of dirs) await fs.mkdir(dir, { recursive: true });
  const out = buildOrchestratorMcpConfigs({ baseUrl: 'http://127.0.0.1:3000', leaseToken: 'handshake', nodePath });
  return { nodePath, dirs, out };
}

function runEmitted(command, name, bin, options) {
  if (!command.startsWith(`${name} mcp add `)) fail(`bootstrap ${name} command shape`, command.slice(0, 80));
  return spawnSync('/bin/sh', ['-c', `${shq(bin)}${command.slice(name.length)}`], { encoding: 'utf8', timeout: 60000, ...options });
}

async function checkClaudeBootstrap(bin) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-claude-bootstrap-'));
  try {
    const { nodePath, dirs, out } = await bootstrapFixture(root);
    const env = isolatedEnv({ HOME: path.join(root, 'home') });
    await fs.mkdir(env.HOME, { recursive: true });
    const command = out.clients.claudeCli.command;
    const add = runEmitted(command, 'claude', bin, { cwd: dirs[0], env });
    if (add.status !== 0) fail('bootstrap claude mcp add', add.stderr || add.stdout);
    for (const cwd of dirs.slice(1)) {
      const list = spawnSync(bin, ['mcp', 'list'], { cwd, env, encoding: 'utf8', timeout: 60000 });
      const text = `${list.stdout || ''}${list.stderr || ''}`;
      if (!/orca:.*(Connected|✓)/.test(text)) fail(`bootstrap claude: orca not available from "${path.basename(cwd)}"`, text.slice(-400));
    }
    const get = spawnSync(bin, ['mcp', 'get', 'orca'], { cwd: dirs[2], env, encoding: 'utf8', timeout: 60000 });
    const detail = `${get.stdout || ''}${get.stderr || ''}`;
    if (!/Scope:\s*User/i.test(detail)) fail('bootstrap claude registration scope', detail.slice(-400));
    if (!detail.includes(nodePath)) fail('bootstrap claude launcher path (with a space)', detail.slice(-400));
    log('claude bootstrap', 'emitted command registered at user scope; connected from two unrelated directories');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function checkCodexBootstrap(bin) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-codex-bootstrap-'));
  try {
    const { nodePath, dirs, out } = await bootstrapFixture(root);
    const env = isolatedEnv({ HOME: path.join(root, 'home'), CODEX_HOME: path.join(root, 'codex-home') });
    await fs.mkdir(env.HOME, { recursive: true });
    await fs.mkdir(env.CODEX_HOME, { recursive: true });
    const command = out.clients.codexCli.command;
    const add = runEmitted(command, 'codex', bin, { cwd: dirs[0], env });
    if (add.status !== 0) fail('bootstrap codex mcp add', add.stderr || add.stdout);
    for (const cwd of dirs.slice(1)) {
      const list = spawnSync(bin, ['mcp', 'list'], { cwd, env, encoding: 'utf8', timeout: 60000 });
      const text = `${list.stdout || ''}${list.stderr || ''}`;
      if (!/orca\b/.test(text) || !/enabled/.test(text)) fail(`bootstrap codex: orca not available from "${path.basename(cwd)}"`, text.slice(-400));
    }
    const get = spawnSync(bin, ['mcp', 'get', 'orca', '--json'], { cwd: dirs[2], env, encoding: 'utf8', timeout: 60000 });
    if (get.status !== 0 || !(get.stdout || '').includes(nodePath)) fail('bootstrap codex launcher path (with a space)', `${get.stdout || ''}${get.stderr || ''}`.slice(-400));
    log('codex bootstrap', 'emitted command registered in the user config; enabled from two unrelated directories');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

const claude = detect('ORCA_CLAUDE_BINARY', ['/opt/homebrew/bin/claude', '/usr/local/bin/claude', 'claude']);
const codex = detect('ORCA_CODEX_BINARY', ['/opt/homebrew/bin/codex', '/usr/local/bin/codex', 'codex']);

if (claude) {
  await checkClaude(claude);
  await checkClaudeBootstrap(claude);
} else log('claude', 'skipped: CLI not available');
if (codex) {
  await checkCodex(codex);
  await checkCodexBootstrap(codex);
} else log('codex', 'skipped: CLI not available');
log('done', 'real-CLI MCP handshake verified');
