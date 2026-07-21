// Credential reference resolution (memory/env/OS keychain). Extracted from
// provider-profiles.js.

import { spawnSync } from 'node:child_process';
import { SECRET_SERVICE, CREDENTIAL_BACKENDS } from './constants.js';
import { normalizeSecretRef, normalizeEnvName } from './validation.js';

export class CredentialStore {
  constructor({
    backend = process.env.ORCA_CREDENTIAL_BACKEND || 'auto',
    runner = spawnSync,
    platform = process.platform,
    env = process.env,
    service = SECRET_SERVICE,
  } = {}) {
    this.backend = CREDENTIAL_BACKENDS.has(backend) ? backend : 'auto';
    this.runner = runner;
    this.platform = platform;
    this.env = env;
    this.service = service;
    this.memory = new Map();
  }

  activeBackend() {
    if (this.backend === 'memory') return 'memory';
    if (this.backend === 'env') return 'env';
    if (this.backend === 'macos-keychain') return 'macos-keychain';
    if (this.backend === 'windows-credential-manager') return 'windows-credential-manager';
    if (this.backend === 'linux-secret-service') return 'linux-secret-service';
    if (this.backend === 'auto' && this.platform === 'darwin') return 'macos-keychain';
    return 'env';
  }

  backendStatuses() {
    const active = this.activeBackend();
    return [
      {
        id: 'memory',
        active: active === 'memory',
        available: true,
        writable: active === 'memory',
        persistence: 'process-memory',
        status: active === 'memory' ? 'active' : 'available_for_tests',
        blockedReason: null,
      },
      {
        id: 'env',
        active: active === 'env',
        available: true,
        writable: false,
        persistence: 'environment',
        status: active === 'env' ? 'active_fallback' : 'fallback_available',
        blockedReason: 'Environment variables are read-only from Orca and are never written by dashboard secret entry.',
      },
      {
        id: 'macos-keychain',
        active: active === 'macos-keychain',
        available: this.platform === 'darwin',
        writable: this.platform === 'darwin',
        persistence: 'os-credential-store',
        status: this.platform === 'darwin' ? (active === 'macos-keychain' ? 'active' : 'available') : 'blocked_on_this_host',
        blockedReason: this.platform === 'darwin' ? null : 'macOS Keychain is available only on darwin hosts.',
      },
      {
        id: 'windows-credential-manager',
        active: active === 'windows-credential-manager',
        available: false,
        writable: false,
        persistence: 'os-credential-store',
        status: this.platform === 'win32' ? 'blocked_adapter_not_implemented' : 'blocked_on_this_host',
        blockedReason: 'Windows Credential Manager adapter is not implemented in this Node runtime; use env fallback or a future OS adapter.',
      },
      {
        id: 'linux-secret-service',
        active: active === 'linux-secret-service',
        available: false,
        writable: false,
        persistence: 'os-credential-store',
        status: this.platform === 'linux' ? 'blocked_adapter_not_implemented' : 'blocked_on_this_host',
        blockedReason: 'Linux Secret Service/libsecret adapter is not implemented in this Node runtime; use env fallback or a future OS adapter.',
      },
    ];
  }

  runMacosSecurity(args, { timeout = 4000 } = {}) {
    const result = this.runner('security', args, {
      encoding: 'utf8',
      timeout,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    }) || {};
    return {
      status: Number.isInteger(result.status) ? result.status : null,
      stdout: String(result.stdout || ''),
      errorCode: result.error?.code || null,
    };
  }

  async describe(ref, envName = null) {
    const normalizedRef = ref ? normalizeSecretRef(ref, { allowBlank: false }) : null;
    const normalizedEnv = envName ? normalizeEnvName(envName, { allowBlank: false }) : null;
    const envPresent = normalizedEnv ? typeof this.env[normalizedEnv] === 'string' && this.env[normalizedEnv].length > 0 : false;
    const backend = this.activeBackend();
    if (backend === 'memory') {
      return {
        present: Boolean(normalizedRef && this.memory.has(normalizedRef)) || envPresent,
        backend: normalizedRef && this.memory.has(normalizedRef) ? 'memory' : (envPresent ? 'env' : 'memory'),
        ref: normalizedRef,
        envName: normalizedEnv,
        envFallbackPresent: envPresent,
      };
    }
    if (backend === 'macos-keychain' && normalizedRef) {
      const result = this.runMacosSecurity(['find-generic-password', '-s', this.service, '-a', normalizedRef], { timeout: 2000 });
      if (result.status === 0) {
        return { present: true, backend: 'macos-keychain', ref: normalizedRef, envName: normalizedEnv, envFallbackPresent: envPresent };
      }
    }
    return {
      present: envPresent,
      backend: envPresent ? 'env' : backend,
      ref: normalizedRef,
      envName: normalizedEnv,
      envFallbackPresent: envPresent,
    };
  }

  async get(ref, envName = null) {
    const normalizedRef = ref ? normalizeSecretRef(ref, { allowBlank: false }) : null;
    const normalizedEnv = envName ? normalizeEnvName(envName, { allowBlank: false }) : null;
    const backend = this.activeBackend();
    if (backend === 'memory' && this.memory.has(normalizedRef)) return this.memory.get(normalizedRef);
    if (backend === 'macos-keychain' && normalizedRef) {
      const result = this.runMacosSecurity(['find-generic-password', '-s', this.service, '-a', normalizedRef, '-w'], { timeout: 2000 });
      if (result.status === 0 && result.stdout) return String(result.stdout).trim();
    }
    if (normalizedEnv && typeof this.env[normalizedEnv] === 'string') return this.env[normalizedEnv];
    return null;
  }

  async has(ref, envName = null) {
    const description = await this.describe(ref, envName);
    return Boolean(description.present);
  }

  async set(ref, value) {
    const normalizedRef = normalizeSecretRef(ref, { allowBlank: false });
    const secret = String(value || '');
    if (!secret) throw { status: 422, message: 'Secret value is required.' };
    const backend = this.activeBackend();
    if (backend === 'memory') {
      this.memory.set(normalizedRef, secret);
      return this.describe(normalizedRef);
    }
    if (backend === 'macos-keychain') {
      const result = this.runMacosSecurity(['add-generic-password', '-U', '-s', this.service, '-a', normalizedRef, '-w', secret], { timeout: 4000 });
      if (result.status !== 0) throw { status: 500, message: 'Could not store secret in macOS Keychain.' };
      return this.describe(normalizedRef);
    }
    throw { status: 409, message: 'No writable OS credential backend is available. Configure an env var fallback or enable a supported credential backend.' };
  }

  async delete(ref) {
    const normalizedRef = normalizeSecretRef(ref, { allowBlank: false });
    const backend = this.activeBackend();
    if (backend === 'memory') {
      this.memory.delete(normalizedRef);
      return { deleted: true, backend: 'memory', ref: normalizedRef };
    }
    if (backend === 'macos-keychain') {
      const result = this.runMacosSecurity(['delete-generic-password', '-s', this.service, '-a', normalizedRef], { timeout: 4000 });
      return {
        deleted: result.status === 0,
        backend: 'macos-keychain',
        ref: normalizedRef,
        status: result.status === 0 ? 'deleted' : 'not_found_or_unavailable',
      };
    }
    return { deleted: false, backend, ref: normalizedRef, status: 'not_writable' };
  }
}

