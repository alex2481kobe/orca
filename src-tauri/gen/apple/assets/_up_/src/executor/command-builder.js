// Executor command-line construction + sandbox/permission flag mapping.
// Extracted from executor-factory.js.

export function buildExecutorCommandArgs(label, lane, options = {}) {
  const mcpServers = (options && options.mcpServers && typeof options.mcpServers === 'object') ? options.mcpServers : {};
  const taskPrompt = String(lane.taskPrompt || '').trim();
  if (!taskPrompt) return [];
  const safePrompt = taskPrompt.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 4096);
  // Values that become discrete argv tokens must not begin with "-" or the
  // executor's own option parser would treat them as flags (flag injection),
  // and must not carry control characters. shell:false already blocks shell
  // injection; this blocks argument/flag injection.
  const flagSafe = (value, max) => {
    const v = String(value || '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, max);
    return v && !v.startsWith('-') ? v : '';
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
      out.push('exec', '--json');
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
      out.push('--skip-git-repo-check');
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
      out.push(targetUrl ? `Target: ${targetUrl}\n${safePrompt}` : safePrompt);
      break;
    }
    case 'claude': {
      out.push('--print');
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
      out.push('--output-format', 'stream-json', '--verbose', '--include-partial-messages');
      out.push(targetUrl ? `Target: ${targetUrl}\n${safePrompt}` : safePrompt);
      break;
    }
    case 'gemini-cli': {
      if (model) out.push('--model', model);
      if (permissions && !isPlanMode(permissions)) out.push('--approval-mode', geminiApprovalMode(permissions));
      out.push('--output-format', 'json');
      out.push('--prompt', targetUrl ? `Target: ${targetUrl}\n${safePrompt}` : safePrompt);
      break;
    }
    case 'composer-cli': {
      if (model) out.push('--model', model);
      if (isForceMode(permissions)) {
        out.push('--force');
      }
      out.push('--output-format', 'stream-json');
      out.push('-p', targetUrl ? `Target: ${targetUrl}\n${safePrompt}` : safePrompt);
      break;
    }
    default:
      out.push(safePrompt);
  }
  return out;
}
