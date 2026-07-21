// Private-access persistent store. Extracted from private-access.js.

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  readJsonFileWithRecovery,
  writeJsonFileAtomic,
} from '../state-store.js';
import {
  clone,
  nowIso,
  normalizeSettings,
  normalizeTarget,
  targetUrlForMode,
  DEFAULT_SETTINGS,
  MAX_PRIVATE_ACCESS_TARGETS,
} from './validation.js';
import {
  buildSetupPlan,
  detectTailnetState,
  boundedHealthCheck,
} from './tailnet.js';

export class PrivateAccessStore {
  constructor({ stateFile = null, runner = spawnSync } = {}) {
    this.stateFile = stateFile || path.join(process.cwd(), '.orca', 'private-access.json');
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
        targets: Array.isArray(parsed.targets) ? parsed.targets.map((target) => normalizeTarget(target)).slice(0, MAX_PRIVATE_ACCESS_TARGETS) : [],
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
    let setupPlan;
    try {
      setupPlan = buildSetupPlan({ localUrl: origin ? `${origin}` : undefined });
    } catch {
      // A remote/tailnet request origin is not the local service target. Keep the
      // status route readable and fall back to the localhost setup target.
      setupPlan = buildSetupPlan();
    }
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
        funnel: 'Tailscale Funnel is not supported — Orca only uses private tailnet Serve.',
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
    if (this.state.targets.length >= MAX_PRIVATE_ACCESS_TARGETS) {
      throw { status: 409, message: `Private access target limit reached (${MAX_PRIVATE_ACCESS_TARGETS}). Delete an old target before adding another.` };
    }
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

  tailnetState(fakeState = null, { localPort = process.env.PORT || 3000, forceRefresh = false } = {}) {
    return detectTailnetState({ fakeState, runner: this.runner, localPort, forceRefresh });
  }

  // Read-only accessor for the workstation's MagicDNS `.ts.net` name (from
  // `tailscale status` Self.DNSName). Returns '' when Tailscale is missing or not
  // logged in. Never triggers a Serve or outbound-network action — status only.
  // Wire this to the registry (e.g. registry.magicDnsResolver = () =>
  // store.magicDnsName()) so dev-server quick links can auto-fill their tailnet URL.
  magicDnsName(fakeState = null) {
    const state = this.tailnetState(fakeState);
    return state?.hostname ? String(state.hostname).replace(/\.$/, '') : '';
  }

  // Run Tailscale Serve for the user (HTTP, tailnet-only) so a phone can reach Orca
  // without copy-pasting commands. `action: 'enable'` runs `tailscale serve --bg
  // http://127.0.0.1:<port>`; `'disable'` runs `tailscale serve reset`. Returns the
  // result + freshly-detected tailnet state. Never enables Funnel.
  async configureServe({ action = 'enable', port = 3000 } = {}) {
    await this.ensureLoaded();
    const tailnet = this.tailnetState();
    if (!tailnet.binaryAvailable) {
      return { ok: false, action, error: 'Tailscale is not installed. Install it and sign in first.', tailnet };
    }
    if (!tailnet.loggedIn) {
      return { ok: false, action, error: 'Tailscale is not signed in. Sign in first, then try again.', tailnet };
    }
    const safePort = Number.parseInt(port, 10);
    const targetPort = Number.isInteger(safePort) && safePort > 0 ? safePort : 3000;
    const args = action === 'disable'
      ? ['serve', 'reset']
      : ['serve', '--bg', `http://127.0.0.1:${targetPort}`];
    const result = this.runner('tailscale', args, { encoding: 'utf8', timeout: 9000, maxBuffer: 128 * 1024, windowsHide: true });
    const ok = !result.error && result.status === 0;
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim().slice(0, 600);
    this.recordAudit({
      type: 'tailscale_serve_configured',
      actor: 'dashboard',
      status: ok ? 'passed' : 'failed',
      summary: `Tailscale Serve ${action} ${ok ? 'succeeded' : 'failed'}`,
      evidence: { action, exitCode: result.status ?? null },
    });
    await this.persist();
    return {
      ok,
      action,
      error: ok ? null : (output || 'Tailscale Serve command failed. You may need to grant the Tailscale operator (run `sudo tailscale set --operator=$USER` once).'),
      output,
      tailnet: this.tailnetState(null, { localPort: targetPort, forceRefresh: true }),
    };
  }
}
