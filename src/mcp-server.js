#!/usr/bin/env node
// Orca built-in MCP server (stdio JSON-RPC 2.0, newline-delimited).
//
// Auto-injected into each lane's MCP config so Codex/Claude executors and
// orchestrators can call Orca workflow tools (spawn/stop/task, audit, evidence,
// summary/diff, mode/permission changes) as NATIVE MCP tools — instead of
// hand-writing HTTP calls. Each tool call is proxied to the local Orca HTTP API
// authenticated with the lane's scoped tool lease (never the full API token).
//
// Hand-rolled (no @modelcontextprotocol/sdk dependency) to keep Orca's
// zero-runtime-dependency / minimal-supply-chain posture. Reads context purely
// from env so it works in both source and the packaged Tauri app.
//
// Env (set by the lane runtime):
//   ORCA_AGENT_TOOLS_BASE_URL  - e.g. http://127.0.0.1:3000
//   ORCA_TOOL_LEASE_TOKEN      - scoped lease used as x-orca-tool-lease
//   ORCA_ROLE                  - orchestrator | executor | auditor | critique
//   ORCA_LANE_ID / ORCA_SESSION_ID / ORCA_PROJECT_ID - default path params

import readline from 'node:readline';
import { TOOL_DEFINITIONS, normalizeRole, CONTRACT_VERSION, roleInstructions } from './agent-tools.js';

const BASE_URL = String(process.env.ORCA_AGENT_TOOLS_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const LEASE_TOKEN = String(process.env.ORCA_TOOL_LEASE_TOKEN || '');
const ROLE = normalizeRole(process.env.ORCA_ROLE || 'executor');
const DEFAULT_PARAMS = {
  sessionId: process.env.ORCA_SESSION_ID || '',
  laneId: process.env.ORCA_LANE_ID || '',
  projectId: process.env.ORCA_PROJECT_ID || '',
};
const SERVER_PROTOCOL_VERSION = '2024-11-05';

// MCP tool names can't contain dots in some clients; expose dotted ids as
// underscored names and keep a reverse map for routing.
const toMcpName = (id) => id.replace(/\./g, '__');
const fromMcpName = (name) => name.replace(/__/g, '.');

function callableTools() {
  return TOOL_DEFINITIONS.filter(
    (tool) => tool.implemented && tool.route && tool.roles.includes(ROLE),
  );
}

// Role operating rules are delivered in the MCP initialize response, so a desktop
// agent told to "act as the orchestrator" receives the rulebook at connect time.
// The text is the SINGLE shared rulebook (agent-tools/role-instructions.js) used by
// every surface; the server still enforces the workflow with nextAction envelopes.
function instructionsForRole() {
  // The shared rulebook references canonical dotted tool ids; MCP clients see the
  // "__" names, so translate each real tool id (precise — only known ids).
  let rules = roleInstructions(ROLE);
  for (const tool of TOOL_DEFINITIONS) {
    if (tool.id.includes('.')) rules = rules.split(tool.id).join(toMcpName(tool.id));
  }
  return (
    `${rules}\n\n`
    + 'Tool names use "__" where the contract uses "." (e.g. session.next_action -> session__next_action). '
    + 'Path params (sessionId/laneId/projectId) default from this connection when omitted. '
    + 'Mutating tools take a "body" object. The server is authoritative: it enforces ordering and policy and '
    + 'returns a nextAction envelope you must follow.'
  );
}

function pathParams(route) {
  return [...route.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
}

function toMcpTool(tool) {
  const params = pathParams(tool.route);
  const properties = {};
  for (const param of params) {
    properties[param] = {
      type: 'string',
      description: `${param}${DEFAULT_PARAMS[param] ? ' (defaults to this lane/session)' : ''}`,
    };
  }
  if (tool.mutating) {
    properties.body = {
      type: 'object',
      description: 'Request payload for this tool (fields depend on the action).',
    };
  }
  // Path params already defaulted from env are not required.
  const required = params.filter((p) => !DEFAULT_PARAMS[p]);
  return {
    name: toMcpName(tool.id),
    description: `${tool.summary} [${tool.method} ${tool.route}]`,
    inputSchema: { type: 'object', properties, required },
  };
}

function resolveRoute(route, args) {
  let out = route;
  let missing = null;
  for (const param of pathParams(route)) {
    const value = String(args?.[param] ?? DEFAULT_PARAMS[param] ?? '').trim();
    if (!value) {
      missing = param;
      break;
    }
    out = out.replace(`{${param}}`, encodeURIComponent(value));
  }
  return { out, missing };
}

async function callTool(name, args = {}) {
  const id = fromMcpName(name);
  const tool = callableTools().find((t) => t.id === id);
  if (!tool) {
    return { isError: true, text: `Unknown or unavailable tool for role ${ROLE}: ${id}` };
  }
  const { out, missing } = resolveRoute(tool.route, args);
  if (missing) {
    return { isError: true, text: `Missing required parameter "${missing}" for ${id}.` };
  }

  const url = `${BASE_URL}${out}`;
  const headers = {
    'x-orca-tool-lease': LEASE_TOKEN,
    accept: 'application/json',
  };
  const init = { method: tool.method, headers };
  if (tool.method !== 'GET') {
    const params = new Set(pathParams(tool.route));
    const body = args.body && typeof args.body === 'object'
      ? args.body
      : Object.fromEntries(Object.entries(args).filter(([k]) => !params.has(k)));
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    // Non-2xx bodies carry the nextAction envelope on authoritative refusals —
    // surface them so the agent learns exactly what to do next.
    return { isError: !res.ok, text: text || `(${res.status})` };
  } catch (error) {
    return { isError: true, text: `Orca tool call failed: ${error?.message || error}` };
  } finally {
    clearTimeout(timer);
  }
}

// Claude's --permission-prompt-tool target. Claude calls mcp__orca__permission_prompt
// when it needs approval for a tool; we record an approval on the lane and block
// until the orchestrator/user decides, then return Claude's expected allow/deny shape.
const PERMISSION_TOOL = {
  name: 'permission_prompt',
  description:
    'Permission gateway for Claude --permission-prompt-tool. Records a pending approval on the lane and waits for the orchestrator/user decision, then returns {behavior: allow|deny}.',
  inputSchema: {
    type: 'object',
    properties: {
      tool_name: { type: 'string', description: 'The tool Claude wants to run.' },
      input: { type: 'object', description: 'The proposed tool input.' },
    },
    required: ['tool_name'],
  },
};

async function handlePermissionPrompt(args = {}) {
  const laneId = DEFAULT_PARAMS.laneId;
  const deny = (message) => ({ isError: false, text: JSON.stringify({ behavior: 'deny', message }) });
  if (!laneId) return deny('No lane context for permission prompt.');
  const toolName = String(args.tool_name || args.toolName || 'tool');
  const input = args.input ?? {};
  const headers = { 'x-orca-tool-lease': LEASE_TOKEN, accept: 'application/json', 'content-type': 'application/json' };
  const approvalsUrl = `${BASE_URL}/api/lanes/${encodeURIComponent(laneId)}/approvals`;

  let approvalId = null;
  try {
    const res = await fetch(approvalsUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ actor: 'executor', kind: 'tool', detail: `${toolName} ${JSON.stringify(input)}`.slice(0, 1900) }),
    });
    const data = await res.json().catch(() => null);
    approvalId = data?.approval?.id;
  } catch (error) {
    return deny(`Approval request failed: ${error?.message || error}`);
  }
  if (!approvalId) return deny('Could not create approval request.');

  // Wait for a decision; humans/orchestrators may take a while.
  const deadline = Date.now() + 30 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    try {
      const res = await fetch(approvalsUrl, { headers });
      const data = await res.json().catch(() => null);
      const approval = (data?.approvals || []).find((entry) => entry.id === approvalId);
      if (approval && approval.status !== 'pending') {
        return approval.status === 'approved'
          ? { isError: false, text: JSON.stringify({ behavior: 'allow', updatedInput: input }) }
          : deny('Denied by orchestrator/user.');
      }
    } catch {
      // keep polling
    }
  }
  return deny('Approval timed out.');
}

// --- JSON-RPC plumbing -----------------------------------------------------

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(message) {
  const { id, method, params } = message;
  // Notifications (no id) get no response.
  if (id === undefined || id === null) return;

  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: params?.protocolVersion || SERVER_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'orca', version: '0.1.0', contractVersion: CONTRACT_VERSION },
        instructions: instructionsForRole(),
      });
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: [...callableTools().map(toMcpTool), PERMISSION_TOOL] });
    case 'tools/call': {
      const name = params?.name;
      if (name === 'permission_prompt') {
        const result = await handlePermissionPrompt(params?.arguments || {});
        return reply(id, { content: [{ type: 'text', text: result.text }], isError: false });
      }
      const result = await callTool(name, params?.arguments || {});
      return reply(id, {
        content: [{ type: 'text', text: result.text }],
        isError: Boolean(result.isError),
      });
    }
    default:
      return replyError(id, -32601, `Method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return; // ignore non-JSON lines
  }
  // JSON-RPC batch: an array of requests. Each is handled independently and its
  // response written on its own line (clients correlate by id).
  const messages = Array.isArray(message) ? message : [message];
  for (const entry of messages) {
    Promise.resolve(handle(entry)).catch((error) => {
      if (entry?.id !== undefined && entry?.id !== null) {
        replyError(entry.id, -32603, `Internal error: ${error?.message || error}`);
      }
    });
  }
});
