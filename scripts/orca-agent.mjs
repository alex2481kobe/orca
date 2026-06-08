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
 * Auth (env):
 *   ORCA_AGENT_TOOLS_BASE_URL  base URL (default http://127.0.0.1:3000)
 *   ORCA_TOOL_LEASE_TOKEN      scoped lease (preferred)
 *   ORCA_API_TOKEN             admin token — only needed for `bootstrap`
 *
 * Usage:
 *   orca-agent bootstrap [--project <id>] [--session <id>]   # admin: mint an orchestrator lease
 *   orca-agent next [--session <id>]                          # server-approved next legal tool
 *   orca-agent status <sessionId>                             # ownership + lane tree + backlog
 *   orca-agent enroll <sessionId> [--takeover]                # become the active orchestrator
 *   orca-agent resign <sessionId>
 *   orca-agent create-session <projectId> <name...> [--auto] [--cap N] [--leader codex|claude|mock]
 *   orca-agent add-task <sessionId> <title...>
 *   orca-agent bulk-add <sessionId>     # reads a JSON array of tasks from stdin
 *   orca-agent backlog <sessionId>
 *   orca-agent call <METHOD> <path> [jsonBody]                # generic authenticated escape hatch
 */

const BASE = String(process.env.ORCA_AGENT_TOOLS_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const LEASE = String(process.env.ORCA_TOOL_LEASE_TOKEN || '');
const API_TOKEN = String(process.env.ORCA_API_TOKEN || '');

function die(msg, code = 1) { console.error(`orca-agent: ${msg}`); process.exit(code); }
function out(value) { console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2)); }

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

async function api(method, path, body, { admin = false } = {}) {
  const headers = { accept: 'application/json' };
  if (admin) {
    if (!API_TOKEN) die('this command needs ORCA_API_TOKEN (admin).');
    headers['x-orca-token'] = API_TOKEN;
  } else {
    if (!LEASE) die('set ORCA_TOOL_LEASE_TOKEN (run `orca-agent bootstrap` first).');
    headers['x-orca-tool-lease'] = LEASE;
  }
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { /* non-json */ }
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

switch (cmd) {
  case 'bootstrap': {
    const body = {};
    if (flags.project) body.projectId = flags.project;
    if (flags.session) body.sessionId = flags.session;
    const r = await api('POST', '/api/mcp/orchestrator-bootstrap', body, { admin: true });
    if (!r.ok) die(`${r.status} ${r.data?.error || r.text}`, 2);
    // Print the lease token + the ready-to-use export line + the claude/codex commands.
    out({
      leaseToken: r.data.leaseToken,
      export: `export ORCA_TOOL_LEASE_TOKEN=${r.data.leaseToken}`,
      claudeCli: r.data.bootstrap?.clients?.claudeCli?.command || null,
      codexCli: r.data.bootstrap?.clients?.codexCli?.command || null,
      expiresAt: r.data.lease?.expiresAt || null,
    });
    break;
  }
  case 'next': {
    const qs = flags.session ? `?role=orchestrator&sessionId=${encodeURIComponent(flags.session)}` : '?role=orchestrator';
    show(await api('GET', `/api/agent-tools/next-action${qs}`));
    break;
  }
  case 'status': {
    const sessionId = _[0] || die('usage: orca-agent status <sessionId>');
    const r = await api('GET', `/api/sessions/${encodeURIComponent(sessionId)}/orchestrator/status`);
    if (!r.ok) die(`${r.status} ${r.data?.error || r.text}`, 2);
    out(r.data.tree || '(no tree)');
    out(`owner: ${r.data.activeOrchestrator?.active ? r.data.activeOrchestrator.actor : '(none)'}  ·  next: ${r.data.nextRequiredTool}`);
    break;
  }
  case 'enroll': {
    const sessionId = _[0] || die('usage: orca-agent enroll <sessionId> [--takeover]');
    show(await api('POST', `/api/sessions/${encodeURIComponent(sessionId)}/orchestrator/enroll`, { takeover: Boolean(flags.takeover) }));
    break;
  }
  case 'resign': {
    const sessionId = _[0] || die('usage: orca-agent resign <sessionId>');
    show(await api('POST', `/api/sessions/${encodeURIComponent(sessionId)}/orchestrator/resign`, {}));
    break;
  }
  case 'create-session': {
    const projectId = _[0] || die('usage: orca-agent create-session <projectId> <name...> [--auto] [--cap N] [--leader X]');
    const name = _.slice(1).join(' ') || die('session name required');
    // The lease is the authorization; policy-gated actions proceed with approved:true.
    const body = { approved: true, name, leader: flags.leader || 'codex', spawnPolicy: flags.auto ? 'auto' : 'within_capacity' };
    if (flags.cap) body.approvedCapacity = Number.parseInt(flags.cap, 10);
    show(await api('POST', `/api/projects/${encodeURIComponent(projectId)}/sessions`, body));
    break;
  }
  case 'add-task': {
    const sessionId = _[0] || die('usage: orca-agent add-task <sessionId> <title...>');
    const title = _.slice(1).join(' ') || die('task title required');
    show(await api('POST', `/api/sessions/${encodeURIComponent(sessionId)}/tasks`, { title }));
    break;
  }
  case 'bulk-add': {
    const sessionId = _[0] || die('usage: orca-agent bulk-add <sessionId>  (JSON task array on stdin)');
    let tasks;
    try { tasks = JSON.parse(await readStdin()); } catch { die('stdin must be a JSON array of tasks'); }
    if (!Array.isArray(tasks)) die('stdin must be a JSON array of tasks');
    show(await api('POST', `/api/sessions/${encodeURIComponent(sessionId)}/tasks/bulk`, { tasks }));
    break;
  }
  case 'backlog': {
    const sessionId = _[0] || die('usage: orca-agent backlog <sessionId>');
    show(await api('GET', `/api/sessions/${encodeURIComponent(sessionId)}/backlog`));
    break;
  }
  case 'call': {
    const method = (_[0] || '').toUpperCase() || die('usage: orca-agent call <METHOD> <path> [jsonBody]');
    const path = _[1] || die('path required');
    let body;
    if (_[2]) { try { body = JSON.parse(_[2]); } catch { die('jsonBody must be valid JSON'); } }
    show(await api(method, path, body));
    break;
  }
  default:
    out('orca-agent — drive Orca from any agent. Commands: bootstrap, next, status, enroll, resign, create-session, add-task, bulk-add, backlog, call. See header for usage.');
    if (cmd && cmd !== 'help') process.exit(1);
}
