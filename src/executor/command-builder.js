// Executor command-line construction + sandbox/permission flag mapping.
// Extracted from executor-factory.js.

// Modes that mean "no sandbox" by name. Authorization must NOT stop here: what
// actually matters is the EFFECTIVE mode after per-executor mapping (see below).
const NAMED_UNSANDBOXED_MODES = new Set([
  'bypass', 'bypass-permissions', 'bypasspermissions', 'yolo', 'force', 'danger', 'danger-full-access',
]);
// Aliases the argv builder treats as "force" (isForceMode below). For most CLIs these
// only accept edits inside the workspace, but composer-cli turns them into `--force`,
// which is a genuinely unsandboxed run.
const FORCE_ALIAS_MODES = new Set([
  'auto', 'auto-edit', 'auto_edit', 'auto-accept', 'auto_accept', 'acceptedits',
  ...NAMED_UNSANDBOXED_MODES,
]);

// THE authorization predicate: does this (executorType, permissionsProfile) pair
// actually produce an UNSANDBOXED child? Answer per executor, because the same string
// means different things:
//   codex        — plan/ask/read-only -> --sandbox read-only, everything else ->
//                  workspace-write. Still sandboxed either way.
//   claude       — only the bypass family disables permissions.
//   gemini-cli   — the bypass family maps to yolo.
//   composer-cli — ANY force alias (including "auto-edit") emits --force = unsandboxed.
// Callers must gate on THIS, not on the raw string, or a mode that reads as sandboxed
// at one route launches unsandboxed at another. Used by the spawn route AND the
// lane-controls route — a lane's mode can be changed after spawn, and that path was
// previously ungated entirely.
export function isUnsandboxedEffectiveMode(executorType, permissionsProfile) {
  const mode = String(permissionsProfile || '').trim().toLowerCase();
  if (!mode) return false;
  const type = String(executorType || '').trim().toLowerCase();
  if (type === 'composer-cli') return FORCE_ALIAS_MODES.has(mode);
  return NAMED_UNSANDBOXED_MODES.has(mode);
}

export function buildExecutorCommandArgs(label, lane, options = {}) {
  const mcpServers = (options && options.mcpServers && typeof options.mcpServers === 'object') ? options.mcpServers : {};
  const presentationMode = String(options.presentationMode || lane.presentationMode || 'chat').trim().toLowerCase();
  const terminalPresentation = presentationMode === 'terminal';
  const taskPrompt = String(lane.taskPrompt || '').trim();
  if (!taskPrompt) return [];
  // Prompt is passed as a single argv token. The old 4096 cap silently truncated
  // ordinary scope-controlled prompts (explicit file lists + exclusions) — exactly
  // the prompts that keep an executor on-task — so it undermined scope control.
  // Cap generously (96 KiB, far under the ~256 KiB per-arg OS limit) so real
  // prompts pass intact; keep the control-char sanitization (a real safety gate).
  const MAX_PROMPT_BYTES = 96 * 1024;
  const cleaned = taskPrompt.replace(/[\x00-\x1f\x7f]/g, ' ');
  const safePrompt = Buffer.byteLength(cleaned, 'utf8') > MAX_PROMPT_BYTES
    ? `${cleaned.slice(0, MAX_PROMPT_BYTES)}\n\n[orca: prompt truncated at ${MAX_PROMPT_BYTES} bytes]`
    : cleaned;
  // Values that become discrete argv tokens must not begin with "-" or the
  // executor's own option parser would treat them as flags (flag injection),
  // and must not carry control characters. shell:false already blocks shell
  // injection; this blocks argument/flag injection.
  const flagSafe = (value, max) => {
    const v = String(value || '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, max);
    return v && !v.startsWith('-') ? v : '';
  };
  // The PROMPT is also a discrete argv token, and it is the one field every caller
  // controls — so it is the easiest flag-injection vector: a taskPrompt of
  // "--dangerously-bypass-approvals-and-sandbox" would otherwise land in argv AFTER
  // the sandbox flags, in override position, and launch an unsandboxed agent.
  // Unlike the fields above we must NOT drop it (prompts legitimately start with "-",
  // e.g. a markdown bullet), so neutralize instead: a leading space makes the parser
  // see a positional while leaving the prompt semantically identical.
  const positionalSafe = (value) => {
    const v = String(value ?? '');
    return v.startsWith('-') ? ` ${v}` : v;
  };
  const model = flagSafe(lane.model, 120);
  const permissions = flagSafe(lane.permissionsProfile, 120);
  const intelligence = flagSafe(lane.intelligenceProfile, 80);
  const targetUrl = flagSafe(lane.targetUrl, 1024);
  const geminiApprovalMode = (value) => {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'auto-edit' || normalized === 'auto_accept' || normalized === 'auto-accept' || normalized === 'acceptedits') return 'auto_edit';
    if (normalized === 'bypass' || normalized === 'bypass-permissions' || normalized === 'bypasspermissions' || normalized === 'force') return 'yolo';
    return normalized;
  };
  const claudePermissionMode = (value) => {
    const normalized = String(value || '').trim();
    const key = normalized.toLowerCase();
    if (key === 'auto-edit' || key === 'auto_accept' || key === 'auto-accept') return 'acceptEdits';
    if (key === 'bypass' || key === 'bypass-permissions') return 'bypassPermissions';
    return normalized;
  };
  const claudeEffortLevel = (value) => {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'max') return 'max';
    if (normalized === 'xhigh' || normalized === 'extra-high' || normalized === 'very-high') return 'xhigh';
    if (normalized === 'high') return 'high';
    if (normalized === 'medium') return 'medium';
    if (normalized === 'low') return 'low';
    return '';
  };
  const isPlanMode = (value) => ['plan', 'read-only', 'readonly', 'default', 'ask'].includes(String(value || '').trim().toLowerCase());
  const isForceMode = (value) => ['auto', 'auto-edit', 'auto_edit', 'auto-accept', 'auto_accept', 'acceptedits', 'bypass', 'bypass-permissions', 'bypasspermissions', 'force', 'yolo']
    .includes(String(value || '').trim().toLowerCase());
  const out = [];
  switch (String(label).toLowerCase()) {
    case 'codex': {
      if (!terminalPresentation) out.push('exec');
      if (!terminalPresentation) out.push('--json');
      if (model) out.push('--model', model);
      // Reasoning effort (the "/reasoning" level) -> -c model_reasoning_effort.
      // Codex's real effort set is minimal/low/medium/high/xhigh — include
      // "minimal" (the old list dropped it) but never the claude-only "max".
      const codexEffort = ['minimal', 'low', 'medium', 'high', 'xhigh'].includes(intelligence.toLowerCase()) ? intelligence.toLowerCase() : '';
      if (codexEffort) out.push('--config', `model_reasoning_effort="${codexEffort}"`);
      // Speed (terminal "/fast") -> the fast_mode feature flag.
      if (String(lane.speed || '').trim().toLowerCase() === 'fast') out.push('--config', 'features.fast_mode=true');
      // codex exec is non-interactive; governance is by sandbox policy.
      // (--full-auto is deprecated in codex 0.134+ in favor of --sandbox
      // workspace-write.) plan/ask -> read-only; everything else -> workspace-write
      // (edit the workspace, no network/system escape).
      if (isPlanMode(permissions)) out.push('--sandbox', 'read-only');
      else out.push('--sandbox', 'workspace-write');
      // Run in non-git session folders and fresh per-lane worktrees without the
      // interactive "not a trusted git repo" refusal.
      if (!terminalPresentation) out.push('--skip-git-repo-check');
      // Codex has NO `--mcp-config` flag (that's Claude-only); passing it makes
      // `codex exec` exit 2. Configure MCP servers via `-c mcp_servers.<name>.*`
      // config overrides instead, which keep the user's default ~/.codex auth.
      for (const [name, server] of Object.entries(mcpServers)) {
        if (!server || !server.command || !/^[A-Za-z0-9_-]+$/.test(name)) continue;
        out.push('-c', `mcp_servers.${name}.command=${JSON.stringify(String(server.command))}`);
        out.push('-c', `mcp_servers.${name}.args=${JSON.stringify(Array.isArray(server.args) ? server.args.map(String) : [])}`);
        const env = server.env && typeof server.env === 'object' ? server.env : {};
        for (const [key, value] of Object.entries(env)) {
          if (!/^[A-Za-z0-9_]+$/.test(key)) continue;
          out.push('-c', `mcp_servers.${name}.env.${key}=${JSON.stringify(String(value))}`);
        }
      }
      if (targetUrl) out.push('--target', targetUrl);
      out.push(positionalSafe(targetUrl ? `Target: ${targetUrl}\n${safePrompt}` : safePrompt));
      break;
    }
    case 'claude': {
      if (!terminalPresentation) out.push('--print');
      if (model) out.push('--model', model);
      // Claude exposes "ultracode" (xhigh + dynamic-workflow orchestration) and
      // "fast" as SESSION SETTINGS, not flags — collect them into one --settings.
      // ("ultracode" is deliberately not a --effort value; the CLI rejects it.)
      const claudeSettings = {};
      if (intelligence.toLowerCase() === 'ultracode') {
        claudeSettings.ultracode = true;
      } else {
        const effort = claudeEffortLevel(intelligence);
        if (effort) out.push('--effort', effort);
      }
      if (String(lane.speed || '').trim().toLowerCase() === 'fast') claudeSettings.fastMode = true;
      if (Object.keys(claudeSettings).length) out.push('--settings', JSON.stringify(claudeSettings));
      if (permissions) out.push('--permission-mode', claudePermissionMode(permissions));
      if (lane.mcpConfigPath) out.push('--mcp-config', lane.mcpConfigPath);
      // Governed (non-bypass) lanes route Claude's permission prompts through the
      // built-in Orca MCP server so the orchestrator/user can approve/deny.
      if (lane.mcpConfigPath && !isForceMode(permissions)) {
        out.push('--permission-prompt-tool', 'mcp__orca__permission_prompt');
      }
      if (!terminalPresentation) out.push('--output-format', 'stream-json', '--verbose', '--include-partial-messages');
      out.push(positionalSafe(targetUrl ? `Target: ${targetUrl}\n${safePrompt}` : safePrompt));
      break;
    }
    case 'gemini-cli': {
      if (model) out.push('--model', model);
      if (permissions && !isPlanMode(permissions)) out.push('--approval-mode', geminiApprovalMode(permissions));
      if (!terminalPresentation) out.push('--output-format', 'json');
      out.push('--prompt', targetUrl ? `Target: ${targetUrl}\n${safePrompt}` : safePrompt);
      break;
    }
    case 'composer-cli': {
      if (model) out.push('--model', model);
      if (isForceMode(permissions)) {
        out.push('--force');
      }
      if (!terminalPresentation) out.push('--output-format', 'stream-json');
      out.push('-p', targetUrl ? `Target: ${targetUrl}\n${safePrompt}` : safePrompt);
      break;
    }
    default:
      out.push(safePrompt);
  }
  return out;
}
