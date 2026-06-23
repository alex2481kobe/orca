#!/usr/bin/env node
/*
 * orca-agent — drive Orca from ANY agent, from the shell.
 *
 * This is the "companion mode": an external coding agent (Claude Code, Codex,
 * Cursor, a script — anything that can run a command) uses Orca's tools to spawn
 * and supervise sub-agents and run the governed flow, WITHOUT being an Orca MCP
 * client and without being tied to the Orca dashboard. Every call goes to the
 * same loopback HTTP surface the MCP server proxies, authenticated with a scoped
 * tool lease (x-orca-tool-lease, never the raw API token). The SERVER enforces
 * the workflow: lease scoping, nextAction state gates, and exclusive
 * orchestrator ownership — so an outside agent is just as hardened/flow-bound as
 * an MCP one.
 *
 * Zero ceremony locally: on the workstation (loopback) with no API token set, you
 * need NOTHING — the first command auto-provisions + caches a scoped lease. A
 * token is only required when you've hardened Orca (ORCA_API_TOKEN set) or are
 * driving it remotely.
 *
 * Auth (env, all optional locally):
 *   ORCA_AGENT_TOOLS_BASE_URL  base URL (default http://127.0.0.1:3000)
 *   ORCA_TOOL_LEASE_TOKEN      scoped lease (overrides the cache)
 *   ORCA_API_TOKEN             admin token (only if the server has one configured)
 *   ORCA_AGENT_ROLE            default auto-bootstrap role (orchestrator|supervisor)
 *
 * Usage:
 *   orca-agent start [name...] [--project <id>] [--cap N] [--leader codex|claude|mock]
 *                                                            # bootstrap + auto session + enroll, one shot
 *   orca-agent rules [role]                                   # the shared role rulebook every surface uses
 *   orca-agent bootstrap [--role orchestrator|supervisor] [--project <id>] [--session <id>]
 *                                                            # mint + print a lease (and a `claude mcp add` line)
 *   orca-agent supervisor-bootstrap [--project <id>] [--session <id>]
 *   orca-agent supervisor-overview [--project <id>] [--session <id>]
 *   orca-agent supervisor-status <sessionId> [--project <id>]
 *   orca-agent supervisor-watch <laneId> [--project <id>] [--session <id>] [--idle-ms N] [--max-events N] [--json]
 *   orca-agent supervisor-watch-all [--project <id>] [--session <id>] [--idle-ms N] [--max-events N] [--json] [--done]
 *   orca-agent supervisor-audit <sessionId> accept|request_fix|block <summary...> [--finding text] [--next-task text]
 *   orca-agent supervisor-resign [--project <id>] [--session <id>]
 *   orca-agent projects                                      # list projects visible to this lease
 *   orca-agent links <projectId>                             # list saved live links for a project
 *   orca-agent link-upsert <projectId> <label> <url> [--tailnet URL] [--local URL] [--https URL] [--port N] [--kind vite] [--favorite] [--check] [--prefer tailnet]
 *   orca-agent link-tailnet <projectId> <label> <localUrl> [--port N] [--kind vite] [--favorite] [--check] [--prefer local]
 *                                                            # save local + direct tailnet URLs using Tailscale hostname
 *   orca-agent link-check <projectId> <linkId> [--prefer auto|local|tailnet|https]
 *   orca-agent tailscale-status                              # read private Tailscale/Serve status
 *   orca-agent tailscale-setup                               # print the dry-run setup plan
 *   orca-agent tailscale-serve enable|disable [--port N]     # admin/workstation action; never Funnel
 *   orca-agent next [--session <id>]                          # server-approved next legal tool
 *   orca-agent status <sessionId>                             # ownership + lane tree + backlog
 *   orca-agent tail <laneId> [--offset N] [--max-bytes N]     # bounded terminal.log tail for live lane output
 *   orca-agent watch <laneId> [--role orchestrator|supervisor] [--idle-ms N] [--max-events N] [--json]
 *   orca-agent watch-session <sessionId> [--role orchestrator|supervisor] [--project <id>] [--idle-ms N] [--max-events N] [--json] [--done]
 *                                                            # stream raw live lane output over the existing SSE contract
 *   orca-agent enroll <sessionId> [--takeover]                # become the active orchestrator
 *   orca-agent resign <sessionId>
 *   orca-agent create-session <projectId> <name...> [--auto] [--cap N] [--leader codex|claude|mock] [--repo-root PATH] [--worktree-mode isolated|shared]
 *   orca-agent add-task <sessionId> <title...>
 *   orca-agent bulk-add <sessionId>     # reads a JSON array of tasks from stdin
 *   orca-agent backlog <sessionId>
 *   orca-agent call <METHOD> <path> [jsonBody]                # generic authenticated escape hatch
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { roleInstructions } from '../src/agent-tools.js';

const BASE = String(process.env.ORCA_AGENT_TOOLS_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const API_TOKEN = String(process.env.ORCA_API_TOKEN || '');
// Cache leases in a STABLE per-user location keyed by base URL — never in the
// current working directory (which may not be gitignored and varies per call).
const LEASE_CACHE = path.join(os.homedir(), '.orca', 'agent-leases.json');
// Auto-provisioned leases are short-lived to limit blast radius if the cache file
// leaks; rerun any command to silently re-mint when it expires.
const AUTO_BOOTSTRAP_TTL_MS = 2 * 60 * 60 * 1000;
const ENV_LEASE = String(process.env.ORCA_TOOL_LEASE_TOKEN || '');
const PROCESS_LEASES = new Map();

function die(msg, code = 1) { console.error(`orca-agent: ${msg}`); process.exit(code); }
function out(value) { console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2)); }

function supervisorReviewLine(review) {
  if (!review || !review.status) return '';
  const detail = review.nextTask || review.summary || (Array.isArray(review.findings) ? review.findings[0] : '');
  return `supervisor: ${review.status}${detail ? ` · ${detail}` : ''}`;
}

function printSessionStatus(data) {
  out(data.tree || '(no tree)');
  out(`owner: ${data.activeOrchestrator?.active ? data.activeOrchestrator.actor : '(none)'}  ·  next: ${data.nextRequiredTool}`);
  const reviewLine = supervisorReviewLine(data.supervisorReview);
  if (reviewLine) out(reviewLine);
}

function normalizeLeaseRole(value) {
  const role = String(value || 'orchestrator').trim().toLowerCase();
  if (role === 'orchestrator' || role === 'supervisor') return role;
  die('--role must be orchestrator or supervisor');
}

const DEFAULT_LEASE_ROLE = normalizeLeaseRole(process.env.ORCA_AGENT_ROLE || 'orchestrator');

function normalizeLeaseOptions({ role = DEFAULT_LEASE_ROLE, projectId = null, sessionId = null } = {}) {
  return {
    role: normalizeLeaseRole(role),
    projectId: projectId ? String(projectId) : null,
    sessionId: sessionId ? String(sessionId) : null,
  };
}

function leaseCacheKey(options = {}) {
  const normalized = normalizeLeaseOptions(options);
  return `${BASE}|role=${normalized.role}|project=${normalized.projectId || '*'}|session=${normalized.sessionId || '*'}`;
}

function legacyLeaseCacheKeys(options = {}) {
  const normalized = normalizeLeaseOptions(options);
  if (normalized.role === 'orchestrator' && !normalized.projectId && !normalized.sessionId) return [BASE];
  return [];
}

function bootstrapPathForRole(role) {
  return normalizeLeaseRole(role) === 'supervisor'
    ? '/api/mcp/supervisor-bootstrap'
    : '/api/mcp/orchestrator-bootstrap';
}

function cacheEntryIsFresh(entry) {
  return entry?.leaseToken && (!entry.expiresAt || Date.parse(entry.expiresAt) > Date.now() + 30000);
}

// Admin call: send the API token if configured, otherwise rely on loopback-admin
// (the server treats an unproxied loopback request as admin when no token is set).
async function adminPost(path, body) {
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (API_TOKEN) headers['x-orca-token'] = API_TOKEN;
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body || {}) });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { /* non-json */ }
  return { status: res.status, ok: res.ok, data, text };
}

// Resolve a lease without ceremony: env override -> cached lease -> auto-bootstrap
// (admin/loopback) and cache it. The cache lives in .orca/ (gitignored) at 0600.
async function readLeaseCache() {
  try {
    const parsed = JSON.parse(await fs.readFile(LEASE_CACHE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

async function writeLeaseCache(cache) {
  await fs.mkdir(path.dirname(LEASE_CACHE), { recursive: true });
  const tmp = `${LEASE_CACHE}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(cache), { mode: 0o600 });
  await fs.rename(tmp, LEASE_CACHE);
}

async function clearCachedLease(options = {}) {
  if (ENV_LEASE) return;
  const normalized = normalizeLeaseOptions(options);
  const key = leaseCacheKey(normalized);
  PROCESS_LEASES.delete(key);
  const cache = await readLeaseCache();
  delete cache[key];
  for (const legacyKey of legacyLeaseCacheKeys(normalized)) delete cache[legacyKey];
  try { await writeLeaseCache(cache); } catch { /* cache is best-effort */ }
}

async function ensureLease(options = {}) {
  if (ENV_LEASE) return ENV_LEASE;
  const normalized = normalizeLeaseOptions(options);
  const key = leaseCacheKey(normalized);
  const inProcess = PROCESS_LEASES.get(key);
  if (inProcess) return inProcess;
  const cache = await readLeaseCache();
  const cacheKeys = [key, ...legacyLeaseCacheKeys(normalized)];
  for (const cacheKey of cacheKeys) {
    const entry = cache[cacheKey];
    if (cacheEntryIsFresh(entry)) {
      PROCESS_LEASES.set(key, entry.leaseToken);
      return entry.leaseToken;
    }
  }
  const r = await adminPost(bootstrapPathForRole(normalized.role), {
    ttlMs: AUTO_BOOTSTRAP_TTL_MS,
    projectId: normalized.projectId || undefined,
    sessionId: normalized.sessionId || undefined,
    actor: `orca-agent-${normalized.role}`,
  });
  if (!r.ok || !r.data?.leaseToken) {
    die(`could not auto-provision a ${normalized.role} lease (${r.status}). On a hardened or remote Orca, set ORCA_TOOL_LEASE_TOKEN, or ORCA_API_TOKEN to bootstrap. ${r.data?.error || ''}`.trim(), 2);
  }
  const leaseToken = r.data.leaseToken;
  PROCESS_LEASES.set(key, leaseToken);
  // Update the per-baseUrl entry and write atomically (temp + rename, 0600).
  cache[key] = { leaseToken, expiresAt: r.data.lease?.expiresAt || null };
  try {
    await writeLeaseCache(cache);
  } catch { /* cache is best-effort */ }
  return leaseToken;
}

// Tiny flag parser: pulls --key [value] out of argv, returns { _, flags }.
function parseArgs(argv) {
  const _ = []; const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { flags[key] = true; }
      else { flags[key] = next; i++; }
    } else { _.push(a); }
  }
  return { _, flags };
}

function queryString(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== false && value !== '') {
      search.set(key, String(value));
    }
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

async function api(method, path, body, leaseOptions = {}, retryOnLeaseAuth = true) {
  const normalizedLeaseOptions = normalizeLeaseOptions(leaseOptions);
  const headers = { accept: 'application/json', 'x-orca-tool-lease': await ensureLease(normalizedLeaseOptions) };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { /* non-json */ }
  if (!ENV_LEASE && retryOnLeaseAuth && res.status === 401 && String(data?.error || text || '').includes('Tool lease')) {
    await clearCachedLease(normalizedLeaseOptions);
    return api(method, path, body, normalizedLeaseOptions, false);
  }
  return { status: res.status, ok: res.ok, data, text };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const [cmd, ...rest] = process.argv.slice(2);
const { _, flags } = parseArgs(rest);

function show(r) {
  if (!r.ok) die(`${r.status} ${r.data?.error || r.text || ''}`.trim(), 2);
  out(r.data ?? r.text);
}

function commandLeaseOptions(defaultRole = DEFAULT_LEASE_ROLE) {
  return {
    role: flags.role || defaultRole,
    projectId: flags.project || flags.projectId,
    sessionId: flags.session || flags.sessionId,
  };
}

function parsePort(value) {
  if (!value) return undefined;
  const port = Number.parseInt(value, 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) die('--port must be between 1 and 65535');
  return port;
}

function parseUrl(value, label) {
  try {
    return new URL(value);
  } catch {
    die(`${label} must be an absolute http(s) URL`);
  }
}

function tailnetUrlFromLocal(localUrl, hostname, flags = {}) {
  const parsed = parseUrl(localUrl, 'localUrl');
  if (!['http:', 'https:'].includes(parsed.protocol)) die('localUrl must use http or https');
  const explicitPort = parsePort(flags.port);
  const inferredPort = parsed.port
    ? Number.parseInt(parsed.port, 10)
    : (parsed.protocol === 'https:' ? 443 : 80);
  const safeHost = String(hostname || '').replace(/\.$/, '');
  if (!safeHost) die('Tailscale hostname is unavailable. Run tailscale-setup first, then retry after login.');
  return `http://${safeHost}:${explicitPort || inferredPort}${parsed.pathname || '/'}${parsed.search || ''}`;
}

function normalizeWorktreeMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (!mode) return '';
  if (mode === 'isolated' || mode === 'shared') return mode;
  die('--worktree-mode must be isolated or shared');
}

function parsePositiveInt(value, fallback, label) {
  if (value === undefined || value === null || value === false || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) die(`${label} must be a positive integer`);
  return parsed;
}

function quickLinkBody(projectId, label, url, flags) {
  if (!projectId) die('project id required');
  if (!label) die('link label required');
  if (!url) die('link URL required');
  const body = {
    approved: true,
    label,
    url,
  };
  if (flags.id) body.id = flags.id;
  if (flags.local || flags['local-url']) body.localUrl = flags.local || flags['local-url'];
  if (flags.tailnet || flags['tailnet-url']) body.tailnetHttpUrl = flags.tailnet || flags['tailnet-url'];
  if (flags.https || flags['https-url']) body.httpsServeUrl = flags.https || flags['https-url'];
  if (flags.port) body.port = parsePort(flags.port);
  if (flags.kind) body.kind = flags.kind;
  if (flags.group) body.group = flags.group;
  if (flags['health-path']) body.healthPath = flags['health-path'];
  if (flags.favorite) body.favorite = true;
  if (flags.hidden) body.hidden = true;
  return body;
}

function decodeSseFrames(buffer, emitFrame) {
  let nextBuffer = buffer;
  let idx;
  while ((idx = nextBuffer.indexOf('\n\n')) >= 0) {
    const frame = nextBuffer.slice(0, idx);
    nextBuffer = nextBuffer.slice(idx + 2);
    const lines = frame.split('\n');
    const eventLine = lines.find((line) => line.startsWith('event:'));
    const dataLines = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart());
    if (!dataLines.length) continue;
    let data = null;
    try { data = JSON.parse(dataLines.join('\n')); } catch { data = { text: dataLines.join('\n') }; }
    emitFrame({
      event: eventLine ? eventLine.slice(6).trim() : 'message',
      data,
    });
  }
  return nextBuffer;
}

async function streamLane(laneId, leaseOptions = {}) {
  const normalizedLeaseOptions = normalizeLeaseOptions(leaseOptions);
  const headers = { accept: 'text/event-stream', 'x-orca-tool-lease': await ensureLease(normalizedLeaseOptions) };
  const res = await fetch(`${BASE}/api/lanes/${encodeURIComponent(laneId)}/stream`, { method: 'GET', headers });
  if (!res.ok) {
    const text = await res.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch { /* non-json */ }
    die(`${res.status} ${data?.error || text || ''}`.trim(), 2);
  }
  const maxEvents = parsePositiveInt(flags['max-events'] || flags.maxEvents, null, '--max-events');
  const idleMs = parsePositiveInt(flags['idle-ms'] || flags.idleMs, null, '--idle-ms');
  const jsonOutput = Boolean(flags.json);
  const reader = res.body?.getReader ? res.body.getReader() : null;
  if (!reader) die('lane stream response is not readable', 2);
  const decoder = new TextDecoder();
  let buffer = '';
  let seenEvents = 0;
  let lastFrameAt = Date.now();
  let idleTimer = null;
  const scheduleIdle = () => {
    if (!idleMs) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      try { reader.cancel(); } catch { /* ignore */ }
    }, Math.max(1, idleMs - (Date.now() - lastFrameAt)));
    if (typeof idleTimer.unref === 'function') idleTimer.unref();
  };
  scheduleIdle();
  const emitFrame = (frame) => {
    seenEvents += 1;
    lastFrameAt = Date.now();
    scheduleIdle();
    if (jsonOutput) {
      process.stdout.write(`${JSON.stringify(frame)}\n`);
    } else if (frame.event === 'snapshot' || frame.event === 'append') {
      process.stdout.write(String(frame.data?.text || ''));
    }
  };
  try {
    while (true) {
      let readResult;
      try {
        readResult = await reader.read();
      } catch (error) {
        if (idleMs) break;
        throw error;
      }
      const { value, done } = readResult;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = decodeSseFrames(buffer, emitFrame);
      if (maxEvents && seenEvents >= maxEvents) {
        try { await reader.cancel(); } catch { /* ignore */ }
        break;
      }
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
  }
}

const WATCHABLE_LANE_STATES = new Set([
  'queued',
  'starting',
  'running',
  'needs_critique',
  'ready_for_audit',
  'auditing',
  'fix_requested',
]);

function watchableLanes(lanes = []) {
  const includeDone = Boolean(flags.done || flags.all);
  return lanes
    .filter((lane) => lane && lane.id)
    .filter((lane) => includeDone || WATCHABLE_LANE_STATES.has(String(lane.state || '').toLowerCase()));
}

async function listSessionLanes(sessionId, leaseOptions = {}) {
  const r = await api('GET', `/api/sessions/${encodeURIComponent(sessionId)}/lanes`, undefined, {
    ...leaseOptions,
    sessionId,
  });
  if (!r.ok) die(`${r.status} ${r.data?.error || r.text}`, 2);
  return Array.isArray(r.data) ? r.data : [];
}

function collectSupervisorOverviewLanes(overview) {
  const lanes = [];
  for (const project of overview?.projects || []) {
    for (const session of project.sessions || []) {
      for (const lane of session.lanes || []) {
        lanes.push({
          ...lane,
          projectId: project.id,
          projectName: project.name,
          sessionId: session.id,
          sessionName: session.name,
        });
      }
    }
  }
  return lanes;
}

function writeGroupedFrame(lane, frame, { jsonOutput }) {
  const enriched = {
    ...frame,
    laneId: lane.id,
    laneTitle: lane.title || '',
    sessionId: lane.sessionId || null,
    sessionName: lane.sessionName || '',
    projectId: lane.projectId || null,
    projectName: lane.projectName || '',
  };
  if (jsonOutput) {
    process.stdout.write(`${JSON.stringify(enriched)}\n`);
    return;
  }
  if (frame.event !== 'snapshot' && frame.event !== 'append') return;
  const text = String(frame.data?.text || '');
  if (!text) return;
  const label = lane.title || lane.id;
  const lines = text.split('\n').filter(Boolean);
  if (lines.length) process.stdout.write(`${lines.map((line) => `[${label}] ${line}`).join('\n')}\n`);
}

async function streamLaneGroup(lanes, leaseOptions = {}) {
  const selected = watchableLanes(lanes);
  if (!selected.length) return;
  const normalizedLeaseOptions = normalizeLeaseOptions(leaseOptions);
  const headers = { accept: 'text/event-stream', 'x-orca-tool-lease': await ensureLease(normalizedLeaseOptions) };
  const maxEvents = parsePositiveInt(flags['max-events'] || flags.maxEvents, null, '--max-events');
  const idleMs = parsePositiveInt(flags['idle-ms'] || flags.idleMs, null, '--idle-ms');
  const jsonOutput = Boolean(flags.json);
  const decoder = new TextDecoder();
  const readers = new Set();
  let seenEvents = 0;
  let lastFrameAt = Date.now();
  let idleTimer = null;
  let done = false;

  const cancelAll = () => {
    if (done) return;
    done = true;
    if (idleTimer) clearTimeout(idleTimer);
    for (const reader of readers) {
      try { reader.cancel(); } catch { /* ignore */ }
    }
  };
  const scheduleIdle = () => {
    if (!idleMs || done) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(cancelAll, Math.max(1, idleMs - (Date.now() - lastFrameAt)));
    if (typeof idleTimer.unref === 'function') idleTimer.unref();
  };
  scheduleIdle();

  const readLane = async (lane) => {
    const res = await fetch(`${BASE}/api/lanes/${encodeURIComponent(lane.id)}/stream`, { method: 'GET', headers });
    if (!res.ok) {
      const text = await res.text();
      let data = null; try { data = text ? JSON.parse(text) : null; } catch { /* non-json */ }
      throw new Error(`${res.status} ${data?.error || text || ''}`.trim());
    }
    const reader = res.body?.getReader ? res.body.getReader() : null;
    if (!reader) throw new Error('lane stream response is not readable');
    readers.add(reader);
    let buffer = '';
    const emitFrame = (frame) => {
      if (done) return;
      seenEvents += 1;
      lastFrameAt = Date.now();
      scheduleIdle();
      writeGroupedFrame(lane, frame, { jsonOutput });
      if (maxEvents && seenEvents >= maxEvents) cancelAll();
    };
    try {
      while (!done) {
        let readResult;
        try {
          readResult = await reader.read();
        } catch (error) {
          if (done) break;
          throw error;
        }
        const { value, done: streamDone } = readResult;
        if (streamDone) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = decodeSseFrames(buffer, emitFrame);
      }
    } finally {
      readers.delete(reader);
    }
  };

  try {
    await Promise.all(selected.map(readLane));
  } catch (error) {
    cancelAll();
    die(error?.message || String(error), 2);
  } finally {
    cancelAll();
  }
}

switch (cmd) {
  case 'rules': {
    out(roleInstructions(_[0] || 'orchestrator'));
    break;
  }
  case 'start': {
    // One shot: ensure a lease, pick/confirm a project, create an auto session, enroll.
    const startLease = { role: 'orchestrator' };
    await ensureLease(startLease);
    let projectId = flags.project;
    if (!projectId) {
      const list = await api('GET', '/api/projects', undefined, startLease);
      if (!list.ok) die(`${list.status} ${list.data?.error || list.text}`, 2);
      projectId = list.data?.[0]?.id;
      if (!projectId) die('no projects yet — create one in the dashboard, or pass --project <id>.');
    }
    const name = _.join(' ') || `Run ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
    const body = { approved: true, name, leader: flags.leader || 'codex', spawnPolicy: 'auto' };
    if (flags.cap) body.approvedCapacity = Number.parseInt(flags.cap, 10);
    const sess = await api('POST', `/api/projects/${encodeURIComponent(projectId)}/sessions`, body, startLease);
    if (!sess.ok) die(`create-session: ${sess.status} ${sess.data?.error || sess.text}`, 2);
    const sessionId = sess.data.id;
    const enrolled = await api('POST', `/api/sessions/${encodeURIComponent(sessionId)}/orchestrator/enroll`, { takeover: true }, startLease);
    if (!enrolled.ok) die(`enroll: ${enrolled.status} ${enrolled.data?.error || enrolled.text}`, 2);
    out({ sessionId, project: projectId, owner: enrolled.data.activeOrchestrator?.actor, spawnPolicy: 'auto',
      next: `orca-agent bulk-add ${sessionId}  # then: orca-agent status ${sessionId}` });
    break;
  }
  case 'bootstrap': {
    const role = normalizeLeaseRole(flags.role || 'orchestrator');
    const body = {};
    if (flags.project) body.projectId = flags.project;
    if (flags.session) body.sessionId = flags.session;
    if (flags.actor) body.actor = flags.actor;
    const r = await adminPost(bootstrapPathForRole(role), body);
    if (!r.ok) die(`${r.status} ${r.data?.error || r.text}`, 2);
    // Print the lease token + the ready-to-use export line + the claude/codex commands.
    out({
      role,
      leaseToken: r.data.leaseToken,
      export: `export ORCA_TOOL_LEASE_TOKEN=${r.data.leaseToken}`,
      claudeCli: r.data.bootstrap?.clients?.claudeCli?.command || null,
      codexCli: r.data.bootstrap?.clients?.codexCli?.command || null,
      expiresAt: r.data.lease?.expiresAt || null,
    });
    break;
  }
  case 'supervisor-bootstrap': {
    const body = {};
    if (flags.project) body.projectId = flags.project;
    if (flags.session) body.sessionId = flags.session;
    if (flags.actor) body.actor = flags.actor;
    const r = await adminPost('/api/mcp/supervisor-bootstrap', body);
    if (!r.ok) die(`${r.status} ${r.data?.error || r.text}`, 2);
    out({
      role: 'supervisor',
      leaseToken: r.data.leaseToken,
      export: `export ORCA_TOOL_LEASE_TOKEN=${r.data.leaseToken}`,
      claudeCli: r.data.bootstrap?.clients?.claudeCli?.command || null,
      codexCli: r.data.bootstrap?.clients?.codexCli?.command || null,
      expiresAt: r.data.lease?.expiresAt || null,
    });
    break;
  }
  case 'supervisor-overview': {
    show(await api('GET', `/api/supervisor/overview${queryString({
      projectId: flags.project || flags.projectId,
      sessionId: flags.session || flags.sessionId,
    })}`, undefined, commandLeaseOptions('supervisor')));
    break;
  }
  case 'supervisor-status': {
    const sessionId = _[0] || die('usage: orca-agent supervisor-status <sessionId> [--project <id>]');
    const r = await api('GET', `/api/sessions/${encodeURIComponent(sessionId)}/orchestrator/status`, undefined, {
      role: 'supervisor',
      projectId: flags.project || flags.projectId,
      sessionId,
    });
    if (!r.ok) die(`${r.status} ${r.data?.error || r.text}`, 2);
    printSessionStatus(r.data);
    break;
  }
  case 'supervisor-watch': {
    const laneId = _[0] || die('usage: orca-agent supervisor-watch <laneId> [--project <id>] [--session <id>] [--idle-ms N] [--max-events N] [--json]');
    await streamLane(laneId, {
      role: 'supervisor',
      projectId: flags.project || flags.projectId,
      sessionId: flags.session || flags.sessionId,
    });
    break;
  }
  case 'supervisor-audit': {
    const sessionId = _[0] || die('usage: orca-agent supervisor-audit <sessionId> accept|request_fix|block <summary...> [--finding text] [--next-task text]');
    const verdict = _[1] || die('verdict required');
    const summary = _.slice(2).join(' ') || die('summary required');
    const body = { verdict, summary };
    const findings = flags.findings || flags.finding;
    if (findings) {
      try {
        const parsed = JSON.parse(findings);
        body.findings = Array.isArray(parsed) ? parsed : [String(findings)];
      } catch {
        body.findings = [String(findings)];
      }
    }
    if (flags['next-task']) body.nextTask = flags['next-task'];
    show(await api('POST', `/api/sessions/${encodeURIComponent(sessionId)}/supervisor/audit`, body, {
      role: 'supervisor',
      projectId: flags.project || flags.projectId,
      sessionId,
    }));
    break;
  }
  case 'supervisor-resign': {
    const leaseOptions = commandLeaseOptions('supervisor');
    const r = await api('POST', '/api/supervisor/resign', {}, leaseOptions);
    if (!r.ok) die(`${r.status} ${r.data?.error || r.text}`, 2);
    await clearCachedLease(leaseOptions);
    out(r.data ?? r.text);
    break;
  }
  case 'projects': {
    show(await api('GET', '/api/projects', undefined, commandLeaseOptions()));
    break;
  }
  case 'links': {
    const projectId = _[0] || die('usage: orca-agent links <projectId>');
    const r = await api('GET', `/api/projects/${encodeURIComponent(projectId)}`, undefined, {
      ...commandLeaseOptions(),
      projectId,
    });
    if (!r.ok) die(`${r.status} ${r.data?.error || r.text}`, 2);
    out({
      projectId: r.data?.id,
      name: r.data?.name,
      quickLinks: r.data?.quickLinks || [],
    });
    break;
  }
  case 'link-upsert': {
    const projectId = _[0] || die('usage: orca-agent link-upsert <projectId> <label> <url> [--tailnet URL] [--local URL] [--https URL] [--port N] [--kind vite] [--favorite] [--check] [--prefer tailnet]');
    const label = _[1] || die('link label required');
    const url = _[2] || die('link URL required');
    const saved = await api('POST', `/api/projects/${encodeURIComponent(projectId)}/quick-links`, quickLinkBody(projectId, label, url, flags), {
      role: 'orchestrator',
      projectId,
    });
    if (!saved.ok) die(`${saved.status} ${saved.data?.error || saved.text}`, 2);
    if (!flags.check) {
      out(saved.data);
      break;
    }
    const linkId = saved.data?.link?.id;
    const checked = linkId
      ? await api('POST', `/api/projects/${encodeURIComponent(projectId)}/quick-links/${encodeURIComponent(linkId)}/check`, { prefer: flags.prefer || 'auto' }, {
        role: 'orchestrator',
        projectId,
      })
      : null;
    out({ saved: saved.data, checked: checked?.data || null });
    break;
  }
  case 'link-tailnet': {
    const projectId = _[0] || die('usage: orca-agent link-tailnet <projectId> <label> <localUrl> [--port N] [--kind vite] [--favorite] [--check] [--prefer local] [--fake state]');
    const label = _[1] || die('link label required');
    const localUrl = _[2] || die('localUrl required');
    const tailnet = await api('GET', `/api/private-access/tailnet${queryString({ fake: flags.fake })}`, undefined, {
      role: 'orchestrator',
      projectId,
    });
    if (!tailnet.ok) die(`${tailnet.status} ${tailnet.data?.error || tailnet.text}`, 2);
    if (!tailnet.data?.loggedIn || !tailnet.data?.hostname) {
      die(`Tailscale is not ready: ${tailnet.data?.nextStep || 'sign in and configure Tailscale first.'}`, 2);
    }
    const tailnetHttpUrl = tailnetUrlFromLocal(localUrl, tailnet.data.hostname, flags);
    const saved = await api('POST', `/api/projects/${encodeURIComponent(projectId)}/quick-links`, quickLinkBody(projectId, label, localUrl, {
      ...flags,
      local: localUrl,
      tailnet: tailnetHttpUrl,
    }), {
      role: 'orchestrator',
      projectId,
    });
    if (!saved.ok) die(`${saved.status} ${saved.data?.error || saved.text}`, 2);
    if (!flags.check) {
      out({ saved: saved.data, tailnet: tailnet.data });
      break;
    }
    const linkId = saved.data?.link?.id;
    const checked = linkId
      ? await api('POST', `/api/projects/${encodeURIComponent(projectId)}/quick-links/${encodeURIComponent(linkId)}/check`, { prefer: flags.prefer || 'local' }, {
        role: 'orchestrator',
        projectId,
      })
      : null;
    out({ saved: saved.data, checked: checked?.data || null, tailnet: tailnet.data });
    break;
  }
  case 'link-check': {
    const projectId = _[0] || die('usage: orca-agent link-check <projectId> <linkId> [--prefer auto|local|tailnet|https]');
    const linkId = _[1] || die('link id required');
    show(await api('POST', `/api/projects/${encodeURIComponent(projectId)}/quick-links/${encodeURIComponent(linkId)}/check`, { prefer: flags.prefer || 'auto' }, {
      role: 'orchestrator',
      projectId,
    }));
    break;
  }
  case 'tailscale-status': {
    show(await api('GET', `/api/private-access/tailnet${queryString({ fake: flags.fake })}`, undefined, commandLeaseOptions()));
    break;
  }
  case 'tailscale-setup': {
    show(await api('GET', `/api/private-access/setup-plan${queryString({
      localUrl: flags.local || flags['local-url'],
      httpPort: flags['http-port'],
      httpsPort: flags['https-port'],
    })}`, undefined, commandLeaseOptions()));
    break;
  }
  case 'tailscale-serve': {
    const action = _[0] || die('usage: orca-agent tailscale-serve enable|disable [--port N]');
    if (!['enable', 'disable'].includes(action)) die('tailscale-serve action must be enable or disable');
    const r = await adminPost('/api/private-access/serve', {
      action,
      port: parsePort(flags.port) || 3000,
      approved: true,
    });
    if (!r.ok) die(`${r.status} ${r.data?.error || r.text}`, 2);
    out(r.data ?? r.text);
    break;
  }
  case 'next': {
    const role = normalizeLeaseRole(flags.role || 'orchestrator');
    const qs = flags.session ? `?role=${encodeURIComponent(role)}&sessionId=${encodeURIComponent(flags.session)}` : `?role=${encodeURIComponent(role)}`;
    show(await api('GET', `/api/agent-tools/next-action${qs}`, undefined, { role, sessionId: flags.session || null }));
    break;
  }
  case 'status': {
    const sessionId = _[0] || die('usage: orca-agent status <sessionId>');
    const r = await api('GET', `/api/sessions/${encodeURIComponent(sessionId)}/orchestrator/status`, undefined, {
      role: flags.role || 'orchestrator',
      projectId: flags.project || flags.projectId,
      sessionId,
    });
    if (!r.ok) die(`${r.status} ${r.data?.error || r.text}`, 2);
    printSessionStatus(r.data);
    break;
  }
  case 'tail': {
    const laneId = _[0] || die('usage: orca-agent tail <laneId> [--offset N] [--max-bytes N]');
    show(await api('GET', `/api/lanes/${encodeURIComponent(laneId)}/terminal-tail${queryString({
      offset: flags.offset,
      maxBytes: flags['max-bytes'] || flags.maxBytes,
    })}`, undefined, commandLeaseOptions()));
    break;
  }
  case 'watch': {
    const laneId = _[0] || die('usage: orca-agent watch <laneId> [--role orchestrator|supervisor] [--project <id>] [--session <id>] [--idle-ms N] [--max-events N] [--json]');
    await streamLane(laneId, commandLeaseOptions());
    break;
  }
  case 'watch-session': {
    const sessionId = _[0] || die('usage: orca-agent watch-session <sessionId> [--role orchestrator|supervisor] [--project <id>] [--idle-ms N] [--max-events N] [--json] [--done]');
    const leaseOptions = {
      role: flags.role || 'orchestrator',
      projectId: flags.project || flags.projectId,
      sessionId,
    };
    await streamLaneGroup(await listSessionLanes(sessionId, leaseOptions), leaseOptions);
    break;
  }
  case 'supervisor-watch-all': {
    const leaseOptions = commandLeaseOptions('supervisor');
    const r = await api('GET', `/api/supervisor/overview${queryString({
      projectId: flags.project || flags.projectId,
      sessionId: flags.session || flags.sessionId,
    })}`, undefined, leaseOptions);
    if (!r.ok) die(`${r.status} ${r.data?.error || r.text}`, 2);
    await streamLaneGroup(collectSupervisorOverviewLanes(r.data), leaseOptions);
    break;
  }
  case 'enroll': {
    const sessionId = _[0] || die('usage: orca-agent enroll <sessionId> [--takeover]');
    show(await api('POST', `/api/sessions/${encodeURIComponent(sessionId)}/orchestrator/enroll`, { takeover: Boolean(flags.takeover) }, {
      role: 'orchestrator',
      projectId: flags.project || flags.projectId,
      sessionId,
    }));
    break;
  }
  case 'resign': {
    const sessionId = _[0] || die('usage: orca-agent resign <sessionId>');
    show(await api('POST', `/api/sessions/${encodeURIComponent(sessionId)}/orchestrator/resign`, {}, {
      role: 'orchestrator',
      projectId: flags.project || flags.projectId,
      sessionId,
    }));
    break;
  }
  case 'create-session': {
    const projectId = _[0] || die('usage: orca-agent create-session <projectId> <name...> [--auto] [--cap N] [--leader X] [--repo-root PATH] [--worktree-mode isolated|shared]');
    const name = _.slice(1).join(' ') || die('session name required');
    // The lease is the authorization; policy-gated actions proceed with approved:true.
    const body = { approved: true, name, leader: flags.leader || 'codex', spawnPolicy: flags.auto ? 'auto' : 'within_capacity' };
    if (flags.cap) body.approvedCapacity = parsePositiveInt(flags.cap, null, '--cap');
    const repoRoot = flags['repo-root'] || flags.repoRoot;
    if (repoRoot) body.repoRoot = repoRoot;
    const worktreeMode = normalizeWorktreeMode(flags['worktree-mode'] || flags.worktreeMode);
    if (worktreeMode) body.worktreeMode = worktreeMode;
    show(await api('POST', `/api/projects/${encodeURIComponent(projectId)}/sessions`, body, {
      role: 'orchestrator',
      projectId,
    }));
    break;
  }
  case 'add-task': {
    const sessionId = _[0] || die('usage: orca-agent add-task <sessionId> <title...>');
    const title = _.slice(1).join(' ') || die('task title required');
    show(await api('POST', `/api/sessions/${encodeURIComponent(sessionId)}/tasks`, { title }, {
      role: 'orchestrator',
      projectId: flags.project || flags.projectId,
      sessionId,
    }));
    break;
  }
  case 'bulk-add': {
    const sessionId = _[0] || die('usage: orca-agent bulk-add <sessionId>  (JSON task array on stdin)');
    let tasks;
    try { tasks = JSON.parse(await readStdin()); } catch { die('stdin must be a JSON array of tasks'); }
    if (!Array.isArray(tasks)) die('stdin must be a JSON array of tasks');
    show(await api('POST', `/api/sessions/${encodeURIComponent(sessionId)}/tasks/bulk`, { tasks }, {
      role: 'orchestrator',
      projectId: flags.project || flags.projectId,
      sessionId,
    }));
    break;
  }
  case 'backlog': {
    const sessionId = _[0] || die('usage: orca-agent backlog <sessionId>');
    show(await api('GET', `/api/sessions/${encodeURIComponent(sessionId)}/backlog`, undefined, {
      role: flags.role || 'orchestrator',
      projectId: flags.project || flags.projectId,
      sessionId,
    }));
    break;
  }
  case 'call': {
    const method = (_[0] || '').toUpperCase() || die('usage: orca-agent call <METHOD> <path> [jsonBody]');
    const path = _[1] || die('path required');
    let body;
    if (_[2]) { try { body = JSON.parse(_[2]); } catch { die('jsonBody must be valid JSON'); } }
    show(await api(method, path, body, commandLeaseOptions()));
    break;
  }
  default:
    out('orca-agent — drive Orca from any agent. Commands: start, projects, links, link-upsert, link-tailnet, link-check, tailscale-status, tailscale-setup, tailscale-serve, rules, bootstrap, supervisor-bootstrap, supervisor-overview, supervisor-status, supervisor-watch, supervisor-watch-all, supervisor-audit, supervisor-resign, next, status, tail, watch, watch-session, enroll, resign, create-session, add-task, bulk-add, backlog, call. See header for usage.');
    if (cmd && cmd !== 'help') process.exit(1);
}
