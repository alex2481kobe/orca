// API executor adapter (OpenAI-compatible/Gemini providers). Extracted from
// executor-factory.js.

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { validateNetworkUrl, publicHostResolvesSafely } from '../url-policy.js';
import { CredentialStore, defaultProfiles } from '../provider-profiles.js';
import { noopAsync, API_RESPONSE_BYTES } from './constants.js';
import { safeFire } from './sanitize.js';
import {
  getApiProviderProfile,
  applyApiProviderEnvOverrides,
  apiEndpointForProfile,
  safeGeminiModel,
  buildApiRequestBody,
  redactedText,
  trimForLog,
} from './api-support.js';

export class ApiExecutorAdapter {
  constructor(label, options = {}) {
    this.label = label;
    this.profile = options.profile || getApiProviderProfile(label);
    this.credentialStore = options.credentialStore || new CredentialStore();
    this.providerProfileStore = options.providerProfileStore || null;
    this.onLog = options.onLog || noopAsync;
    this.onAgentEvent = options.onAgentEvent || noopAsync;
    this.onComplete = options.onComplete || noopAsync;
    this.onFail = options.onFail || noopAsync;
    this.onStop = options.onStop || noopAsync;
    // Backstop the per-request fetch timeout: if a runtime is somehow left active
    // without completing (e.g. an unexpected throw outside the guarded fetch block),
    // the scheduler counts it as a running lane forever, permanently consuming a
    // capacity slot. tick() reaps anything silent past this window.
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs
      || Number.parseInt(process.env.ORCA_API_HEARTBEAT_TIMEOUT_MS, 10)
      || 10 * 60 * 1000;
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

  async _credential(profile = this.profile) {
    const envName = profile?.apiKeyEnv;
    const secretRef = profile?.secretRef;
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

  _validatedEndpoint(profile = this.profile, lane = this.currentLane) {
    if (!profile) throw new Error('API provider profile is not configured.');
    const endpoint = profile.apiStyle === 'gemini'
      ? `${String(profile.baseUrl || '').replace(/\/+$/, '')}/models/${safeGeminiModel(lane || {}, profile)}:generateContent`
      : apiEndpointForProfile(profile);
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
      // Resolve into a per-call local — this adapter instance is shared across
      // every lane of its executor type, so writing this.profile/this.currentLane
      // and reading them back at later await points would let a concurrent lane's
      // start() overwrite this lane's config. Keep all per-lane state on `runtime`.
      const profile = await this._resolveProfile();
      this.profile = profile; // best-effort for any single-lane external reader
      const endpoint = this._validatedEndpoint(profile, lane);
      // DNS-rebinding guard: validateNetworkUrl trusts the hostname string, so a
      // public provider name resolving to an internal IP (169.254.169.254, 10.x,
      // 127.0.0.1) would pass. Re-check resolved addresses (no-op for loopback/
      // tailnet hosts). Redirects are already blocked (redirect:'error').
      if (!(await publicHostResolvesSafely(new URL(endpoint).hostname))) {
        return { accepted: false, reason: `API provider endpoint host ${new URL(endpoint).hostname} resolves to a non-public (internal) address.` };
      }
      const credential = await this._credential(profile);
      if (!credential.secret) {
        return {
          accepted: false,
          reason: `API provider ${profile.id} is missing required credential ${credential.secretRef || 'secretRef'} or env secret ${credential.envName}.`,
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
        profile,
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
        providerId: profile.id,
        providerType: this.label,
        apiStyle: profile.apiStyle,
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
    // Read the per-lane profile off `runtime`, never this.profile — a concurrent
    // lane's start() may have overwritten the instance field by now.
    const profile = runtime.profile || this.profile;
    const body = buildApiRequestBody(lane, profile);
    const headers = {
      'content-type': 'application/json',
    };
    if (profile.apiStyle === 'gemini') {
      headers['x-goog-api-key'] = secret;
    } else {
      headers.authorization = `Bearer ${secret}`;
    }
    const timeout = setTimeout(() => runtime.controller.abort(), profile.timeoutMs || 30000);
    const maxResponseBytes = profile.maxResponseBytes || API_RESPONSE_BYTES;
    let responseText = '';
    let responseBytes = 0;
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
      // Stream the body and count BYTES as chunks arrive instead of buffering the
      // whole `response.text()` up front. An oversized or malicious provider
      // response would otherwise be fully materialized into memory before any
      // size check runs. The moment the running byte total exceeds the cap we
      // abort via the existing controller and fail the lane, so only bounded data
      // is ever held. Bytes are decoded to text only on success (below).
      const chunks = [];
      if (response.body) {
        const reader = response.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value || value.byteLength === 0) continue;
            responseBytes += value.byteLength;
            if (responseBytes > maxResponseBytes) {
              try { runtime.controller.abort(); } catch { /* already settled */ }
              try { await reader.cancel(); } catch { /* body already torn down */ }
              throw new Error('API provider response exceeded configured size cap.');
            }
            chunks.push(value);
          }
        } finally {
          try { reader.releaseLock(); } catch { /* reader already released */ }
        }
      }
      responseText = chunks.length ? Buffer.concat(chunks).toString('utf8') : '';
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
        providerId: profile.id,
        apiStyle: profile.apiStyle,
        model: profile.apiStyle === 'gemini' ? safeGeminiModel(lane, profile) : body.model,
        status: response.status,
        receivedAt: new Date().toISOString(),
        outputPreview: trimForLog(redactedText(content, [secret]), 2000),
        usage: parsed?.usage || parsed?.usageMetadata || null,
      };
      lane.apiResponse = lane.apiProviderResult;
      await safeFire(this.onAgentEvent, lane, {
        type: 'message.assistant.final',
        source: this.label,
        content: trimForLog(redactedText(content, [secret]), 12000),
        usage: lane.apiProviderResult.usage || undefined,
      });
      if (lane.processMeta) {
        lane.processMeta.endedAt = new Date().toISOString();
        lane.processMeta.exitCode = 0;
        lane.processMeta.httpStatus = response.status;
        lane.processMeta.responseBytes = responseBytes;
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

  async tick(now = Date.now()) {
    for (const [laneId, runtime] of this.runtimes.entries()) {
      if (runtime.status !== 'active') continue;
      if (now - runtime.heartbeatAt <= this.heartbeatTimeoutMs) continue;
      runtime.status = 'timed_out';
      try { runtime.controller.abort(); } catch { /* already settled */ }
      this.runtimes.delete(laneId);
      if (runtime.lane?.processMeta) {
        runtime.lane.processMeta.endedAt = runtime.lane.processMeta.endedAt || new Date(now).toISOString();
        runtime.lane.processMeta.exitCode = runtime.lane.processMeta.exitCode ?? 1;
      }
      await safeFire(this.onFail, runtime.lane, `${this.label} API provider heartbeat timeout`, 'heartbeat');
    }
  }

  getRunningCountForSession(sessionId) {
    const want = String(sessionId);
    let count = 0;
    for (const runtime of this.runtimes.values()) {
      if (runtime.status === 'active' && String(runtime.lane.sessionId) === want) count += 1;
    }
    return count;
  }

  // Mirror the CLI/mock adapters so stopAllExecutors (shutdown sweep) aborts any
  // in-flight API request and fires its terminal callback, instead of skipping
  // this adapter (its runtimes were silently abandoned on shutdown before).
  getActiveLaneIds() {
    return [...this.runtimes.entries()]
      .filter(([, runtime]) => runtime.status === 'active')
      .map(([laneId]) => laneId);
  }
}
