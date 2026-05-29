import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { validateNetworkUrl } from './url-policy.js';
import {
  readJsonFileWithRecovery,
  writeJsonFileAtomic,
} from './state-store.js';

const nowIso = () => new Date().toISOString();

const ACCESS_MODES = new Set(['auto', 'local', 'tailnet-http', 'tailnet-https-serve']);
const TARGET_ACCESS_MODES = new Set(['local', 'tailnet-http', 'tailnet-https-serve']);
const SETUP_STATES = new Set([
  'not_configured',
  'setup_pending',
  'configured_unchecked',
  'reachable',
  'unreachable',
  'external_verification_required',
]);

const DEFAULT_SETTINGS = {
  preferredMode: 'auto',
  openTarget: 'external',
  pwaMode: 'enabled',
  notificationMode: 'in_app',
  tailscaleCommandBehavior: 'dry_run_only',
  setupStatus: 'not_configured',
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeText(value, fallback = '') {
  return String(value ?? fallback).trim();
}

function normalizePort(value, fallback = 3000) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) return fallback;
  return parsed;
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function containsFunnel(value) {
  return String(value || '').toLowerCase().includes('funnel');
}

function rejectPrototypeKeys(value, pathLabel = 'body') {
  if (!isPlainObject(value)) return;
  for (const key of Object.keys(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) {
      throw { status: 422, message: `${pathLabel} contains unsafe key "${key}".` };
    }
    if (isPlainObject(value[key])) rejectPrototypeKeys(value[key], `${pathLabel}.${key}`);
  }
}

function validateAccessUrl(raw, { mode = 'local', allowBlank = false, field = 'url' } = {}) {
  const text = normalizeText(raw);
  if (!text) {
    if (allowBlank) return null;
    throw { status: 422, message: `${field} is required.` };
  }
  if (text.length > 2048) {
    throw { status: 422, message: `${field} is too long.` };
  }
  if (containsFunnel(text)) {
    throw { status: 422, message: 'Tailscale Funnel URLs/configuration are forbidden for v1.' };
  }
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw { status: 422, message: `${field} must be a valid absolute URL.` };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw { status: 422, message: `${field} must use http or https.` };
  }
  if (parsed.username || parsed.password) {
    throw { status: 422, message: `${field} must not include credentials.` };
  }
  if (!parsed.hostname || parsed.hostname.length > 253) {
    throw { status: 422, message: `${field} has an invalid host.` };
  }
  if (mode === 'local') {
    return validateNetworkUrl(text, {
      field,
      allowedHosts: ['loopback'],
      requireProtocol: parsed.protocol,
    }).url;
  }
  if (mode === 'tailnet-http' && parsed.protocol !== 'http:') {
    throw { status: 422, message: 'tailnet-http targets must use http.' };
  }
  if (mode === 'tailnet-https-serve' && parsed.protocol !== 'https:') {
    throw { status: 422, message: 'tailnet-https-serve targets must use https.' };
  }
  if (mode === 'tailnet-http' || mode === 'tailnet-https-serve') {
    return validateNetworkUrl(text, {
      field,
      allowedHosts: ['tailnet'],
      requireProtocol: parsed.protocol,
    }).url;
  }
  return validateNetworkUrl(text, { field }).url;
}

function normalizeMode(raw, { allowAuto = false } = {}) {
  const mode = normalizeText(raw || (allowAuto ? 'auto' : 'local')).toLowerCase();
  const allowedModes = allowAuto ? ACCESS_MODES : TARGET_ACCESS_MODES;
  if (containsFunnel(mode) || !allowedModes.has(mode)) {
    throw { status: 422, message: 'Unsupported private access mode.' };
  }
  return mode;
}

function normalizeSetupStatus(raw, fallback = 'not_configured') {
  const status = normalizeText(raw || fallback).toLowerCase();
  return SETUP_STATES.has(status) ? status : fallback;
}

function normalizeSettings(raw = {}) {
  rejectPrototypeKeys(raw, 'settings');
  const settings = { ...DEFAULT_SETTINGS };
  if (raw.preferredMode !== undefined) settings.preferredMode = normalizeMode(raw.preferredMode, { allowAuto: true });
  if (raw.openTarget !== undefined) {
    const value = normalizeText(raw.openTarget).toLowerCase();
    settings.openTarget = ['external', 'in_app'].includes(value) ? value : DEFAULT_SETTINGS.openTarget;
  }
  if (raw.pwaMode !== undefined) {
    const value = normalizeText(raw.pwaMode).toLowerCase();
    settings.pwaMode = ['enabled', 'disabled'].includes(value) ? value : DEFAULT_SETTINGS.pwaMode;
  }
  if (raw.notificationMode !== undefined) {
    const value = normalizeText(raw.notificationMode).toLowerCase();
    settings.notificationMode = ['off', 'in_app', 'browser'].includes(value) ? value : DEFAULT_SETTINGS.notificationMode;
  }
  if (raw.tailscaleCommandBehavior !== undefined) {
    const value = normalizeText(raw.tailscaleCommandBehavior).toLowerCase();
    settings.tailscaleCommandBehavior = ['dry_run_only', 'approval_required'].includes(value)
      ? value
      : DEFAULT_SETTINGS.tailscaleCommandBehavior;
  }
  if (raw.setupStatus !== undefined) {
    settings.setupStatus = normalizeSetupStatus(raw.setupStatus, DEFAULT_SETTINGS.setupStatus);
  }
  return settings;
}

function normalizeTarget(raw = {}, existing = null) {
  rejectPrototypeKeys(raw, 'target');
  const id = normalizeText(existing?.id || raw.id || randomUUID());
  const label = normalizeText(raw.label || existing?.label || 'Local dev server').slice(0, 100);
  const mode = normalizeMode(raw.mode || existing?.mode || 'local');
  const localUrl = validateAccessUrl(raw.localUrl ?? existing?.localUrl, { mode: 'local', field: 'localUrl' });
  const tailnetHttpUrl = validateAccessUrl(raw.tailnetHttpUrl ?? existing?.tailnetHttpUrl, {
    mode: 'tailnet-http',
    allowBlank: true,
    field: 'tailnetHttpUrl',
  });
  const httpsServeUrl = validateAccessUrl(raw.httpsServeUrl ?? existing?.httpsServeUrl, {
    mode: 'tailnet-https-serve',
    allowBlank: true,
    field: 'httpsServeUrl',
  });
  const preferredOpenTarget = normalizeText(raw.preferredOpenTarget || existing?.preferredOpenTarget || 'external').toLowerCase();
  const type = normalizeText(raw.type || existing?.type || 'app').slice(0, 40);
  const group = normalizeText(raw.group || existing?.group || '').slice(0, 80);
  const notes = normalizeText(raw.notes || existing?.notes || '').slice(0, 500);
  const evidencePreset = normalizeText(raw.evidencePreset || existing?.evidencePreset || 'screenshot').slice(0, 40);

  return {
    id,
    label,
    type,
    group,
    mode,
    localUrl,
    tailnetHttpUrl,
    httpsServeUrl,
    preferredOpenTarget: ['external', 'in_app'].includes(preferredOpenTarget) ? preferredOpenTarget : 'external',
    favorite: Boolean(raw.favorite ?? existing?.favorite ?? false),
    hidden: Boolean(raw.hidden ?? existing?.hidden ?? false),
    healthStatus: existing?.healthStatus || 'configured_unchecked',
    lastCheckedAt: existing?.lastCheckedAt || null,
    lastHealthDetail: existing?.lastHealthDetail || null,
    evidencePreset,
    notes,
    createdAt: existing?.createdAt || nowIso(),
    updatedAt: nowIso(),
  };
}

function targetUrlForMode(target) {
  if (!target) return null;
  if (target.mode === 'tailnet-https-serve') return target.httpsServeUrl || target.localUrl;
  if (target.mode === 'tailnet-http') return target.tailnetHttpUrl || target.localUrl;
  return target.localUrl;
}

function commandText(command) {
  return command.map((part) => String(part)).join(' ');
}

function buildSetupPlan(input = {}) {
  rejectPrototypeKeys(input, 'setupPlan');
  const localPort = normalizePort(input.localPort || input.port || process.env.PORT || 3000, 3000);
  let localUrl;
  try {
    localUrl = validateAccessUrl(input.localUrl || `http://127.0.0.1:${localPort}`, {
      mode: 'local',
      field: 'localUrl',
    });
  } catch {
    localUrl = validateAccessUrl(`http://127.0.0.1:${localPort}`, {
      mode: 'local',
      field: 'localUrl',
    });
  }
  const httpsPort = normalizePort(input.httpsPort || 443, 443);
  const httpPort = normalizePort(input.httpPort || 80, 80);

  const commands = [
    {
      id: 'local',
      label: 'Local browser URL',
      mode: 'local',
      command: null,
      copyText: localUrl,
      mutatesMachine: false,
      status: 'ready',
      note: 'Use this on the host machine before tailnet setup.',
    },
    {
      id: 'tailnet-http',
      label: 'Tailscale Serve private HTTP',
      mode: 'tailnet-http',
      command: ['tailscale', 'serve', '--bg', `--http=${httpPort}`, localUrl],
      copyText: commandText(['tailscale', 'serve', '--bg', `--http=${httpPort}`, localUrl]),
      mutatesMachine: true,
      status: 'dry_run_only',
      note: 'Private to the tailnet. Tailscale encrypts transport, but browser may not treat it as a secure context.',
    },
    {
      id: 'tailnet-https-serve',
      label: 'Tailscale Serve private HTTPS',
      mode: 'tailnet-https-serve',
      command: ['tailscale', 'serve', '--bg', `--https=${httpsPort}`, localUrl],
      copyText: commandText(['tailscale', 'serve', '--bg', `--https=${httpsPort}`, localUrl]),
      mutatesMachine: true,
      status: 'dry_run_only',
      note: 'Private to the tailnet and enables browser secure-context/PWA features; .ts.net hostname metadata may appear in certificate transparency.',
    },
    {
      id: 'serve-status',
      label: 'Inspect Tailscale Serve status',
      mode: 'inspect',
      command: ['tailscale', 'serve', 'status'],
      copyText: commandText(['tailscale', 'serve', 'status']),
      mutatesMachine: false,
      status: 'read_only',
      note: 'Read-only status check.',
    },
  ];

  return {
    generatedAt: nowIso(),
    localUrl,
    httpPort,
    httpsPort,
    commands,
    docs: {
      source: 'Tailscale Serve CLI supports --http=<port>, --https=<port>, --bg, and local service targets.',
      funnelForbidden: true,
    },
  };
}

function fakeTailnetState(state = 'missing') {
  const normalized = normalizeText(state || 'missing').toLowerCase();
  const base = {
    provider: 'fake',
    checkedAt: nowIso(),
    binaryAvailable: false,
    loggedIn: false,
    hostname: null,
    serveConfigured: false,
    serveMode: null,
    setupStatus: 'setup_pending',
    blockers: [],
    nextStep: 'Install Tailscale, sign in, then configure private Serve from the dry-run command.',
    readOnly: true,
  };
  if (normalized === 'installed') {
    return { ...base, binaryAvailable: true, nextStep: 'Sign in to Tailscale.' };
  }
  if (normalized === 'logged-in') {
    return { ...base, binaryAvailable: true, loggedIn: true, hostname: 'command-deck.test-tailnet.ts.net', nextStep: 'Configure Tailscale Serve.' };
  }
  if (normalized === 'serve-http') {
    return { ...base, binaryAvailable: true, loggedIn: true, hostname: 'command-deck.test-tailnet.ts.net', serveConfigured: true, serveMode: 'tailnet-http', setupStatus: 'configured_unchecked', nextStep: 'Open the HTTP tailnet URL from another device and mark external verification.' };
  }
  if (normalized === 'serve-https') {
    return { ...base, binaryAvailable: true, loggedIn: true, hostname: 'command-deck.test-tailnet.ts.net', serveConfigured: true, serveMode: 'tailnet-https-serve', setupStatus: 'configured_unchecked', nextStep: 'Open the HTTPS Serve URL from another device and verify PWA behavior.' };
  }
  if (normalized === 'funnel') {
    return { ...base, binaryAvailable: true, loggedIn: true, hostname: 'command-deck.test-tailnet.ts.net', serveConfigured: false, serveMode: 'funnel', setupStatus: 'unreachable', blockers: ['Funnel detected and rejected. Use private Tailscale Serve only.'], nextStep: 'Disable Funnel and configure private Serve.' };
  }
  return { ...base, blockers: ['Tailscale binary missing or not detected.'] };
}

function detectTailnetState({ fakeState = null, runner = spawnSync } = {}) {
  if (fakeState) return fakeTailnetState(fakeState);
  const binary = runner('tailscale', ['version'], {
    encoding: 'utf8',
    timeout: 1500,
    maxBuffer: 64 * 1024,
    windowsHide: true,
  });
  if (binary.error || binary.status !== 0) return fakeTailnetState('missing');

  const status = runner('tailscale', ['status', '--json'], {
    encoding: 'utf8',
    timeout: 1500,
    maxBuffer: 256 * 1024,
    windowsHide: true,
  });
  if (status.error || status.status !== 0) {
    return {
      ...fakeTailnetState('installed'),
      provider: 'real-read-only',
      binaryAvailable: true,
      blockers: ['Tailscale status is unavailable or not logged in.'],
    };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(status.stdout || '{}');
  } catch {
    parsed = null;
  }
  const hostname = parsed?.Self?.DNSName ? String(parsed.Self.DNSName).replace(/\.$/, '') : null;
  return {
    provider: 'real-read-only',
    checkedAt: nowIso(),
    binaryAvailable: true,
    loggedIn: Boolean(parsed?.Self),
    hostname,
    serveConfigured: false,
    serveMode: null,
    setupStatus: parsed?.Self ? 'setup_pending' : 'not_configured',
    blockers: parsed?.Self ? [] : ['Tailscale is installed but login state could not be confirmed.'],
    nextStep: parsed?.Self ? 'Configure Tailscale Serve from the dry-run command.' : 'Sign in to Tailscale.',
    readOnly: true,
  };
}

async function boundedHealthCheck(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
    });
    return {
      status: response.ok ? 'reachable' : 'unreachable',
      httpStatus: response.status,
      detail: response.ok ? 'URL responded successfully.' : `URL responded with HTTP ${response.status}.`,
    };
  } catch (error) {
    return {
      status: 'unreachable',
      httpStatus: null,
      detail: error?.name === 'AbortError' ? 'Health check timed out.' : 'Health check failed.',
    };
  } finally {
    clearTimeout(timeout);
  }
}

class PrivateAccessStore {
  constructor({ stateFile = null, runner = spawnSync } = {}) {
    this.stateFile = stateFile || path.join(process.cwd(), '.command-deck', 'private-access.json');
    this.runner = runner;
    this.loaded = false;
    this.loadStatus = null;
    this.state = {
      version: 1,
      settings: { ...DEFAULT_SETTINGS },
      targets: [],
      auditEvents: [],
    };
  }

  async ensureLoaded() {
    if (this.loaded) return;
    // Share a single in-flight load so concurrent callers all await the same
    // completion instead of returning before state is populated (or double-init).
    if (!this._loadPromise) this._loadPromise = this._loadState();
    try {
      await this._loadPromise;
    } finally {
      this.loaded = true;
      this._loadPromise = null;
    }
  }

  async _loadState() {
    const fallback = {
      version: 1,
      settings: { ...DEFAULT_SETTINGS },
      targets: [],
      auditEvents: [],
    };
    try {
      const recovered = await readJsonFileWithRecovery(this.stateFile, { fallback });
      this.loadStatus = recovered.status;
      const parsed = recovered.data || fallback;
      const shouldAuditRecovery = this.loadStatus?.recovered || this.loadStatus?.ok === false;
      this.state = {
        version: 1,
        settings: normalizeSettings(parsed.settings || {}),
        targets: Array.isArray(parsed.targets) ? parsed.targets.map((target) => normalizeTarget(target)) : [],
        auditEvents: Array.isArray(parsed.auditEvents) ? parsed.auditEvents.slice(0, 200) : [],
      };
      if (shouldAuditRecovery) {
        this.recordAudit({
          type: 'private_access_state_recovered',
          actor: 'system',
          summary: `Private access state loaded from ${this.loadStatus.source}`,
          status: this.loadStatus.ok ? 'passed' : 'failed',
          evidence: {
            source: this.loadStatus.source,
            recovered: this.loadStatus.recovered,
            filePath: this.loadStatus.filePath,
            backupPath: this.loadStatus.backupPath,
            corruptPath: this.loadStatus.corruptPath,
            reason: this.loadStatus.reason,
            backupReason: this.loadStatus.backupReason,
          },
        });
        await this.persist();
      }
    } catch {
      this.state = fallback;
    }
  }

  async persist() {
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
    await writeJsonFileAtomic(this.stateFile, {
      ...this.state,
      savedAt: nowIso(),
    });
  }

  recordAudit(event) {
    this.state.auditEvents.unshift({
      id: randomUUID(),
      createdAt: nowIso(),
      ...event,
    });
    this.state.auditEvents = this.state.auditEvents.slice(0, 200);
  }

  async describe({ origin = '', fakeTailnetState: fakeState = null } = {}) {
    await this.ensureLoaded();
    const setupPlan = buildSetupPlan({ localUrl: origin ? `${origin}` : undefined });
    const tailnet = detectTailnetState({ fakeState, runner: this.runner });
    return {
      version: this.state.version,
      loadStatus: clone(this.loadStatus),
      settings: clone(this.state.settings),
      targets: clone(this.state.targets),
      tailnet,
      setupPlan,
      pwa: {
        manifestUrl: '/manifest.webmanifest',
        serviceWorkerUrl: '/service-worker.js',
        staticOnlyCache: true,
        sensitiveCacheForbidden: true,
      },
      docs: {
        httpOverTailscale: 'Tailscale encrypts transport, but HTTP may not be a browser secure context for service workers, notifications, clipboard, camera/mic, and installability.',
        httpsServe: 'HTTPS Serve enables secure-context browser/PWA APIs but can expose .ts.net hostname metadata through certificate transparency.',
        funnel: 'Tailscale Funnel is forbidden for v1.',
      },
    };
  }

  async updateSettings(raw, { actor = 'dashboard' } = {}) {
    await this.ensureLoaded();
    const settings = normalizeSettings({ ...this.state.settings, ...raw });
    this.state.settings = settings;
    this.recordAudit({
      type: 'private_access_settings_updated',
      actor,
      summary: 'Private access settings updated',
      status: 'passed',
      evidence: { settings },
    });
    await this.persist();
    return clone(settings);
  }

  async createTarget(raw, { actor = 'dashboard' } = {}) {
    await this.ensureLoaded();
    const target = normalizeTarget(raw);
    this.state.targets.push(target);
    this.recordAudit({
      type: 'private_access_target_created',
      actor,
      summary: `Private access target ${target.label} created`,
      status: 'passed',
      evidence: { targetId: target.id, mode: target.mode },
    });
    await this.persist();
    return clone(target);
  }

  async updateTarget(id, raw, { actor = 'dashboard' } = {}) {
    await this.ensureLoaded();
    const index = this.state.targets.findIndex((target) => target.id === id);
    if (index < 0) throw { status: 404, message: 'Private access target not found.' };
    const next = normalizeTarget(raw, this.state.targets[index]);
    this.state.targets[index] = next;
    this.recordAudit({
      type: 'private_access_target_updated',
      actor,
      summary: `Private access target ${next.label} updated`,
      status: 'passed',
      evidence: { targetId: next.id, mode: next.mode },
    });
    await this.persist();
    return clone(next);
  }

  async deleteTarget(id, { actor = 'dashboard' } = {}) {
    await this.ensureLoaded();
    const index = this.state.targets.findIndex((target) => target.id === id);
    if (index < 0) throw { status: 404, message: 'Private access target not found.' };
    const [removed] = this.state.targets.splice(index, 1);
    this.recordAudit({
      type: 'private_access_target_deleted',
      actor,
      summary: `Private access target ${removed.label} deleted`,
      status: 'passed',
      evidence: { targetId: removed.id },
    });
    await this.persist();
    return { removed: true, targetId: removed.id };
  }

  async checkTarget(id, { actor = 'dashboard' } = {}) {
    await this.ensureLoaded();
    const target = this.state.targets.find((item) => item.id === id);
    if (!target) throw { status: 404, message: 'Private access target not found.' };
    const url = targetUrlForMode(target);
    const result = await boundedHealthCheck(url);
    target.healthStatus = result.status;
    target.lastCheckedAt = nowIso();
    target.lastHealthDetail = result.detail;
    target.updatedAt = nowIso();
    this.recordAudit({
      type: 'private_access_target_health_checked',
      actor,
      summary: `Private access target ${target.label} checked`,
      status: result.status === 'reachable' ? 'passed' : 'failed',
      evidence: { targetId: target.id, url, httpStatus: result.httpStatus },
    });
    await this.persist();
    return { target: clone(target), result };
  }

  async setupPlan(input = {}) {
    await this.ensureLoaded();
    return buildSetupPlan(input);
  }

  tailnetState(fakeState = null) {
    return detectTailnetState({ fakeState, runner: this.runner });
  }
}

export {
  ACCESS_MODES,
  DEFAULT_SETTINGS,
  PrivateAccessStore,
  buildSetupPlan,
  detectTailnetState,
  fakeTailnetState,
  validateAccessUrl,
};
