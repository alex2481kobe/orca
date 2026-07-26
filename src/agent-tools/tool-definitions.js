// Agent tool definitions (the contract data table) + accessors. Intentionally one
// module: a flat lookup table.
//
// SCOPE RULE: this table is the whole agent-facing surface, and it stays small on
// purpose. A tool earns its row only if it is required by the core loop —
// register -> spawn an executor -> read its output -> audit it -> integrate or
// discard — or by a runtime path that would otherwise break (the Claude
// permission-prompt relay, the live-preview link the dashboard renders).

export const TOOL_DEFINITIONS = [
  // --- orchestrator lifecycle ------------------------------------------------
  {
    id: 'orchestrator.register',
    group: 'orchestrator',
    roles: ['orchestrator', 'dashboard'],
    method: 'POST',
    route: '/api/orchestrators',
    implemented: true,
    mutating: true,
    summary: 'Register as an orchestrator for your working directory, and set/refresh your self-authored title + focus line. Body: {cwd, actor?, title?, focus?, takeoverOrchestratorId?}. Orca creates the project implicitly (keyed by realpath(cwd)) and binds an orchestrator record to your lease. Re-register with the same cwd to update title/focus.',
  },
  {
    id: 'orchestrator.status',
    group: 'orchestrator',
    roles: ['orchestrator', 'executor', 'auditor', 'dashboard'],
    method: 'GET',
    route: '/api/orchestrators/{orchestratorId}/status',
    implemented: true,
    mutating: false,
    summary: 'The canonical "what is happening" call: who owns this orchestrator, the lane tree, and the next required tool. Also refreshes your lease\'s lastSeenAt, so polling it keeps ownership from going stale.',
  },
  {
    id: 'orchestrator.resign',
    group: 'orchestrator',
    roles: ['orchestrator', 'dashboard'],
    method: 'POST',
    route: '/api/orchestrators/{orchestratorId}/resign',
    implemented: true,
    mutating: true,
    summary: 'Release the orchestrator role you hold (mark your orchestrator resigned) so another chat or a human can register/take over.',
  },
  {
    id: 'executor.spawn',
    group: 'orchestrator',
    roles: ['orchestrator', 'dashboard'],
    method: 'POST',
    route: '/api/orchestrators/{orchestratorId}/executors',
    implemented: true,
    mutating: true,
    summary: 'Spawn an executor lane under your orchestrator (runs in your project\'s cwd). Body: {title, executorType, taskPrompt, approved?, model?, permissionsProfile?, worktreeMode?, idleShutdown?}. approved: pass true to satisfy the spawn-approval gate when the orchestrator policy requires explicit approval — without it the call is refused with requiresApproval:true. worktreeMode: auto (default — read-only/sole-writer lanes run directly in the checkout, overlapping writers get a dedicated worktree) or isolated (always give this lane its own worktree). idleShutdown: true (default — reap the lane after the idle window with no output or tool activity) or false (never auto-reap).',
  },

  // --- lane observation + control -------------------------------------------
  {
    id: 'lane.list',
    group: 'lane',
    roles: ['orchestrator', 'executor', 'auditor', 'dashboard'],
    method: 'GET',
    route: '/api/orchestrators/{orchestratorId}/lanes',
    implemented: true,
    mutating: false,
    summary: 'List lanes under an orchestrator (compact: state, owner, executor type, audit state) — your "what is running" view.',
  },
  {
    id: 'lane.get',
    group: 'lane',
    roles: ['orchestrator', 'executor', 'auditor', 'dashboard'],
    method: 'GET',
    route: '/api/lanes/{laneId}',
    implemented: true,
    mutating: false,
    summary: 'Read one lane in full: logs, agent events, changed files, the captured result (resultText), and processMeta — use this to see WHY a lane failed or what it produced.',
  },
  {
    id: 'lane.submit',
    group: 'lane',
    roles: ['executor', 'orchestrator'],
    method: 'POST',
    route: '/api/lanes/{laneId}/submit',
    implemented: true,
    mutating: true,
    summary: 'Submit lane handoff (summary + changed files) and mark ready for audit.',
  },
  {
    id: 'lane.shutdown',
    group: 'lane',
    roles: ['orchestrator', 'executor', 'dashboard'],
    method: 'POST',
    route: '/api/lanes/{laneId}/stop',
    implemented: true,
    mutating: true,
    summary: 'Stop or shut down a lane worker.',
  },
  {
    id: 'lane.retry',
    group: 'lane',
    roles: ['orchestrator', 'dashboard'],
    method: 'POST',
    route: '/api/lanes/{laneId}/retry',
    implemented: true,
    mutating: true,
    summary: 'Retry a failed, stopped, or fix-requested lane.',
  },
  {
    id: 'lane.delete',
    group: 'lane',
    roles: ['orchestrator', 'dashboard'],
    method: 'DELETE',
    route: '/api/lanes/{laneId}',
    implemented: true,
    mutating: true,
    summary: 'Permanently delete a terminal lane (done/failed/stopped/accepted/blocked) and its worktree. Refuses a live lane.',
  },
  {
    id: 'lane.controls.update',
    group: 'lane',
    roles: ['orchestrator', 'dashboard'],
    method: 'PATCH',
    route: '/api/lanes/{laneId}/controls',
    implemented: true,
    mutating: true,
    summary: 'Update a lane\'s controls: model, permissions mode, intelligence, and — when the user left them blank — the targetUrl (dev/preview URL) and verificationCommand the agent has learned for this work.',
  },
  {
    id: 'lane.terminal.tail',
    group: 'lane',
    roles: ['orchestrator', 'executor', 'auditor', 'dashboard'],
    method: 'GET',
    route: '/api/lanes/{laneId}/terminal-tail',
    implemented: true,
    mutating: false,
    summary: 'Read a bounded tail of raw terminal.log for near-live worker output. Query: offset, maxBytes. Use nextOffset for incremental polling.',
  },
  {
    id: 'lane.terminal.write',
    group: 'lane',
    roles: ['executor', 'orchestrator', 'dashboard'],
    method: 'POST',
    route: '/api/lanes/{laneId}/terminal-input',
    implemented: true,
    mutating: true,
    summary: 'Write input to a running lane\'s interactive terminal (answer a prompt the worker is waiting on). Body: {input, raw?}. Pairs with lane.terminal.tail for read.',
  },
  {
    id: 'lane.artifacts.list',
    group: 'lane',
    roles: ['orchestrator', 'executor', 'auditor', 'dashboard'],
    method: 'GET',
    route: '/api/lanes/{laneId}/artifacts',
    implemented: true,
    mutating: false,
    summary: 'List the captured artifact files for a lane (screenshots, outcome/transcript, evidence). Use this to verify a lane produced the evidence its work requires — audit.accept refuses UI/browser work with no captured evidence.',
  },
  {
    id: 'lane.artifacts.get',
    group: 'lane',
    roles: ['orchestrator', 'executor', 'auditor', 'dashboard'],
    method: 'GET',
    route: '/api/lanes/{laneId}/artifacts/{name}',
    implemented: true,
    mutating: false,
    summary: 'Fetch one lane artifact file by name. Returns {name, size, encoding (utf8|base64), content} — text artifacts inline, images/pdf/video base64. Bounded in size.',
  },

  // --- Claude permission-prompt relay ---------------------------------------
  // Not "extra governance": every governed (non-bypass) Claude lane is launched
  // with --permission-prompt-tool mcp__orca__permission_prompt (see
  // executor/command-builder.js), and that gateway POSTs/GETs the approvals
  // routes with the lane's own lease. Without these three tool ids the lease has
  // no scope for those routes, the gateway 403s, and every governed Claude
  // executor denies its own tool calls. This is the runtime, not a feature.
  {
    id: 'approval.request',
    group: 'approval',
    roles: ['executor', 'orchestrator'],
    method: 'POST',
    route: '/api/lanes/{laneId}/approvals',
    implemented: true,
    mutating: true,
    summary: 'Request human/orchestrator approval for a command, patch, or tool action.',
  },
  {
    id: 'approval.list',
    group: 'approval',
    roles: ['executor', 'orchestrator', 'auditor', 'dashboard'],
    method: 'GET',
    route: '/api/lanes/{laneId}/approvals',
    implemented: true,
    mutating: false,
    summary: 'List pending and decided approvals for a lane.',
  },
  {
    id: 'approval.respond',
    group: 'approval',
    roles: ['orchestrator', 'dashboard', 'auditor'],
    method: 'POST',
    route: '/api/lanes/{laneId}/approvals/{approvalId}/decide',
    implemented: true,
    mutating: true,
    summary: 'Approve or deny a pending approval on behalf of the user. A governed Claude executor blocks on this decision.',
  },

  // --- audit ----------------------------------------------------------------
  {
    id: 'audit.queue_one',
    group: 'audit',
    roles: ['orchestrator', 'auditor', 'dashboard'],
    method: 'POST',
    route: '/api/lanes/{laneId}/audit',
    implemented: true,
    mutating: true,
    summary: 'Queue an audit for one lane.',
  },
  {
    id: 'audit.findings.record',
    group: 'audit',
    roles: ['auditor', 'orchestrator', 'dashboard'],
    method: 'POST',
    route: '/api/lanes/{laneId}/audit/findings',
    implemented: true,
    mutating: true,
    summary: 'Record audit findings and choose accept, request-fix, or block verdict.',
  },
  {
    id: 'audit.accept',
    group: 'audit',
    roles: ['auditor', 'orchestrator', 'dashboard'],
    method: 'POST',
    route: '/api/lanes/{laneId}/audit/accept',
    implemented: true,
    mutating: true,
    summary: 'Accept audited lane work.',
  },
  {
    id: 'audit.request_fix',
    group: 'audit',
    roles: ['auditor', 'orchestrator', 'dashboard'],
    method: 'POST',
    route: '/api/lanes/{laneId}/audit/request-fix',
    implemented: true,
    mutating: true,
    summary: 'Request a fix pass after audit.',
  },
  {
    id: 'audit.block',
    group: 'audit',
    roles: ['auditor', 'orchestrator', 'dashboard'],
    method: 'POST',
    route: '/api/lanes/{laneId}/audit/block',
    implemented: true,
    mutating: true,
    summary: 'Block an audit with a reason.',
  },

  // --- integrate or discard --------------------------------------------------
  {
    id: 'lane.integrate',
    group: 'lane',
    roles: ['orchestrator', 'dashboard'],
    method: 'POST',
    route: '/api/lanes/{laneId}/integrate',
    implemented: true,
    mutating: true,
    summary: 'Merge an ISOLATED, audit-accepted lane\'s branch back into the container base branch in the repo root. Reports merged / conflicts / nothing-to-merge. Does not push unless body.push:true. Rejects direct lanes (their work already lives in the checkout).',
  },
  {
    id: 'lane.worktree.discard',
    group: 'lane',
    roles: ['orchestrator', 'dashboard'],
    method: 'POST',
    route: '/api/lanes/{laneId}/worktree/discard',
    implemented: true,
    mutating: true,
    summary: 'Discard an isolated lane\'s git worktree. SAFE by default: refuses when the worktree has uncommitted changes. Pass body.force:true to discard them anyway, body.removeBranch:true to also delete the branch.',
  },

  // --- break glass + wakeups -------------------------------------------------
  {
    id: 'fleet.emergency_stop',
    group: 'fleet',
    roles: ['orchestrator', 'dashboard'],
    method: 'POST',
    route: '/api/orchestrators/{orchestratorId}/emergency-stop',
    implemented: true,
    mutating: true,
    summary: 'Break-glass: stop ALL live lanes under your orchestrator at once (not just one). Body: {all?:true}. all:true stops every executor fleet-wide and requires workstation admin auth.',
  },
  {
    id: 'event.drain',
    group: 'event',
    roles: ['orchestrator', 'dashboard'],
    method: 'GET',
    route: '/api/orchestrators/{orchestratorId}/events/drain',
    implemented: true,
    // CONSUMES: whatever it returns is acknowledged for this consumer, so a second
    // call does NOT return the same events. It is therefore mutating despite being a
    // GET — which also makes the ownership gate apply (assertOrchestratorOwnership
    // skips non-mutating tools), so one orchestrator cannot drain another's queue.
    mutating: true,
    summary: 'Drain unacknowledged durable agent events for your orchestrator, scoped to the caller role/lease. CONSUMES what it returns — the same events are not returned twice, so persist them before acting. Query: limit, type, afterSeq.',
  },

  // --- live preview link -----------------------------------------------------
  // The dashboard renders these as preview chips (public/ui/overview.js
  // collectPreviews) off /api/overview's `previews` field, so an agent needs one
  // way to register the dev-server port it just started.
  {
    id: 'project.preview.set',
    group: 'projects',
    roles: ['orchestrator', 'dashboard'],
    method: 'POST',
    route: '/api/projects/{projectId}/quick-links',
    implemented: true,
    mutating: true,
    summary: 'Register (or update) the live preview link for a project so it shows on the dashboard and on your phone. Body: {label, localUrl (e.g. http://127.0.0.1:5173), port?, kind?, id? (to update an existing link)}. Orca derives the tailnet URL.',
  },
];

function publicTool(tool) {
  return {
    id: tool.id,
    group: tool.group,
    roles: [...tool.roles],
    method: tool.method,
    route: tool.route,
    implemented: Boolean(tool.implemented),
    mutating: Boolean(tool.mutating),
    summary: tool.summary,
  };
}

export function getToolDefinitions() {
  return TOOL_DEFINITIONS.map(publicTool);
}

export function findTool(toolId) {
  return TOOL_DEFINITIONS.find((tool) => tool.id === toolId) || null;
}
