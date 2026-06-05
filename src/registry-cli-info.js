// Executor CLI introspection helpers. Extracted from registry.js.
//
// These probe a CLI binary (version + --help) and parse capabilities out of help
// text, so Orca can advertise what each executor supports. All are pure aside
// from the bounded, timed spawnSync probes (4s timeout, capped buffers).

import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeExecutorType, safeArray } from './registry-utils.js';

// Per-CLI slash-command metadata. The command EXISTENCE is detected dynamically
// (grep the actual binary below); this only supplies the human description and how
// each should behave in our NON-interactive dashboard (apply-local = a composer
// config we set; dashboard-action = a real dashboard feature; send-to-agent = pass
// the command to the agent as the prompt; interactive-only = TUI-only, shown but
// not runnable headlessly). Curated from inspecting the codex/claude binaries.
const SLASH_META = {
  codex: {
    model: { description: 'Pick the model (and reasoning effort)', mapping: 'apply-local' },
    reasoning: { description: 'Set reasoning effort', mapping: 'apply-local' },
    fast: { description: 'Fast / low-latency mode', mapping: 'apply-local' },
    approvals: { description: 'Approval policy & sandbox level', mapping: 'apply-local' },
    web: { description: 'Toggle live web search', mapping: 'apply-local' },
    search: { description: 'Toggle web search', mapping: 'apply-local' },
    new: { description: 'Start a new conversation', mapping: 'dashboard-action' },
    clear: { description: 'Clear the conversation', mapping: 'dashboard-action' },
    resume: { description: 'Resume a previous session', mapping: 'dashboard-action' },
    diff: { description: 'Show the working-tree diff', mapping: 'dashboard-action' },
    status: { description: 'Show current session config', mapping: 'dashboard-action' },
    mcp: { description: 'List MCP servers & tools', mapping: 'dashboard-action' },
    context: { description: 'Show context-window usage', mapping: 'dashboard-action' },
    usage: { description: 'Show token usage & limits', mapping: 'dashboard-action' },
    agents: { description: 'Browse subagents', mapping: 'dashboard-action' },
    prompts: { description: 'Insert a saved prompt', mapping: 'dashboard-action' },
    review: { description: 'Run a code review', mapping: 'send-to-agent' },
    compact: { description: 'Summarize / compact context', mapping: 'send-to-agent' },
    init: { description: 'Generate an AGENTS.md guide', mapping: 'send-to-agent' },
    theme: { description: 'Change the TUI theme', mapping: 'interactive-only' },
    logout: { description: 'Sign out', mapping: 'interactive-only' },
    help: { description: 'List commands', mapping: 'interactive-only' },
  },
  claude: {
    model: { description: 'Switch the model', mapping: 'apply-local' },
    effort: { description: 'Set reasoning effort', mapping: 'apply-local' },
    fast: { description: 'Toggle Fast mode', mapping: 'apply-local' },
    clear: { description: 'Clear conversation, fresh context', mapping: 'dashboard-action' },
    context: { description: 'Show context-window usage', mapping: 'dashboard-action' },
    status: { description: 'Show session/account status', mapping: 'dashboard-action' },
    usage: { description: 'Show plan usage & limits', mapping: 'dashboard-action' },
    cost: { description: 'Show token/cost usage', mapping: 'dashboard-action' },
    mcp: { description: 'View MCP servers & tools', mapping: 'dashboard-action' },
    agents: { description: 'Manage custom agents', mapping: 'dashboard-action' },
    memory: { description: 'View/edit CLAUDE.md memory', mapping: 'dashboard-action' },
    config: { description: 'View/edit configuration', mapping: 'dashboard-action' },
    permissions: { description: 'View/edit tool permissions', mapping: 'dashboard-action' },
    export: { description: 'Export the transcript', mapping: 'dashboard-action' },
    review: { description: 'Review the current diff / PR', mapping: 'send-to-agent' },
    compact: { description: 'Summarize / compact context', mapping: 'send-to-agent' },
    init: { description: 'Generate a CLAUDE.md', mapping: 'send-to-agent' },
    'pr-comments': { description: 'Address PR comments', mapping: 'send-to-agent' },
    plan: { description: 'Plan before changes', mapping: 'send-to-agent' },
    resume: { description: 'Resume a conversation', mapping: 'interactive-only' },
    rewind: { description: 'Rewind to a checkpoint', mapping: 'interactive-only' },
    login: { description: 'Log in', mapping: 'interactive-only' },
    logout: { description: 'Log out', mapping: 'interactive-only' },
    vim: { description: 'Toggle vim keybindings', mapping: 'interactive-only' },
    ide: { description: 'Connect to an IDE', mapping: 'interactive-only' },
    doctor: { description: 'Diagnose the install', mapping: 'interactive-only' },
    help: { description: 'Show help', mapping: 'interactive-only' },
  },
};

const slashCommandCache = new Map();
const slashWarming = new Set();
// Grepping a big CLI binary for its "/cmd" tokens takes ~5s, so we NEVER do it on
// the synchronous capabilities path. Instead detect lazily/async and persist the
// result to disk keyed by binary path+size+mtime, so it runs at most once per
// binary version (ever) and every later read is instant.
const SLASH_DISK_CACHE = path.join(os.tmpdir(), 'orca-slash-commands-cache.json');
let slashDiskCache = null;

function loadSlashDisk() {
  if (slashDiskCache) return slashDiskCache;
  try { slashDiskCache = JSON.parse(fs.readFileSync(SLASH_DISK_CACHE, 'utf8')); } catch { slashDiskCache = {}; }
  return slashDiskCache;
}
function saveSlashDisk(key, value) {
  const cache = loadSlashDisk();
  cache[key] = value;
  try { fs.writeFileSync(SLASH_DISK_CACHE, JSON.stringify(cache)); } catch { /* best-effort */ }
}

function resolveBinaryAbsolutePath(binary) {
  try {
    const which = spawnSync('which', [String(binary)], { encoding: 'utf8', timeout: 3000 });
    if (which.status !== 0) return null;
    const first = which.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (!first) return null;
    const real = spawnSync('readlink', ['-f', first], { encoding: 'utf8', timeout: 3000 });
    return real.status === 0 && real.stdout.trim() ? real.stdout.trim() : first;
  } catch {
    return null;
  }
}

// Background, non-blocking grep that populates the in-memory + disk caches.
function warmSlashCommands(type, abs, memKey, diskKey, meta) {
  if (slashWarming.has(diskKey)) return;
  slashWarming.add(diskKey);
  const names = Object.keys(meta);
  const pattern = `/(${names.map((n) => n.replace(/[^a-z0-9-]/gi, '')).join('|')})\\b`;
  let out = '';
  let child;
  try {
    child = spawn('grep', ['-aoE', pattern, abs], { windowsHide: true });
  } catch { slashWarming.delete(diskKey); return; }
  child.stdout?.on('data', (d) => { out += d; if (out.length > 96 * 1024 * 1024) { try { child.kill(); } catch { /* noop */ } } });
  child.on('error', () => { slashWarming.delete(diskKey); });
  child.on('close', () => {
    try {
      const found = new Set(out.split(/\r?\n/).map((s) => s.trim().replace(/^\//, '')).filter(Boolean));
      const result = names
        .filter((n) => found.has(n))
        .map((n) => ({ command: `/${n}`, description: meta[n].description, mapping: meta[n].mapping }));
      slashCommandCache.set(memKey, result);
      saveSlashDisk(diskKey, result);
    } catch { /* ignore */ }
    slashWarming.delete(diskKey);
  });
  if (typeof child.unref === 'function') child.unref();
}

// Return a CLI's REAL slash commands (detected from the installed binary), with
// description + dashboard mapping. SYNCHRONOUS and fast: serves from the in-memory
// or disk cache, and kicks off a one-time background grep on a cold miss (returns
// [] until that finishes, then it's cached forever for this binary version).
export function detectSlashCommands(type, binary) {
  const meta = SLASH_META[type];
  if (!meta) return [];
  const abs = resolveBinaryAbsolutePath(binary);
  if (!abs) return [];
  const memKey = `${type}:${abs}`;
  if (slashCommandCache.has(memKey)) return slashCommandCache.get(memKey);
  let stat;
  try { stat = fs.statSync(abs); } catch { return []; }
  const diskKey = `${type}|${abs}|${stat.size}|${Math.round(stat.mtimeMs)}`;
  const disk = loadSlashDisk();
  if (Array.isArray(disk[diskKey])) {
    slashCommandCache.set(memKey, disk[diskKey]);
    return disk[diskKey];
  }
  warmSlashCommands(type, abs, memKey, diskKey, meta);
  return [];
}

// `--version` shells out (spawnSync, up to 4s). The client probes this per
// executor on EVERY poll (1-3s) via /api/executors/{t}/cli AND /api/system/blockers
// — without a cache that's continuous CPU + event-loop blocking. Versions change
// only on (re)install, so a short TTL cache keyed by binary path is safe.
const cliVersionCache = new Map(); // binary -> { value, at }
const CLI_VERSION_TTL_MS = 60 * 1000;

export function getCliVersion(binary) {
  const key = String(binary || '');
  const cached = cliVersionCache.get(key);
  if (cached && (Date.now() - cached.at) < CLI_VERSION_TTL_MS) return cached.value;
  const value = computeCliVersion(binary);
  if (cliVersionCache.size > 64) cliVersionCache.clear(); // bound the map
  cliVersionCache.set(key, { value, at: Date.now() });
  return value;
}

function computeCliVersion(binary) {
  try {
    const result = spawnSync(binary, ['--version'], {
      encoding: 'utf8',
      timeout: 4000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });

    if (result.error) {
      return {
        exists: false,
        version: null,
        exitCode: result.error.code,
      };
    }

    const raw = String(result.stdout || result.stderr || '').trim();
    return {
      exists: true,
      version: raw || null,
      exitCode: result.status,
    };
  } catch (error) {
    return {
      exists: false,
      version: null,
      exitCode: error.code,
    };
  }
}

export function getCliHelp(binary, executorType) {
  try {
    const args = normalizeExecutorType(executorType) === 'codex'
      ? ['exec', '--help']
      : ['--help'];
    const result = spawnSync(binary, args, {
      encoding: 'utf8',
      timeout: 4000,
      maxBuffer: 128 * 1024,
      windowsHide: true,
    });
    if (result.error) {
      return {
        ok: false,
        text: '',
        exitCode: result.error.code,
      };
    }
    return {
      ok: result.status === 0,
      text: String(result.stdout || result.stderr || '').slice(0, 128 * 1024),
      exitCode: result.status,
    };
  } catch (error) {
    return {
      ok: false,
      text: '',
      exitCode: error.code,
    };
  }
}

export function helpHas(helpText, pattern) {
  return pattern.test(String(helpText || ''));
}

export function parseHelpChoices(helpText, flagName) {
  const text = String(helpText || '');
  const line = text.split(/\r?\n/).find((entry) => entry.includes(flagName) && (entry.includes('choices:') || entry.includes('possible values:')));
  if (!line) return [];
  const match = line.match(/\((?:choices|possible values):\s*([^)]+)\)/i);
  if (!match) return [];
  return match[1]
    .split(/[,\s|]+/)
    .map((value) => value.replace(/["'`]/g, '').trim())
    .filter(Boolean)
    .filter((value, index, all) => all.indexOf(value) === index)
    .slice(0, 32);
}

// Extract effort/reasoning levels a CLI documents for `--effort`. Claude prints
// the levels on a continuation line WITHOUT a "choices:" prefix, e.g.:
//   --effort <level>   Effort level for the current session
//                      (low, medium, high, xhigh, max)
// so parseHelpChoices misses them. Walk the --effort option block and pull the
// first parenthesised comma list of bare words. Returns [] when absent.
export function parseEffortChoices(helpText) {
  const lines = String(helpText || '').split(/\r?\n/);
  const startIdx = lines.findIndex((line) => /(^|\s)--effort(\s|<|=)/i.test(line));
  if (startIdx < 0) return [];
  const block = [lines[startIdx]];
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) break; // blank line ends the option block
    if (/^\s*-{1,2}[a-z]/i.test(line)) break; // next option starts
    if (!/^\s/.test(line)) break; // dedented prose
    block.push(line);
  }
  const match = block.join(' ').match(/\(([a-z0-9][a-z0-9,\s|/-]+)\)/i);
  if (!match) return [];
  return match[1]
    .split(/[,\s|/]+/)
    .map((value) => value.replace(/["'`]/g, '').trim().toLowerCase())
    .filter((value) => /^[a-z][a-z0-9-]*$/.test(value))
    .filter((value, index, all) => all.indexOf(value) === index)
    .slice(0, 12);
}

// Extract model aliases / example names a CLI documents in its `--model` help
// block. Claude, for example, prints: "Provide an alias for the latest model
// (e.g. 'sonnet' or 'opus') or a model's full name (e.g. 'claude-opus-4-8')."
// Aliases like 'opus'/'sonnet' never go stale (they resolve to the latest), so
// detecting them here keeps the model picker current without hardcoding version
// numbers. Returns [] for CLIs that document no examples (free-text still works).
export function parseModelHints(helpText) {
  const lines = String(helpText || '').split(/\r?\n/);
  const startIdx = lines.findIndex((line) => /(^|\s)(-[a-z],\s*)?--model(\s|<|=)/i.test(line) && !/--fallback-model/i.test(line));
  if (startIdx < 0) return [];
  const block = [lines[startIdx]];
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) break; // blank line ends the option block
    if (/^\s*-{1,2}[a-z]/i.test(line)) break; // next option starts
    if (!/^\s/.test(line)) break; // dedented prose, no longer this option
    block.push(line);
  }
  const text = block.join(' ');
  // Match a single model-like token inside quotes. Requiring the whole quoted
  // span to be one valid token avoids desync from stray apostrophes in prose
  // (e.g. "model's full name") that would otherwise swallow real examples.
  const STOP = new Set(['e.g', 'eg', 'i.e', 'the', 'an', 'or', 'for', 'of', 'to', 'and', 'model', 'alias', 'name', 'full', 'latest', 'current', 'session']);
  const tokens = [];
  for (const match of text.matchAll(/['"`]([a-z][a-z0-9._-]{1,39})['"`]/gi)) {
    const token = match[1].trim();
    if (!STOP.has(token.toLowerCase())) tokens.push(token);
  }
  return tokens.filter((token, index, all) => all.indexOf(token) === index).slice(0, 16);
}

export function compactCapabilities(capabilities) {
  if (!capabilities || typeof capabilities !== 'object') return null;
  return {
    type: capabilities.type,
    displayName: capabilities.displayName,
    kind: capabilities.kind,
    binary: capabilities.binary,
    binaryExists: Boolean(capabilities.binaryExists),
    version: capabilities.version || null,
    roles: safeArray(capabilities.roles),
    controls: capabilities.controls || {},
    invocation: capabilities.invocation || {},
    mcpScopes: safeArray(capabilities.mcpScopes),
    detection: capabilities.detection || {},
  };
}
