// How the MCP bridge talks to Orca, and what it says when that fails.
//
// One module, so every failure an agent can hit is explained the same way: the
// URL that was tried, the likely cause, and the one command that fixes it. The
// bridge's tool calls and its permission relay use it, and `orca-cli.js` uses the
// same explanations.
//
// Leases stay alive by two established patterns:
//   - sliding renewal, server side (registry-tool-leases.js), the way etcd, Consul
//     and Kubernetes leases stay alive while their holder is active;
//   - a refresh credential in the client config, the OAuth2 refresh-token
//     pattern: the bridge exchanges it for its own lease, and for a new one after
//     the old one lapses, with no config rewrite and no client restart.
//
// A call whose outcome is unknown is never replayed. The only repeat is of the
// single call the server refused for a lease reason. Those refusals come from
// validateToolLease, which runs in the auth gate before any route handler, so
// the refused call did not run and sending it once more is safe.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ORCA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CLI_PATH = path.join(ORCA_DIR, 'src', 'orca-cli.js');
export const DEFAULT_BASE_URL = 'http://127.0.0.1:3000';
export const REFRESH_ROUTE = '/api/agent-tools/leases/refresh';
export const REFRESH_HEADER = 'x-orca-refresh-token';
export const LEASE_HEADER = 'x-orca-tool-lease';

// Every refusal validateToolLease throws for the lease itself.
export const LEASE_REJECTIONS = new Set([
  'Tool lease token is required.',
  'Tool lease not found.',
  'Tool lease has been revoked.',
  'Tool lease has expired.',
]);

const REFRESH_REASONS = {
  'Refresh credential has been revoked.': 'An operator revoked it, or Orca setup ran again for this client and replaced it.',
  'Refresh credential not found.': 'This Orca does not know it: its state was reset, or this client points at a different Orca.',
  'Refresh credential has expired.': 'It went unused for 90 days.',
  'Refresh credential is required.': 'The client config has an empty ORCA_REFRESH_TOKEN.',
};

export function shellQuote(value) {
  const text = String(value);
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
}

// The commands a message can hand an agent. Absolute paths only: an agent's
// shell may have no `node` on PATH and may be in any directory. `start` runs Orca
// as a daemon no session owns (orca-cli.js start). A foreground `npm start` run
// by an agent would belong to that agent's session and die with it.
const cli = (args) => `${shellQuote(process.execPath)} ${shellQuote(CLI_PATH)} ${args}`;
export const fixCommands = {
  start: () => cli('start'),
  status: () => cli('status'),
  stop: () => cli('stop'),
  setup: (roots = null) => cli(`setup --roots ${Array.isArray(roots) && roots.length ? shellQuote(roots.join(',')) : '<dir>[,<dir>...]'}`),
  doctor: () => `${shellQuote(process.execPath)} ${shellQuote(CLI_PATH)} doctor`,
  connect: (client = 'claude', extra = '') => `${shellQuote(process.execPath)} ${shellQuote(CLI_PATH)} connect ${client}${extra ? ` ${extra}` : ''}`,
};

const lines = (...parts) => parts.filter(Boolean).join('\n');

export function clientFromName(name) {
  return /codex/i.test(String(name || '')) ? 'codex' : 'claude';
}

export function networkCode(error) {
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return 'TIMEOUT';
  return error?.cause?.code || error?.code || error?.cause?.name || null;
}

const checkTools = (role) => (role === 'orchestrator' ? 'orchestrator__status or lane__list' : 'lane__get');

// The request failed below HTTP. Whether it can have reached Orca decides what
// the agent may do next: a refused or unresolvable connection never did, so the
// call is safe to repeat once Orca is back; a dropped or timed-out one may have.
export function explainNetworkError(error, {
  baseUrl, mutating = false, client = 'claude', role = 'orchestrator', timeoutMs = 60_000,
} = {}) {
  const code = networkCode(error);
  if (code === 'ECONNREFUSED') {
    return lines(
      `Orca is not running at ${baseUrl}: the connection was refused, so nothing is listening on that port.`,
      `Fix: ${fixCommands.start()}`,
      `If Orca is already running, start reports it and changes nothing. If Orca runs on another port, run ${fixCommands.doctor()} to see what this client points at.`,
      'This call never reached Orca, so repeating it once Orca is up is safe.',
    );
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ERR_INVALID_URL') {
    return lines(
      `This client points at ${baseUrl}, which does not resolve to a reachable host (${code}).`,
      `Fix: ${fixCommands.connect(client)}`,
      'This call never reached Orca.',
    );
  }
  const outcome = mutating
    ? `This call may have reached Orca, so its outcome is unknown. Do not repeat it blindly.`
    : 'This call only reads, so repeating it is safe.';
  const fix = mutating
    ? `Fix: call ${checkTools(role)} to see whether it happened, and repeat it only if it did not.`
    : `Fix: repeat the call; if it keeps failing, run ${fixCommands.doctor()}`;
  if (code === 'TIMEOUT') {
    return lines(`Orca at ${baseUrl} did not answer within ${Math.round(timeoutMs / 1000)} s.`, outcome, fix);
  }
  return lines(
    `The connection to Orca at ${baseUrl} dropped before it answered (${code || error?.message || 'unknown error'}).`,
    outcome,
    fix,
  );
}

export function explainNotOrca({ baseUrl, status, contentType, bodyText, client = 'claude' }) {
  const said = String(bodyText || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return lines(
    `Something answered at ${baseUrl} (HTTP ${status}, ${contentType || 'no content type'}${said ? `: "${said}"` : ''}), but it is not Orca's API.`,
    `Fix: ${fixCommands.connect(client, '--url <the URL Orca printed when it started>')}`,
    `To see what is listening where, run ${fixCommands.doctor()}`,
  );
}

export function explainLeaseRejection({ error, role = 'orchestrator', laneId = '', client = 'claude', hasRefresh = false, afterRefresh = false }) {
  if (role !== 'orchestrator') {
    return lines(
      `${error} This connection's lease belongs to lane ${laneId || '(unknown)'} and ends with it: the lane has finished, been stopped, or been deleted.`,
      `Fix: ask your orchestrator to run lane__retry on lane ${laneId || '(unknown)'} if the work is not done.`,
    );
  }
  if (afterRefresh) {
    return lines(
      `${error} Orca refused a lease it had just issued to this client, which should not happen.`,
      `Fix: ${fixCommands.doctor()}`,
    );
  }
  if (!hasRefresh) {
    return lines(
      `${error} This client config holds one fixed lease (ORCA_TOOL_LEASE_TOKEN) and no refresh credential (ORCA_REFRESH_TOKEN), so it cannot get a new lease by itself.`,
      `Fix: ${fixCommands.connect(client)} — then restart this session so it loads the new config.`,
    );
  }
  return lines(`${error}`, `Fix: ${fixCommands.doctor()}`);
}

export function explainRefreshFailure({ status, error, client = 'claude' }) {
  const reason = REFRESH_REASONS[error];
  if (reason) {
    return lines(
      `Orca refused this client's credential: ${error} ${reason}`,
      `Fix: ${fixCommands.connect(client)} — then restart this session so it loads the new config.`,
    );
  }
  return lines(
    `Orca could not issue this client a lease (HTTP ${status}): ${error || 'no reason given'}`,
    `Fix: ${fixCommands.connect(client)} — then restart this session so it loads the new config.`,
  );
}

// A JSON refusal from Orca that is not about the lease. Workflow refusals (409
// with a nextAction envelope, 404, 422) already say what to do; only the
// connection-shaped ones get a fix added.
export function explainHttpFailure({ status, error, bodyText, baseUrl, client = 'claude' }) {
  if (status === 503) {
    return lines(
      `${error || 'Orca is unavailable.'} Orca is starting or shutting down; try again in a few seconds.`,
      `Fix: if it keeps answering 503, run ${fixCommands.doctor()}`,
    );
  }
  if (status === 401) {
    return lines(
      `${error} This client reached Orca at ${baseUrl} without a credential it accepts.`,
      `Fix: ${fixCommands.connect(client)} — then restart this session so it loads the new config.`,
    );
  }
  if (status === 403 && /Tool lease/.test(error || '')) {
    return lines(
      `${error} This client's credential is scoped to a different role, project or session.`,
      `Fix: ${fixCommands.doctor()}`,
    );
  }
  return bodyText || `(${status})`;
}

function parseJson(text) {
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

// The bridge's link to Orca: the base URL, the credential from the client
// config, and the lease it currently holds (in memory only; never written).
export class OrcaConnection {
  constructor({
    baseUrl = DEFAULT_BASE_URL,
    leaseToken = '',
    refreshToken = '',
    role = 'orchestrator',
    laneId = '',
    timeoutMs = 60_000,
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.baseUrl = String(baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
    this.leaseToken = String(leaseToken || '');
    this.refreshToken = String(refreshToken || '');
    this.role = role;
    this.laneId = laneId;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.client = 'claude';
    this.pendingExchange = null;
  }

  setClientName(name) {
    this.client = clientFromName(name);
  }

  async fetchWithTimeout(url, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  // Exchange the refresh credential for a lease. One exchange at a time: calls
  // that find the lease gone together share it.
  obtainLease() {
    if (!this.pendingExchange) {
      this.pendingExchange = this.exchange().finally(() => { this.pendingExchange = null; });
    }
    return this.pendingExchange;
  }

  async exchange() {
    let res;
    try {
      res = await this.fetchWithTimeout(`${this.baseUrl}${REFRESH_ROUTE}`, {
        method: 'POST',
        headers: { [REFRESH_HEADER]: this.refreshToken, accept: 'application/json', 'content-type': 'application/json' },
        body: '{}',
      });
    } catch (error) {
      // Obtaining a lease only adds one; asking again is harmless.
      return { ok: false, text: explainNetworkError(error, { baseUrl: this.baseUrl, mutating: false, client: this.client, role: this.role, timeoutMs: this.timeoutMs }) };
    }
    const bodyText = await res.text();
    const contentType = res.headers.get('content-type') || '';
    const data = /json/i.test(contentType) ? parseJson(bodyText) : null;
    if (!data) {
      return { ok: false, text: explainNotOrca({ baseUrl: this.baseUrl, status: res.status, contentType, bodyText, client: this.client }) };
    }
    if (res.ok && data.leaseToken) {
      this.leaseToken = String(data.leaseToken);
      return { ok: true };
    }
    if (res.status === 503) {
      return { ok: false, text: explainHttpFailure({ status: 503, error: data.error, baseUrl: this.baseUrl, client: this.client }) };
    }
    return { ok: false, text: explainRefreshFailure({ status: res.status, error: String(data.error || ''), client: this.client }) };
  }

  async send(route, { method, body, mutating }) {
    const token = this.leaseToken;
    const headers = { accept: 'application/json' };
    if (token) headers[LEASE_HEADER] = token;
    const init = { method, headers };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await this.fetchWithTimeout(`${this.baseUrl}${route}`, init);
    } catch (error) {
      return {
        result: {
          isError: true,
          text: explainNetworkError(error, { baseUrl: this.baseUrl, mutating, client: this.client, role: this.role, timeoutMs: this.timeoutMs }),
        },
      };
    }
    const bodyText = await res.text();
    if (res.ok) return { result: { isError: false, text: bodyText || `(${res.status})` } };
    const contentType = res.headers.get('content-type') || '';
    const data = /json/i.test(contentType) ? parseJson(bodyText) : null;
    if (!data) {
      return { result: { isError: true, text: explainNotOrca({ baseUrl: this.baseUrl, status: res.status, contentType, bodyText, client: this.client }) } };
    }
    const error = String(data.error || '');
    if (res.status === 401 && LEASE_REJECTIONS.has(error)) {
      return { leaseRejected: true, token, error };
    }
    return { result: { isError: true, text: explainHttpFailure({ status: res.status, error, bodyText, baseUrl: this.baseUrl, client: this.client }) } };
  }

  // One Orca API call on behalf of the agent. Returns { isError, text }.
  async call(route, { method = 'GET', body, mutating = false } = {}) {
    const hasRefresh = Boolean(this.refreshToken);
    if (!this.leaseToken && hasRefresh) {
      const obtained = await this.obtainLease();
      if (!obtained.ok) return { isError: true, text: obtained.text };
    }
    let attempt = await this.send(route, { method, body, mutating });
    if (!attempt.leaseRejected) return attempt.result;
    if (!hasRefresh) {
      return {
        isError: true,
        text: explainLeaseRejection({ error: attempt.error, role: this.role, laneId: this.laneId, client: this.client, hasRefresh }),
      };
    }
    // Refused in the auth gate, so the call did not run: get a lease (unless a
    // concurrent call already replaced this one) and repeat it once.
    if (this.leaseToken === attempt.token) {
      const obtained = await this.obtainLease();
      if (!obtained.ok) return { isError: true, text: obtained.text };
    }
    attempt = await this.send(route, { method, body, mutating });
    if (!attempt.leaseRejected) return attempt.result;
    return {
      isError: true,
      text: explainLeaseRejection({ error: attempt.error, role: this.role, laneId: this.laneId, client: this.client, hasRefresh, afterRefresh: true }),
    };
  }
}
