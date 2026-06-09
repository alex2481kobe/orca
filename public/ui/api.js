// API fetch wrapper + client auth-state (token, access-block detection, lock on
// 401). Low-level: depends on shared state + dom/constants, no render/refresh
// back-refs. Extracted from app.js.

import { shell } from './state.js';
import { isLocalHostName } from './dom.js';
import { API_TOKEN_STORAGE_KEY } from './constants.js';

export function initializeApiToken() {
  const saved = window.sessionStorage.getItem(API_TOKEN_STORAGE_KEY);
  shell.apiToken = saved || '';
  if (!window.location.search) return;
  const params = new URLSearchParams(window.location.search);
  if (!params.has('apiToken') && !params.has('token')) return;
  const cleaned = new URLSearchParams(window.location.search);
  cleaned.delete('apiToken');
  cleaned.delete('token');
  const next = cleaned.toString();
  const query = next ? `?${next}` : '';
  const url = `${window.location.pathname}${query}${window.location.hash || ''}`;
  window.history.replaceState({}, '', url);
}

export function isTrustedAdminClientHost() {
  const hostname = String(window.location.hostname || '').toLowerCase();
  return isLocalHostName(hostname) || hostname.endsWith('.local');
}

export function browserAccessBlocked() {
  return Boolean(
    (shell.authStatus?.apiTokenRequired
      && !shell.authStatus?.apiTokenAuthenticated
      && !shell.authStatus?.browserSessionAuthenticated)
    || (!shell.authStatus?.apiTokenRequired
      && !isTrustedAdminClientHost()
      && !shell.authStatus?.browserSessionAuthenticated),
  );
}

export function setApiToken(token) {
  const nextToken = (token || '').trim();
  shell.apiToken = nextToken;
  if (nextToken) {
    window.sessionStorage.setItem(API_TOKEN_STORAGE_KEY, nextToken);
  } else {
    window.sessionStorage.removeItem(API_TOKEN_STORAGE_KEY);
  }
}

export function currentActiveProject() {
  return shell.projects.find((value) => value.slug === shell.route.projectSlug || value.id === shell.route.projectSlug) || null;
}

export function clearProtectedWorkspaceState() {
  shell.projects = [];
  shell.sessions = [];
  shell.lanes = [];
  shell.policy = {};
  shell.pendingAuditEvents = [];
  shell.mcpTools = [];
  shell.providerCatalog = null;
  shell.notifications = null;
  shell.authSessions = null;
  shell.executorProfiles = null;
  shell.executorCliInfo = {};
}

export function lockClientAuthState() {
  shell.authStatus = {
    ...(shell.authStatus || {}),
    apiTokenRequired: shell.authStatus?.apiTokenRequired || true,
    apiTokenAuthenticated: false,
    browserSessionAuthenticated: false,
  };
  clearProtectedWorkspaceState();
}

export function maybeLockFromResponse(response) {
  if (!response || response.status !== 401) return false;
  if (!browserAccessBlocked()) {
    lockClientAuthState();
  }
  return true;
}

export async function api(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
  };
  if (shell.apiToken) {
    headers['x-orca-token'] = shell.apiToken;
  }
  let resp;
  try {
    resp = await fetch(path, {
      headers,
      credentials: 'same-origin',
      ...options,
      body: options.body ? JSON.stringify(options.body) : options.body,
    });
  } catch {
    // Network failure (offline, DNS, connection reset). Every caller checks
    // `resp.ok` and has a "Could not…" branch, but they assumed api() never throws —
    // a raw rejection left loading spinners (folder picker, project create) stuck
    // forever. Normalize to a non-ok response so those error branches fire.
    return { ok: false, status: 0, data: { error: 'Network error — could not reach the server.' } };
  }
  const bodyText = await resp.text();
  let bodyJson = null;
  if (bodyText) {
    try {
      bodyJson = JSON.parse(bodyText);
    } catch {
      bodyJson = { raw: bodyText };
    }
  }
  const normalizedResponse = { ok: resp.ok, status: resp.status, data: bodyJson };
  if (normalizedResponse.status === 401 && !browserAccessBlocked()) {
    maybeLockFromResponse(normalizedResponse);
  }
  return normalizedResponse;
}
