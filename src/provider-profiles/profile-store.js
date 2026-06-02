// Provider profile persistence + lifecycle. Extracted from provider-profiles.js.

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJsonFileWithRecovery, writeJsonFileAtomic } from '../state-store.js';
import { nowIso, clone, PROVIDER_IDS } from './constants.js';
import { safeSlug, ensurePlainObject, normalizeProfile } from './validation.js';
import { defaultProfiles } from './profile-factory.js';
import { CredentialStore } from './credential-store.js';

export class ProviderProfileStore {
  constructor({ stateFile = null, credentialStore = null } = {}) {
    this.stateFile = stateFile || path.join(process.cwd(), '.orca', 'providers.json');
    this.credentialStore = credentialStore || new CredentialStore();
    this.loaded = false;
    this.loadStatus = null;
    this.state = {
      schemaVersion: 1,
      profiles: defaultProfiles(),
      auditEvents: [],
    };
  }

  async ensureLoaded() {
    if (this.loaded) return;
    this.loaded = true;
    const fallback = {
      schemaVersion: 1,
      profiles: defaultProfiles(),
      auditEvents: [],
    };
    try {
      const recovered = await readJsonFileWithRecovery(this.stateFile, { fallback });
      this.loadStatus = recovered.status;
      const parsed = recovered.data || fallback;
      const shouldAuditRecovery = this.loadStatus?.recovered || this.loadStatus?.ok === false;
      const seeded = defaultProfiles();
      const loaded = parsed.profiles && typeof parsed.profiles === 'object' ? parsed.profiles : {};
      const profiles = { ...seeded };
      for (const [id, raw] of Object.entries(loaded)) {
        const base = profiles[id] || null;
        profiles[id] = normalizeProfile({ ...base, ...raw, id: raw.id || id }, base);
      }
      this.state = {
        schemaVersion: 1,
        profiles,
        auditEvents: Array.isArray(parsed.auditEvents) ? parsed.auditEvents.slice(0, 200) : [],
      };
      if (shouldAuditRecovery) {
        this.recordAudit({
          type: 'provider_state_recovered',
          actor: 'system',
          summary: `Provider profile state loaded from ${this.loadStatus.source}`,
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
    await writeJsonFileAtomic(this.stateFile, { ...this.state, savedAt: nowIso() });
  }

  recordAudit(event) {
    this.state.auditEvents.unshift({ id: randomUUID(), createdAt: nowIso(), ...event });
    this.state.auditEvents = this.state.auditEvents.slice(0, 200);
  }

  async listProfiles() {
    await this.ensureLoaded();
    const profiles = await Promise.all(Object.values(this.state.profiles).map(async (profile) => ({
      ...clone(profile),
      credential: await this.credentialStore.describe(profile.secretRef, profile.apiKeyEnv),
    })));
    profiles.sort((a, b) => {
      const ai = PROVIDER_IDS.indexOf(a.id);
      const bi = PROVIDER_IDS.indexOf(b.id);
      if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
      return a.id.localeCompare(b.id);
    });
    return {
      schemaVersion: 1,
      generatedAt: nowIso(),
      credentialBackend: this.credentialStore.activeBackend(),
      credentialBackends: this.credentialStore.backendStatuses(),
      loadStatus: this.loadStatus ? clone(this.loadStatus) : null,
      profiles,
    };
  }

  async getProfile(id) {
    await this.ensureLoaded();
    const profile = this.state.profiles[safeSlug(id)];
    if (!profile) throw { status: 404, message: 'Provider profile not found.' };
    return clone(profile);
  }

  async updateProfile(id, raw, { actor = 'dashboard', approved = false } = {}) {
    await this.ensureLoaded();
    if (!approved) throw { status: 409, message: 'Provider profile changes require explicit approval.', requiresApproval: true, risk: 'high' };
    const profileId = safeSlug(id);
    const existing = this.state.profiles[profileId] || { id: profileId };
    const normalized = normalizeProfile({ ...existing, ...raw, id: profileId }, existing);
    this.state.profiles[profileId] = normalized;
    this.recordAudit({
      type: 'provider_profile_updated',
      actor,
      summary: `Provider profile ${profileId} updated`,
      status: 'passed',
      evidence: { providerId: profileId, enabled: normalized.enabled, kind: normalized.kind },
    });
    await this.persist();
    return clone(normalized);
  }

  async health(id) {
    const profile = await this.getProfile(id);
    if (['codex', 'claude', 'cli'].includes(profile.kind)) {
      const binary = profile.binary || profile.id;
      const result = spawnSync(binary, ['--version'], {
        encoding: 'utf8',
        timeout: 2500,
        maxBuffer: 64 * 1024,
        windowsHide: true,
      });
      return {
        providerId: profile.id,
        kind: profile.kind,
        status: result.status === 0 ? 'ready' : (profile.enabled ? 'blocked' : 'disabled'),
        enabled: profile.enabled,
        binary,
        version: result.status === 0 ? String(result.stdout || result.stderr || '').trim() : null,
        exitCode: result.status,
        errorCode: result.error?.code || null,
        installPolicy: profile.installPolicy,
        updatePolicy: profile.updatePolicy,
        dryRunOnly: true,
      };
    }
    const credential = await this.credentialStore.describe(profile.secretRef, profile.apiKeyEnv);
    return {
      providerId: profile.id,
      kind: profile.kind,
      status: credential.present ? 'configured' : (profile.enabled ? 'missing_secret' : 'disabled'),
      enabled: profile.enabled,
      baseUrl: profile.baseUrl,
      apiStyle: profile.apiStyle,
      credential,
      installPolicy: profile.installPolicy,
      updatePolicy: profile.updatePolicy,
      networkProbe: 'not-run-by-default',
    };
  }

  async setSecret(id, value, { actor = 'dashboard', approved = false } = {}) {
    await this.ensureLoaded();
    if (!approved) throw { status: 409, message: 'Secret writes require explicit approval.', requiresApproval: true, risk: 'high' };
    const profile = await this.getProfile(id);
    if (!profile.secretRef) throw { status: 422, message: 'Provider profile has no secretRef.' };
    const credential = await this.credentialStore.set(profile.secretRef, value);
    this.recordAudit({
      type: 'provider_secret_set',
      actor,
      summary: `Secret stored for provider ${profile.id}`,
      status: 'passed',
      evidence: { providerId: profile.id, secretRef: profile.secretRef, backend: credential.backend },
    });
    await this.persist();
    return { providerId: profile.id, credential };
  }

  async deleteSecret(id, { actor = 'dashboard', approved = false } = {}) {
    await this.ensureLoaded();
    if (!approved) throw { status: 409, message: 'Secret deletion requires explicit approval.', requiresApproval: true, risk: 'high' };
    const profile = await this.getProfile(id);
    if (!profile.secretRef) throw { status: 422, message: 'Provider profile has no secretRef.' };
    const credential = await this.credentialStore.delete(profile.secretRef);
    this.recordAudit({
      type: 'provider_secret_deleted',
      actor,
      summary: `Secret deleted for provider ${profile.id}`,
      status: 'passed',
      evidence: { providerId: profile.id, secretRef: profile.secretRef, backend: credential.backend },
    });
    await this.persist();
    return {
      providerId: profile.id,
      credential,
      fallback: profile.apiKeyEnv ? await this.credentialStore.describe(profile.secretRef, profile.apiKeyEnv) : null,
    };
  }

  async exportProfiles() {
    await this.ensureLoaded();
    return {
      schemaVersion: 1,
      exportedAt: nowIso(),
      profiles: Object.values(this.state.profiles).map((profile) => clone(profile)),
      excludesSecrets: true,
    };
  }

  validateImport(payload) {
    ensurePlainObject(payload, 'import');
    if (payload.schemaVersion !== 1) throw { status: 422, message: 'Unsupported provider import schemaVersion.' };
    if (!Array.isArray(payload.profiles)) throw { status: 422, message: 'Provider import requires a profiles array.' };
    const accepted = [];
    const errors = [];
    for (const raw of payload.profiles) {
      try {
        ensurePlainObject(raw, 'profile');
        if (raw.secretValue || raw.apiKey || raw.token) throw { status: 422, message: 'Provider imports must not include secret values.' };
        const id = safeSlug(raw.id);
        accepted.push(normalizeProfile(raw, this.state.profiles[id] || null));
      } catch (error) {
        errors.push(error.message || 'Invalid provider profile.');
      }
    }
    return {
      acceptedCount: accepted.length,
      errorCount: errors.length,
      errors,
      profiles: accepted.map((profile) => ({
        id: profile.id,
        displayName: profile.displayName,
        kind: profile.kind,
        enabled: profile.enabled,
        secretRef: profile.secretRef,
        apiKeyEnv: profile.apiKeyEnv,
      })),
      dryRun: true,
    };
  }

  async importDryRun(payload) {
    await this.ensureLoaded();
    return this.validateImport(payload);
  }

  async importApply(payload, { actor = 'dashboard', approved = false } = {}) {
    await this.ensureLoaded();
    if (!approved) throw { status: 409, message: 'Provider import requires explicit approval.', requiresApproval: true, risk: 'high' };
    const dryRun = this.validateImport(payload);
    if (dryRun.errorCount > 0) throw { status: 422, message: 'Provider import contains invalid profiles.', errors: dryRun.errors };
    for (const profileSummary of dryRun.profiles) {
      const raw = payload.profiles.find((item) => safeSlug(item.id) === profileSummary.id);
      this.state.profiles[profileSummary.id] = normalizeProfile(raw, this.state.profiles[profileSummary.id] || null);
    }
    this.recordAudit({
      type: 'provider_profiles_imported',
      actor,
      summary: `Imported ${dryRun.acceptedCount} provider profile(s)`,
      status: 'passed',
      evidence: { acceptedCount: dryRun.acceptedCount },
    });
    await this.persist();
    return { ...dryRun, dryRun: false };
  }
}

