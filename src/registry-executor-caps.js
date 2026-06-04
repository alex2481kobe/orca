// Executor capability discovery + CLI info/reinstall methods, as a prototype
// mixin for OrcaRegistry. Extracted from registry.js. Owns the CLI capability
// cache (module-scoped, shared across instances — it's just a probe cache).

import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  planPlaywrightInstall,
  runCaptureInstall,
  describeCaptureStatus,
} from './capture-setup.js';
import {
  normalizeExecutorType,
  parseBooleanEnv,
  publicBinaryName,
  firstLine,
  safeArray,
  clonePayload,
  nowIso,
} from './registry-utils.js';
import { defaultPolicy } from './registry-policy.js';
import {
  getCliVersion,
  getCliHelp,
  helpHas,
  parseHelpChoices,
  parseEffortChoices,
  parseModelHints,
  compactCapabilities,
} from './registry-cli-info.js';
import {
  REINSTALL_COMMAND_TIMEOUT_MS,
  getReinstallCommand,
  normalizeReinstallCommand,
  getReinstallSourceCommand,
  getReinstallSourceRepos,
  shouldPreferSourceReinstall,
  commandTargetsExecutorFirstToken,
} from './registry-reinstall.js';

// Codex stores its default model + reasoning effort in ~/.codex/config.toml. Read
// them so the UI default matches the terminal (e.g. "gpt-5.5 high"). The full
// selectable model list lives in the codex binary (the /model picker) and isn't
// exposed non-interactively, so model entry stays free-text + this detected default.
function readCodexConfigDefault(key) {
  try {
    const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    const txt = readFileSync(path.join(home, 'config.toml'), 'utf8');
    const m = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, 'm').exec(txt);
    return m ? m[1].slice(0, 120) : null;
  } catch {
    return null;
  }
}

// Codex caches its real model catalog (the interactive /model picker list) in
// ~/.codex/models_cache.json — slug, display name, and per-model reasoning levels.
// Read it so the UI shows codex's actual selectable models dynamically.
function readCodexModelCatalog() {
  try {
    const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    const json = JSON.parse(readFileSync(path.join(home, 'models_cache.json'), 'utf8'));
    const models = Array.isArray(json.models) ? json.models : [];
    return models
      .filter((m) => m && m.slug && m.visibility !== 'hide')
      .slice(0, 32)
      .map((m) => ({
        slug: String(m.slug).slice(0, 120),
        name: String(m.display_name || m.slug).slice(0, 120),
        defaultEffort: m.default_reasoning_level ? String(m.default_reasoning_level).slice(0, 24) : null,
        efforts: Array.isArray(m.supported_reasoning_levels)
          ? m.supported_reasoning_levels.map((l) => l && l.effort).filter(Boolean).slice(0, 12)
          : [],
      }));
  } catch {
    return null;
  }
}
import {
  FIRST_CLASS_CLI_EXECUTOR_TYPES,
  getApiProviderExecutorTypes,
  getExecutorProfiles as getExecutorProfilesFromFactory,
  getExecutorProfile as getExecutorProfileFromFactory,
  getApiProviderProfile as getApiProviderProfileFromFactory,
} from './executor-factory.js';

const CLI_CAPABILITY_CACHE_MS = 30 * 1000;
const MAX_CLI_CAPABILITY_CACHE_ENTRIES = 50;
const cliCapabilityCache = new Map();

export const executorCapabilityMethods = {
  getSupportedExecutorTypes() {
    const supported = ['mock', ...FIRST_CLASS_CLI_EXECUTOR_TYPES, ...getApiProviderExecutorTypes()];
    if (getExecutorProfileFromFactory('cli')) {
      supported.push('cli');
    }
    return [...new Set(supported)];
  },

  async describeSystemBlockers() {
    const blockers = [];
    // Executor blockers
    for (const executorType of ['codex', 'claude']) {
      try {
        const info = this.getExecutorCliInfo(executorType);
        if (!info.binaryExists) {
          blockers.push({
            id: `executor-${executorType}-missing`,
            severity: 'error',
            area: 'executor',
            summary: `${executorType.toUpperCase()} CLI not executable`,
            detail: `Configured binary ${info.binary} could not be invoked (exitCode=${info.binaryExitCode || 'n/a'}).`,
            remediation: executorType === 'codex'
              ? 'Reinstall the Codex CLI: `brew reinstall --cask codex` OR `npm install -g @openai/codex`. Then restart Orca.'
              : 'Reinstall Claude Code: `brew install anthropic-ai/tap/claude` or follow the official installer. Then restart Orca.',
            approvalRequired: true,
          });
        } else if (!info.version) {
          blockers.push({
            id: `executor-${executorType}-version-unknown`,
            severity: 'warn',
            area: 'executor',
            summary: `${executorType.toUpperCase()} CLI version is unknown`,
            detail: `${info.binary} exists but did not return a version. Trust state cannot be verified.`,
            remediation: `Run \`${info.binary} --version\` manually and confirm output.`,
            approvalRequired: false,
          });
        }
      } catch (error) {
        blockers.push({
          id: `executor-${executorType}-error`,
          severity: 'error',
          area: 'executor',
          summary: `${executorType.toUpperCase()} CLI inspection failed`,
          detail: error?.message || 'unknown',
          remediation: 'Check Orca logs for the underlying error.',
          approvalRequired: false,
        });
      }
    }
    // Playwright blocker — await detection so we don't false-positive after install.
    const playwrightOk = await this.evidenceRunner.ensurePlaywrightDetected();
    if (!playwrightOk) {
      blockers.push({
        id: 'playwright-missing',
        severity: 'warn',
        area: 'evidence',
        summary: 'Playwright not installed; evidence capture is degraded',
        detail: 'Without Playwright, /api/lanes/:id/evidence returns captured=false and writes a JSON marker only. Screenshots, traces, and videos cannot be produced.',
        remediation: 'From the repo root, run: npm install --save-dev playwright && npx playwright install chromium',
        approvalRequired: true,
      });
    }
    return {
      generatedAt: nowIso(),
      blockers,
    };
  },

  getExecutorProfiles() {
    return clonePayload(getExecutorProfilesFromFactory());
  },

  getExecutorCapabilities(executorType) {
    const type = normalizeExecutorType(executorType);
    const supported = this.getSupportedExecutorTypes();
    if (!supported.includes(type)) {
      throw { status: 404, message: 'Unsupported executor type.' };
    }

    if (type === 'mock') {
      return compactCapabilities({
        type,
        displayName: 'Mock',
        kind: 'mock',
        binary: null,
        binaryExists: true,
        version: 'built-in',
        roles: ['orchestrator', 'executor', 'auditor', 'critique'],
        controls: {
          model: { supported: false, values: [] },
          permissions: { supported: true, values: ['plan', 'read-only', 'auto-edit'] },
          intelligence: { supported: true, values: ['low', 'medium', 'high', 'xhigh'], passthrough: true },
          structuredOutput: { supported: true, formats: ['mock-events'] },
          backgroundAgents: { supported: false },
        },
        invocation: {
          canRunAsOrchestrator: true,
          canRunAsExecutor: true,
          commandDerivedFromLane: true,
          customArgs: false,
        },
        mcpScopes: ['mock', 'all'],
        detection: { source: 'built-in', checkedAt: nowIso() },
      });
    }

    if (FIRST_CLASS_CLI_EXECUTOR_TYPES.includes(type) || type === 'cli') {
      const profile = getExecutorProfileFromFactory(type) || {};
      const binary = String(profile.defaultBinary || type);
      const cacheKey = `${type}:${binary}:${safeArray(profile.allowedModels).join(',')}`;
      const cached = cliCapabilityCache.get(cacheKey);
      if (cached && Date.now() - cached.cachedAt < CLI_CAPABILITY_CACHE_MS) {
        return clonePayload(cached.capabilities);
      }
      const versionInfo = getCliVersion(binary);
      const helpInfo = versionInfo.exists ? getCliHelp(binary, type) : { ok: false, text: '', exitCode: null };
      const helpText = helpInfo.text || '';
      const supportsModel = helpHas(helpText, /(?:^|\s)--model(?:\s|[=<])/m);
      const supportsMcpConfig = helpHas(helpText, /(?:^|\s)--mcp-config(?:\s|[=<])/m);
      const supportsOutputFormat = helpHas(helpText, /(?:^|\s)--output-format(?:\s|[=<])/m) || type === 'codex';
      const supportsPermissionMode = helpHas(helpText, /(?:^|\s)--permission-mode(?:\s|[=<])/m);
      const supportsApprovalMode = helpHas(helpText, /(?:^|\s)--approval-mode(?:\s|[=<])/m);
      const supportsEffort = helpHas(helpText, /(?:^|\s)--effort(?:\s|[=<])/m);
      // Model values: aliases/examples the CLI documents in --help (e.g. claude's
      // 'opus'/'sonnet'/'claude-opus-4-8') merged with any operator-configured
      // ORCA_<CLI>_MODELS. Free-text entry always remains available in the UI and
      // via the API, so any newer slug works even if not listed here.
      const modelHints = parseModelHints(helpText);
      const codexCatalog = type === 'codex' ? readCodexModelCatalog() : null;
      const catalogSlugs = codexCatalog ? codexCatalog.map((m) => m.slug) : [];
      const modelValues = [...new Set([...catalogSlugs, ...modelHints, ...safeArray(profile.allowedModels)])].slice(0, 32);
      const permissionChoices = parseHelpChoices(helpText, '--permission-mode');
      const outputChoices = parseHelpChoices(helpText, '--output-format');
      // Prefer an explicit "choices:" list; otherwise read the parenthesised
      // enumeration on the continuation line (claude prints "(low, …, max)").
      const effortChoices = parseHelpChoices(helpText, '--effort');
      const effortEnum = effortChoices.length ? effortChoices : parseEffortChoices(helpText);
      const permissionValues = permissionChoices.length
        ? permissionChoices
        : (type === 'codex'
          ? ['plan', 'read-only', 'auto-edit', 'bypass-permissions']
          : (supportsApprovalMode ? ['plan', 'read-only', 'auto-edit', 'bypass-permissions'] : ['plan', 'read-only', 'auto-edit', 'acceptEdits', 'bypassPermissions']));
      let intelligenceValues = supportsEffort
        ? (effortEnum.length ? effortEnum : ['low', 'medium', 'high', 'xhigh'])
        : ['low', 'medium', 'high', 'xhigh'];
      // Claude also exposes "ultracode" (xhigh effort + standing dynamic-workflow
      // orchestration): selectable in its interactive /effort menu and via the
      // `ultracode` session setting, but deliberately NOT a --effort flag value.
      // Surface it as the top reasoning tier — the command builder maps it to
      // `--settings '{"ultracode":true}'` instead of --effort.
      if (type === 'claude' && !intelligenceValues.includes('ultracode')) {
        intelligenceValues = [...intelligenceValues, 'ultracode'];
      }
      const backgroundAgents = type === 'claude' && (
        helpHas(helpText, /^\s*agents\s/m)
        || helpHas(helpText, /(?:^|\s)--agents(?:\s|[=<])/m)
        || helpHas(helpText, /(?:^|\s)--agent(?:\s|[=<])/m)
      );
      // Cloud capability detection. codex exposes a `cloud` subcommand (browse
      // Codex Cloud tasks) and claude exposes `ultrareview` (cloud-hosted review).
      // Neither is a non-interactive "run this prompt in the cloud", so the UI
      // surfaces Cloud per-CLI but keeps it non-runnable until that's wired.
      const cloudCommand = (type === 'codex' && helpHas(helpText, /^\s*cloud\s/m)) ? 'cloud'
        : ((type === 'claude' && helpHas(helpText, /^\s*ultrareview\s/m)) ? 'ultrareview' : null);
      // Speed / "fast mode": codex exposes the stable `fast_mode` feature
      // (-c features.fast_mode=true) and claude exposes a `fastMode` session
      // setting. Both map to the terminal's "/fast" (≈1.5x). Other CLIs have no
      // fast mode, so the Speed control is hidden for them.
      const supportsFast = type === 'codex' || type === 'claude';
      const attachable = type === 'claude' && helpHas(helpText, /^\s*attach\s/m);
      const stoppable = type === 'claude' && helpHas(helpText, /^\s*stop\s/m);
      const logs = type === 'claude' && helpHas(helpText, /^\s*logs\s/m);

      const capabilities = compactCapabilities({
        type,
        displayName: type === 'cli' ? 'Custom CLI' : type,
        kind: 'cli',
        binary: publicBinaryName(binary),
        binaryExists: Boolean(versionInfo.exists),
        version: firstLine(versionInfo.version),
        roles: ['orchestrator', 'executor', 'auditor', 'critique'],
        controls: {
          model: {
            supported: supportsModel || modelValues.length > 0,
            values: modelValues,
            aliases: modelHints,
            catalog: codexCatalog || null,
            freeText: true,
            defaultValue: String(process.env[`ORCA_${String(type).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_MODEL`] || '').slice(0, 120)
              || (type === 'codex' ? readCodexConfigDefault('model') : null)
              || null,
          },
          permissions: {
            supported: true,
            values: permissionValues,
            nativeFlag: supportsPermissionMode ? '--permission-mode' : (supportsApprovalMode ? '--approval-mode' : (type === 'codex' ? '--sandbox/--full-auto' : 'derived-or-passthrough')),
          },
          intelligence: {
            supported: supportsEffort,
            values: intelligenceValues,
            nativeFlag: supportsEffort ? '--effort' : null,
            passthrough: !supportsEffort,
          },
          structuredOutput: {
            supported: supportsOutputFormat || ['codex', 'claude', 'gemini-cli', 'composer-cli'].includes(type),
            formats: outputChoices.length ? outputChoices : (type === 'codex' ? ['jsonl'] : []),
          },
          mcpConfig: {
            supported: supportsMcpConfig || ['codex', 'claude'].includes(type),
            nativeFlag: supportsMcpConfig || ['codex', 'claude'].includes(type) ? '--mcp-config' : null,
          },
          backgroundAgents: {
            supported: backgroundAgents,
            attachable,
            logs,
            stoppable,
            commands: backgroundAgents ? ['agents', 'attach', 'logs', 'stop', 'respawn'].filter((command) => command === 'agents' || helpHas(helpText, new RegExp(`^\\s*${command}\\s`, 'm'))) : [],
          },
          cloud: {
            detected: Boolean(cloudCommand),
            command: cloudCommand,
            // No non-interactive cloud run exists for these CLIs yet, so a Cloud
            // run mode is surfaced but not yet selectable.
            runnable: false,
          },
          speed: {
            supported: supportsFast,
            values: supportsFast ? ['standard', 'fast'] : ['standard'],
            fast: supportsFast,
            nativeFlag: type === 'codex' ? '-c features.fast_mode=true'
              : (type === 'claude' ? '--settings {"fastMode":true}' : null),
          },
        },
        invocation: {
          canRunAsOrchestrator: true,
          canRunAsExecutor: true,
          commandDerivedFromLane: type !== 'cli',
          customArgs: type === 'cli',
          rawTerminalArtifacts: true,
          structuredAgentEvents: ['codex', 'claude', 'gemini-cli', 'composer-cli'].includes(type),
        },
        mcpScopes: type === 'cli' ? ['cli', 'custom-cli', 'all'] : [type, 'all'],
        detection: {
          source: helpInfo.ok ? 'version-and-help' : (versionInfo.exists ? 'version-only' : 'static'),
          checkedAt: nowIso(),
          helpExitCode: helpInfo.exitCode ?? null,
        },
      });
      cliCapabilityCache.set(cacheKey, {
        cachedAt: Date.now(),
        capabilities,
      });
      while (cliCapabilityCache.size > MAX_CLI_CAPABILITY_CACHE_ENTRIES) {
        const oldestKey = cliCapabilityCache.keys().next().value;
        if (!oldestKey) break;
        cliCapabilityCache.delete(oldestKey);
      }
      return clonePayload(capabilities);
    }

    const profile = getApiProviderProfileFromFactory(type) || {};
    return compactCapabilities({
      type,
      displayName: profile.id || type,
      kind: 'api',
      binary: null,
      binaryExists: false,
      version: null,
      roles: ['orchestrator', 'executor', 'auditor', 'critique'],
      controls: {
        model: { supported: true, values: safeArray(profile.allowedModels), freeText: true, defaultValue: profile.defaultModel || null },
        permissions: { supported: false, values: ['restricted'] },
        intelligence: { supported: false, values: ['low', 'medium', 'high', 'xhigh'], passthrough: true },
        structuredOutput: { supported: Boolean(profile.streaming), formats: profile.streaming ? ['provider-stream'] : ['provider-json'] },
        backgroundAgents: { supported: false },
      },
      invocation: {
        canRunAsOrchestrator: true,
        canRunAsExecutor: true,
        commandDerivedFromLane: false,
        customArgs: false,
        rawTerminalArtifacts: false,
        structuredAgentEvents: false,
      },
      mcpScopes: ['api', type, 'all'],
      detection: { source: 'provider-profile', checkedAt: nowIso() },
    });
  },

  getExecutorCapabilitiesMatrix() {
    return this.getSupportedExecutorTypes().reduce((accum, executorType) => {
      try {
        accum[executorType] = this.getExecutorCapabilities(executorType);
      } catch (error) {
        accum[executorType] = {
          type: executorType,
          error: error?.message || 'Capability detection failed.',
          roles: [],
          controls: {},
          invocation: {},
          detection: { source: 'error', checkedAt: nowIso() },
        };
      }
      return accum;
    }, {});
  },

  getExecutorCliInfo(executorType) {
    const type = normalizeExecutorType(executorType);
    if (!this.getSupportedExecutorTypes().includes(type)) {
      throw { status: 404, message: 'Unsupported executor type.' };
    }
    if (!FIRST_CLASS_CLI_EXECUTOR_TYPES.includes(type) && type !== 'cli') {
      return {
        type,
        profile: getApiProviderProfileFromFactory(type) || {},
        binary: null,
        binaryExists: false,
        version: null,
        binaryExitCode: null,
        capabilities: this.getExecutorCapabilities(type),
        reinstall: {
          available: false,
          command: null,
          preferSource: false,
          sourceRepos: [],
          sourceCommand: null,
        },
      };
    }

    const profile = getExecutorProfileFromFactory(type) || {};
    const binary = String(profile.defaultBinary || type);
    const versionInfo = getCliVersion(binary);
    const reinstallCommand = getReinstallCommand(type);
    const reinstallSourceRepos = getReinstallSourceRepos(type);
    const preferSource = shouldPreferSourceReinstall(type);
    return {
      type,
      profile,
      binary,
      binaryExists: versionInfo.exists,
      version: versionInfo.version,
      binaryExitCode: versionInfo.exitCode,
      capabilities: this.getExecutorCapabilities(type),
      reinstall: {
        available: Boolean(reinstallCommand),
        command: reinstallCommand,
        preferSource,
        sourceRepos: reinstallSourceRepos,
        sourceCommand: getReinstallSourceCommand(type),
      },
    };
  },

  // Governed on-demand setup of the evidence-capture browser backend.
  // Dry-run by default; executes only with approval + explicit confirmation.
  async setupCaptureBackend({
    actor = 'dashboard',
    approved = false,
    confirmed = false,
    preferSystemChrome = true,
  } = {}) {
    const policyCheck = this.evaluateActionPolicy('manageExecutorCli', { actor, approved });
    if (!policyCheck.allowed) {
      throw {
        status: 409,
        message: policyCheck.message,
        requiresApproval: true,
        risk: policyCheck.policy.risk,
      };
    }

    const installDir = path.join(this.storageDir, 'capture', 'playwright');
    const plan = planPlaywrightInstall({ installDir, preferSystemChrome });

    if (!confirmed) {
      this.recordAudit({
        type: 'capture_setup_planned',
        actor,
        summary: `Capture setup planned (${plan.backend})`,
        evidence: { backend: plan.backend, channel: plan.channel, installDir, steps: plan.steps.map((s) => s.label) },
        status: 'passed',
      });
      return { dryRun: true, plan };
    }

    await fs.mkdir(installDir, { recursive: true });
    const result = await runCaptureInstall(plan, {
      approved: true,
      spawn: (command, args, options) => new Promise((resolve) => {
        const child = spawn(command, args, {
          cwd: options?.cwd,
          env: { ...process.env, ...(options?.env || {}) },
          stdio: 'ignore',
        });
        child.on('error', () => resolve({ code: 1 }));
        child.on('close', (code) => resolve({ code: code ?? 1 }));
      }),
    });

    if (result.ok) {
      // Wire env so capture works immediately, without restarting the server.
      process.env.ORCA_PLAYWRIGHT_DIR = installDir;
      if (plan.channel) process.env.ORCA_CAPTURE_CHANNEL = plan.channel;
      else delete process.env.ORCA_CAPTURE_CHANNEL;
      if (plan.browsersDir) process.env.PLAYWRIGHT_BROWSERS_PATH = plan.browsersDir;
      if (this.evidenceRunner) this.evidenceRunner._hasPlaywright = null; // force re-detect
    }

    this.recordAudit({
      type: 'capture_setup_executed',
      actor,
      summary: `Capture setup ${result.ok ? 'succeeded' : 'failed'} (${plan.backend})`,
      evidence: { backend: plan.backend, channel: plan.channel, ok: result.ok, failedStep: result.failedStep || null },
      status: result.ok ? 'passed' : 'failed',
    });

    return { dryRun: false, executed: true, ok: result.ok, plan, result };
  },

  captureStatus({ playwrightAvailable = false } = {}) {
    return describeCaptureStatus({ playwrightAvailable });
  },

  async runExecutorCliReinstall(executorType, {
    actor = 'dashboard',
    approved = false,
    execute = false,
    command,
    confirmed = false,
    useSource = false,
  } = {}) {
    const type = normalizeExecutorType(executorType);
    if (!['codex', 'claude'].includes(type)) {
      throw { status: 404, message: 'Unsupported executor type.' };
    }

    const policyCheck = this.evaluateActionPolicy('manageExecutorCli', { actor, approved });
    if (!policyCheck.allowed) {
      throw {
        status: 409,
        message: policyCheck.message,
        requiresApproval: true,
        risk: policyCheck.policy.risk,
      };
    }

    const willExecute = Boolean(execute);
    const requestSource = Boolean(useSource);
    const hasOverride = command !== undefined;
    if (hasOverride && requestSource) {
      throw {
        status: 422,
        message: `Cannot combine custom command override and source mode for ${type} reinstall.`,
        risk: defaultPolicy.manageExecutorCli.risk,
      };
    }

    if (willExecute && !confirmed) {
      throw {
        status: 409,
        message: `Execution for ${type} CLI reinstall requires explicit confirmation.`,
        risk: defaultPolicy.manageExecutorCli.risk,
      };
    }

    const overrideCommand = hasOverride ? normalizeReinstallCommand(command, type) : null;
    const preferredCommand = getReinstallCommand(type);
    const sourceCommand = requestSource ? getReinstallSourceCommand(type) : null;

    if (hasOverride && !overrideCommand) {
      throw {
        status: 422,
        message: `Invalid reinstall command override for ${type}.`,
        risk: defaultPolicy.manageExecutorCli.risk,
      };
    }

    let commandToRun = null;
    let commandOrigin = 'policy';
    if (requestSource) {
      if (!sourceCommand) {
        throw {
          status: 422,
          message: `No trusted source reinstall command is available for ${type}.`,
          risk: defaultPolicy.manageExecutorCli.risk,
        };
      }
      const normalizedSourceCommand = normalizeReinstallCommand(sourceCommand, type);
      if (!normalizedSourceCommand) {
        throw {
          status: 422,
          message: `No trusted source reinstall command is available for ${type}.`,
          risk: defaultPolicy.manageExecutorCli.risk,
        };
      }
      commandToRun = normalizedSourceCommand;
      commandOrigin = 'source';
    } else if (hasOverride) {
      commandToRun = overrideCommand;
      commandOrigin = 'request';
    } else {
      commandToRun = preferredCommand;
    }

    if (!commandToRun) {
      throw {
        status: 422,
        message: `No safe reinstall command configured for ${type}.`,
        risk: defaultPolicy.manageExecutorCli.risk,
      };
    }

    if (!execute) {
      this.recordAudit({
        type: 'executor_cli_reinstall_plan_only',
        actor,
        projectId: null,
        sessionId: null,
        laneId: null,
        summary: `${type} CLI reinstall plan requested (dry-run mode)`,
        evidence: { executorType: type, command: commandToRun, source: commandOrigin },
        status: 'passed',
      });
      return {
        executorType: type,
        executed: false,
        command: commandToRun,
        reason: 'Dry-run mode. Set execute=true to apply.',
      };
    }

    const [binary, ...args] = commandToRun;
    const startedAt = new Date().toISOString();
    const result = spawnSync(binary, args, {
      encoding: 'utf8',
      timeout: REINSTALL_COMMAND_TIMEOUT_MS,
      windowsHide: true,
    });

    const evidence = {
      executorType: type,
      command: commandToRun,
      status: result.status,
      stdout: (result.stdout || '').slice(0, 8000),
      stderr: (result.stderr || '').slice(0, 8000),
      startedAt,
      completedAt: new Date().toISOString(),
      signal: result.signal || null,
    };

    this.recordAudit({
      type: 'executor_cli_reinstall_run',
      actor,
      projectId: null,
      sessionId: null,
      laneId: null,
      summary: `Executed ${type} CLI reinstall command`,
      evidence,
      status: result.status === 0 ? 'passed' : 'failed',
    });

    if (result.error && result.error.code) {
      evidence.errorCode = result.error.code;
      evidence.error = String(result.error.message || result.error);
    }

    return {
      executorType: type,
      executed: true,
      command: commandToRun,
      status: result.status,
      signal: result.signal || null,
      errorCode: result.error?.code || null,
      evidence,
    };
  },
};
