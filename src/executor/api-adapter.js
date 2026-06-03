// API executor adapter (OpenAI-compatible/Gemini providers). Extracted from
// executor-factory.js.

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { validateNetworkUrl } from '../url-policy.js';
import { CredentialStore, defaultProfiles } from '../provider-profiles.js';
import { noopAsync, API_RESPONSE_BYTES } from './constants.js';
import { safeFire } from './sanitize.js';
import {
  getApiProviderProfile, applyApiProviderEnvOverrides, apiEndpointForProfile,
  safeGeminiModel, buildApiRequestBody, modelForProfile, providerEnvPrefix,
  redactedText, trimForLog,
} from './api-support.js';

export class ApiExecutorAdapter {
  constructor(label, options = {}) {
    this.label = label;
    this.profile = options.profile || getApiProviderProfile(label);
    this.credentialStore = options.credentialStore || new CredentialStore();
    this.providerProfileStore = options.providerProfileStore || null;
    this.onLog = options.onLog || noopAsync;
    this.onComplete = options.onComplete || noopAsync;
    this.onFail = options.onFail || noopAsync;
    this.onStop = options.onStop || noopAsync;
    this.runtimes = new Map();
  }

  async _resolveProfile() {
    const requested = String(this.label || '').toLowerCase().trim();
    const providerId = requested === 'api' ? 'openai-compatible' : requested;
    const seeded = defaultProfiles()[providerId];
    let profile = this.profile || (seeded ? { ...seeded, id: providerId, type: requested } : null);
    if (this.providerProfileStore && providerId) {
      try {
        const stored = await this.providerProfileStore.getProfile(providerId);
        if (stored?.kind === 'api') {
          profile = { ...(seeded || {}), ...(profile || {}), ...stored, id: providerId, type: requested };
        }
      } catch {
        // Fall back to static/env profile. Missing custom profiles fail below.
      }
    }
    return applyApiProviderEnvOverrides(profile, requested);
  }

  async _credential() {
    const envName = this.profile?.apiKeyEnv;
    const secretRef = this.profile?.secretRef;
    const secret = await this.credentialStore.get(secretRef, envName);
    let description = null;
    try {
      description = await this.credentialStore.describe(secretRef, envName);
    } catch {
      description = null;
    }
    return {
      envName,
      secretRef,
      secret: secret || '',
      backend: description?.backend || this.credentialStore.activeBackend(),
    };
  }

  _validatedEndpoint() {
    if (!this.profile) throw new Error('API provider profile is not configured.');
    const endpoint = this.profile.apiStyle === 'gemini'
      ? `${String(this.profile.baseUrl || '').replace(/\/+$/, '')}/models/${safeGeminiModel(this.currentLane || {}, this.profile)}:generateContent`
      : apiEndpointForProfile(this.profile);
    if (!endpoint) throw new Error('API provider endpoint could not be built.');
    return validateNetworkUrl(endpoint, {
      field: 'providerBaseUrl',
      allowedHosts: ['loopback', 'tailnet', 'public'],
      allowPublic: true,
      allowSensitive: true,
    }).url;
  }

  async start(lane) {
    if (!lane || !lane.id) {
      return {
        accepted: false,
        reason: 'Missing lane reference.',
      };
    }
    try {
      this.profile = await this._resolveProfile();
      this.currentLane = lane;
      const endpoint = this._validatedEndpoint();
      const credential = await this._credential();
      if (!credential.secret) {
        return {
          accepted: false,
          reason: `API provider ${this.profile.id} is missing required credential ${credential.secretRef || 'secretRef'} or env secret ${credential.envName}.`,
        };
      }
      const runtimeDir = path.join(process.cwd(), 'artifacts', String(lane.sessionId || 'orphan'), String(lane.id));
      await fs.mkdir(runtimeDir, { recursive: true });
      lane.artifactPath = `/artifacts/${lane.sessionId || 'orphan'}/${lane.id}`;
      const controller = new AbortController();
      const now = Date.now();
      const runtime = {
        runtimeId: randomUUID(),
        lane,
        status: 'active',
        startedAt: now,
        heartbeatAt: now,
        controller,
        endpoint,
      };
      this.runtimes.set(String(lane.id), runtime);
      lane.processMeta = {
        pid: null,
        pgid: null,
        binary: null,
        args: [],
        cwd: lane.workdir || process.cwd(),
        envPolicy: 'secret-env-ref',
        providerId: this.profile.id,
        providerType: this.label,
        apiStyle: this.profile.apiStyle,
        secretRef: credential.secretRef,
        apiKeyEnv: credential.envName,
        credentialBackend: credential.backend,
        endpointHost: new URL(endpoint).host,
        endpointPath: new URL(endpoint).pathname,
        startedAt: new Date(now).toISOString(),
        endedAt: null,
        exitCode: null,
        signal: null,
        stopRequestedBy: null,
        stopResult: null,
        platform: process.platform,
        processGroupSupported: false,
      };
      await safeFire(this.onLog, lane, `${this.label} API adapter queued request to ${lane.processMeta.endpointHost}${lane.processMeta.endpointPath}`);
      setTimeout(() => {
        this._execute(lane, runtime, credential.secret).catch((error) => {
          if (runtime.status !== 'active') return;
          runtime.status = 'failed';
          this.runtimes.delete(String(lane.id));
          if (lane.processMeta) {
            lane.processMeta.endedAt = new Date().toISOString();
            lane.processMeta.exitCode = 1;
          }
          safeFire(this.onFail, lane, redactedText(error.message || 'API provider execution failed.', [credential.secret]), 'scheduler');
        });
      }, 0).unref?.();
      return { accepted: true, runtime };
    } catch (error) {
      return {
        accepted: false,
        reason: `Failed to launch API provider ${this.label}: ${error.message}`,
      };
    }
  }

  async _execute(lane, runtime, secret) {
    const body = buildApiRequestBody(lane, this.profile);
    const headers = {
      'content-type': 'application/json',
    };
    if (this.profile.apiStyle === 'gemini') {
      headers['x-goog-api-key'] = secret;
    } else {
      headers.authorization = `Bearer ${secret}`;
    }
    const timeout = setTimeout(() => runtime.controller.abort(), this.profile.timeoutMs || 30000);
    let responseText = '';
    try {
      const response = await fetch(runtime.endpoint, {
        method: 'POST',
        signal: runtime.controller.signal,
        headers,
        body: JSON.stringify(body),
        // The endpoint passed the SSRF/url-policy check, but a 3xx redirect could
        // bounce the request to an internal address the policy would have blocked.
        // Refuse to follow redirects so the validated endpoint is the only target.
        redirect: 'error',
      });
      responseText = await response.text();
      if (responseText.length > (this.profile.maxResponseBytes || API_RESPONSE_BYTES)) {
        throw new Error('API provider response exceeded configured size cap.');
      }
      if (runtime.status !== 'active') return;
      if (!response.ok) {
        throw new Error(`API provider returned HTTP ${response.status}: ${trimForLog(redactedText(responseText, [secret]), 1000)}`);
      }
      let parsed = null;
      try {
        parsed = responseText ? JSON.parse(responseText) : null;
      } catch {
        parsed = null;
      }
      const content = parsed?.choices?.[0]?.message?.content
        || parsed?.candidates?.[0]?.content?.parts?.[0]?.text
        || parsed?.output_text
        || responseText;
      lane.apiProviderResult = {
        providerId: this.profile.id,
        apiStyle: this.profile.apiStyle,
        model: this.profile.apiStyle === 'gemini' ? safeGeminiModel(lane, this.profile) : body.model,
        status: response.status,
        receivedAt: new Date().toISOString(),
        outputPreview: trimForLog(redactedText(content, [secret]), 2000),
        usage: parsed?.usage || parsed?.usageMetadata || null,
      };
      lane.apiResponse = lane.apiProviderResult;
      if (lane.processMeta) {
        lane.processMeta.endedAt = new Date().toISOString();
        lane.processMeta.exitCode = 0;
        lane.processMeta.httpStatus = response.status;
        lane.processMeta.responseBytes = responseText.length;
      }
      runtime.status = 'done';
      this.runtimes.delete(String(lane.id));
      await safeFire(this.onLog, lane, `${this.label} API provider completed with HTTP ${response.status}`);
      await safeFire(this.onComplete, lane, `${this.label} API provider completed`);
    } catch (error) {
      if (runtime.status !== 'active') return;
      runtime.status = 'failed';
      this.runtimes.delete(String(lane.id));
      if (lane.processMeta) {
        lane.processMeta.endedAt = new Date().toISOString();
        lane.processMeta.exitCode = 1;
      }
      const message = error?.name === 'AbortError'
        ? `${this.label} API provider request aborted or timed out`
        : `${this.label} API provider failed: ${redactedText(error.message || error, [secret])}`;
      await safeFire(this.onFail, lane, message, 'scheduler');
    } finally {
      clearTimeout(timeout);
    }
  }

  async stop(laneId, context = {}) {
    const laneKey = String(laneId);
    const runtime = this.runtimes.get(laneKey);
    if (!runtime) {
      return {
        stopped: false,
        reason: `No active API request found for lane ${laneKey}.`,
      };
    }
    runtime.status = 'stopping';
    this.runtimes.delete(laneKey);
    runtime.controller.abort();
    if (runtime.lane?.processMeta) {
      runtime.lane.processMeta.endedAt = runtime.lane.processMeta.endedAt || new Date().toISOString();
      runtime.lane.processMeta.stopRequestedBy = context.actor || 'dashboard';
      runtime.lane.processMeta.stopResult = 'abort_controller';
    }
    await safeFire(this.onStop, runtime.lane, {
      actor: context.actor || 'dashboard',
      reason: context.reason || `${this.label} API request stop requested`,
    });
    return {
      stopped: true,
      reason: 'API request abort signal sent.',
      processGroupSupported: false,
    };
  }

  touchHeartbeat(laneId, actor = 'adapter') {
    const runtime = this.runtimes.get(String(laneId));
    if (!runtime || runtime.status !== 'active') return false;
    runtime.heartbeatAt = Date.now();
    safeFire(this.onLog, runtime.lane, `[${this.label}] heartbeat from ${actor}`);
    return true;
  }

  async tick() {}

  getRunningCountForSession(sessionId) {
    const want = String(sessionId);
    let count = 0;
    for (const runtime of this.runtimes.values()) {
      if (runtime.status === 'active' && String(runtime.lane.sessionId) === want) count += 1;
    }
    return count;
  }
}
