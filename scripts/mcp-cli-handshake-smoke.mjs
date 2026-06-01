#!/usr/bin/env node
/*
 * Real-CLI handshake check: confirms the actual Claude and Codex binaries can
 * load Orca's built-in MCP server (src/mcp-server.js). Claude performs a live
 * health-check connection; Codex registers + enables the stdio server. Each CLI
 * is run with an ISOLATED config home so the user's real config is untouched,
 * and is skipped gracefully when the binary is absent. No model auth required.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
    const add = spawnSync(bin, addArgs, { encoding: 'utf8', env: { ...process.env, HOME: home }, timeout: 30000 });
    if (add.status !== 0) fail('claude mcp add', add.stderr || add.stdout);
    const list = spawnSync(bin, ['mcp', 'list'], { encoding: 'utf8', env: { ...process.env, HOME: home }, timeout: 30000 });
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

const claude = detect('ORCA_CLAUDE_BINARY', ['/opt/homebrew/bin/claude', '/usr/local/bin/claude', 'claude']);
const codex = detect('ORCA_CODEX_BINARY', ['/opt/homebrew/bin/codex', '/usr/local/bin/codex', 'codex']);

if (claude) await checkClaude(claude); else log('claude', 'skipped: CLI not available');
if (codex) await checkCodex(codex); else log('codex', 'skipped: CLI not available');
log('done', 'real-CLI MCP handshake verified');
