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
    summary: 'Register as an orchestrator for your working directory, and set/refresh your self-authored title, focus, and capacity. Body: {cwd, actor?, title?, focus?, approvedCapacity?, laneConcurrencyLimit?, takeoverOrchestratorId?}. approvedCapacity and laneConcurrencyLimit are compatibility names for the same enforced limit and must match if both are supplied. Orca creates the project implicitly (keyed by realpath(cwd)) and binds an orchestrator record to your lease. Re-register with the same cwd to update these fields.',
  },
  {
    id: 'orchestrator.list',
    group: 'orchestrator',
    roles: ['orchestrator', 'auditor', 'dashboard'],
    method: 'GET',
    route: '/api/orchestrators',
    implemented: true,
    mutating: false,
    summary: 'List orchestrators. Active only by default (a resigned one is not open work); ?all=1 includes resigned, ?projectId= filters to one project. Use this to find open work after reconnecting — /api/health reports a count but is not a listing.',
  },
  {
    id: 'orchestrator.status',
    group: 'orchestrator',
    roles: ['orchestrator', 'executor', 'auditor', 'dashboard'],
    method: 'GET',
    route: '/api/orchestrators/{orchestratorId}/status',
    implemented: true,
    mutating: false,
    summary: 'The canonical "what is happening" call for the lanes Orca manages: who owns this orchestrator, the lane tree, and the next required tool. It cannot see agents started outside Orca. Polling it with the owning lease refreshes the orchestrator\'s lastSeenAt, so ownership does not go stale; it does NOT extend the lease itself, whose expiresAt is fixed when it is minted and never renewed.',
  },
  {
    id: 'orchestrator.resign',
    group: 'orchestrator',
    roles: ['orchestrator', 'dashboard'],
    method: 'POST',
    route: '/api/orchestrators/{orchestratorId}/resign',
    implemented: true,
    mutating: true,
    summary: 'Release the orchestrator role you hold (mark your orchestrator resigned) so another chat or a human can register/take over. Body: {reason?} — defaults to "resigned". Only the lease that owns the orchestrator may resign it; another lease is refused with 403 "Lease does not own this orchestrator." Resigning does not stop the lanes you spawned.',
  },
  {
    id: 'executor.spawn',
    group: 'orchestrator',
    roles: ['orchestrator', 'dashboard'],
    method: 'POST',
    route: '/api/orchestrators/{orchestratorId}/executors',
    implemented: true,
    mutating: true,
    policyAction: 'createLane',
    summary: 'Spawn an executor lane under your orchestrator (runs in your project\'s cwd). Body: {title, executorType, taskPrompt, approved?, model?, permissionsProfile?, intelligenceProfile?, worktreeMode?, idleShutdown?, targetUrl?, verificationCommand?}. executorType: codex, claude, gemini-cli, composer-cli, or mock (the default when omitted; it runs no real agent). model: chosen per lane and passed to that CLI as --model; omit it for the CLI\'s own default. Orca does not validate it — the CLI does. permissionsProfile is mapped per CLI: "read-only" gives Codex --sandbox read-only and marks the lane a non-writer, but Claude receives it verbatim as --permission-mode, which current Claude CLIs reject (use plan there). intelligenceProfile: reasoning effort (Codex minimal|low|medium|high|xhigh; Claude low|medium|high|xhigh|max|ultracode). approved: pass true to satisfy the spawn-approval gate when the orchestrator policy requires explicit approval — without it the call is refused with requiresApproval:true. A spawn past the orchestrator\'s capacity is refused with 409, not queued. worktreeMode: auto (default — read-only/sole-writer lanes run directly in the checkout, overlapping writers get a dedicated worktree) or isolated (always give this lane its own worktree); any other value is treated as auto. idleShutdown: true (default — reap the lane after the idle window with no output or tool activity) or false (never auto-reap).',
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
    summary: 'Submit lane handoff and move the lane to ready_for_audit. Body: {summary?, changedFiles? (array of paths), handoff?, actor?} — all optional, but a submit with no summary and no changedFiles gives the auditor nothing to review and audit.accept then refuses. Only a starting or running lane can be submitted; from any other state this is refused with 409 "Lane cannot be submitted from state ...".',
  },
  {
    id: 'lane.shutdown',
    group: 'lane',
    roles: ['orchestrator', 'executor', 'dashboard'],
    method: 'POST',
    route: '/api/lanes/{laneId}/stop',
    implemented: true,
    mutating: true,
    policyAction: 'stopLane',
    summary: 'Stop a lane worker and its process group; in-flight work that the lane has not submitted is lost. Body: {approved, actor?, reason?}. Approval-gated by the default policy: without "approved": true the call is refused with 409 and requiresApproval:true. To stop every lane at once use fleet.emergency_stop instead.',
  },
  {
    id: 'lane.retry',
    group: 'lane',
    roles: ['orchestrator', 'dashboard'],
    method: 'POST',
    route: '/api/lanes/{laneId}/retry',
    implemented: true,
    mutating: true,
    policyAction: 'retryLane',
    summary: 'Retry a lane from its last terminal state, clearing its audit state. Retryable states: failed, stopped, fix_requested, blocked — any other state is refused with 409 "Lane state ... is not retryable". Body: {actor?}; not approval-gated. A lane whose executor process is still alive (it can be fix_requested while the child still runs) is also refused with 409 and processLive:true — call lane.shutdown first, then retry.',
  },
  {
    id: 'lane.delete',
    group: 'lane',
    roles: ['orchestrator', 'dashboard'],
    method: 'DELETE',
    route: '/api/lanes/{laneId}',
    implemented: true,
    mutating: true,
    summary: 'Delete a terminal lane (done/failed/stopped/accepted/blocked/archived) and its worktree. The lane record and its logs move to the state archive, where lane.get still reads them until the archive is purged. Body: {actor?}. A non-terminal lane is refused with 422 "Stop the lane before deleting it." A terminal state does not mean a dead process — an accepted lane can still have a live child — so a lane whose executor is still running is refused with 409 and processLive:true; call lane.shutdown first.',
  },
  {
    id: 'lane.controls.update',
    group: 'lane',
    roles: ['orchestrator', 'dashboard'],
    method: 'PATCH',
    route: '/api/lanes/{laneId}/controls',
    implemented: true,
    mutating: true,
    policyAction: 'updateLaneControls',
    summary: 'Update a lane\'s controls: model, permissions mode, intelligence, and — when the user left them blank — the targetUrl (dev/preview URL) and verificationCommand the agent has learned for this work. This changes the stored settings only; it does not reconfigure a CLI that is already running. Body: {approved, model?, permissionsProfile?, intelligenceProfile?, targetUrl?, verificationCommand?, actor?} — the same value sets executor.spawn documents, including the caveat that permissionsProfile "read-only" is a real Codex sandbox but reaches Claude verbatim as --permission-mode, which current Claude CLIs reject (use plan there), and that model is passed to the CLI unvalidated. Approval-gated by the default policy: without "approved": true the call is refused with 409 and requiresApproval:true. Reclassifying a sole-writer lane as a reader (or the reverse) can be refused when it would break lane isolation.',
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
    summary: 'Request human/orchestrator approval for a command, patch, or tool action, and mark the lane awaitingApproval. Body: {kind? (defaults to "command"), detail? (what you want approved — the text the decider sees), requestId?, actor?}. Returns the created approval; poll approval.list for its status. This asks for permission — it does not grant it, and it is not the "approved": true field that the spawn/stop/controls policy gate reads.',
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
    summary: 'Approve or deny a pending approval on behalf of the user. A governed Claude executor blocks on this decision. Body REQUIRES `decision`: approve | approved | allow | yes to approve, deny | denied | reject | no to deny; anything else is refused with 422 "Decision must be approve or deny." Also takes {actor?}. The approvalId comes from approval.list; an approval that is not still pending is refused with 409 "Approval already approved/denied."',
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
    policyAction: 'auditLane',
    summary: 'Queue ONE named lane for review: laneId is required and is not inferred, even when orchestrator.status names audit.queue_one as the next required tool — take the lane id from that lane tree or from lane.list. Body: {actor?}; not approval-gated. Queueing only creates the review task: record the outcome with audit.findings.record (or audit.accept / audit.request_fix / audit.block), which you may call without queueing first.',
  },
  {
    id: 'audit.findings.record',
    group: 'audit',
    roles: ['auditor', 'orchestrator', 'dashboard'],
    method: 'POST',
    route: '/api/lanes/{laneId}/audit/findings',
    implemented: true,
    mutating: true,
    summary: 'Record audit findings AND apply the verdict immediately. Body REQUIRES `verdict` (accepted | fix_requested | blocked) plus findings and/or reviewedFiles; entries may be strings or objects carrying a summary/message/path field. This is a verdict call, not a staging step: verdict accepted accepts the lane at once, and a following audit.accept is refused (409) because an accepted lane is no longer in an auditable state. Use it OR audit.accept / audit.request_fix / audit.block, not both. The review recorded here stays on the lane and counts toward the review gate if the lane comes back for audit.',
  },
  {
    id: 'audit.accept',
    group: 'audit',
    roles: ['auditor', 'orchestrator', 'dashboard'],
    method: 'POST',
    route: '/api/lanes/{laneId}/audit/accept',
    implemented: true,
    mutating: true,
    summary: 'Accept audited lane work; applies immediately. Body: {findings?, reviewedFiles?} — at least one is required unless a review is already recorded on this lane (otherwise 409). A lane with a targetUrl also needs a captured evidence artifact.',
  },
  {
    id: 'audit.request_fix',
    group: 'audit',
    roles: ['auditor', 'orchestrator', 'dashboard'],
    method: 'POST',
    route: '/api/lanes/{laneId}/audit/request-fix',
    implemented: true,
    mutating: true,
    summary: 'Request a fix pass after audit; applies immediately. Body: {findings, nextTask}.',
  },
  {
    id: 'audit.block',
    group: 'audit',
    roles: ['auditor', 'orchestrator', 'dashboard'],
    method: 'POST',
    route: '/api/lanes/{laneId}/audit/block',
    implemented: true,
    mutating: true,
    summary: 'Block an audit; applies immediately. Body: {reason (required), findings?}.',
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
    summary: 'Merge an ISOLATED, audit-accepted lane\'s branch back into the container base branch in the repo root. Merges the lane branch\'s COMMITS only: it refuses while the executor process is still live, and refuses a worktree with uncommitted changes (409, dirty:true, with changedFiles/worktreePath/branch) — commit them on the lane branch first. Reports merged / conflicts / nothing-to-merge. Does not push unless body.push:true, which requires workstation admin auth. Rejects direct lanes (their work already lives in the checkout).',
  },
  {
    id: 'lane.worktree.discard',
    group: 'lane',
    roles: ['orchestrator', 'dashboard'],
    method: 'POST',
    route: '/api/lanes/{laneId}/worktree/discard',
    implemented: true,
    mutating: true,
    policyAction: 'cleanupArtifacts',
    summary: 'Discard an isolated lane\'s git worktree. SAFE by default: refuses when the worktree has uncommitted changes. Body: {approved, force? (discard uncommitted changes anyway), removeBranch? (also delete the branch), actor?}. Approval-gated by the default policy: without "approved": true the call is refused with 409 and requiresApproval:true — that gate is separate from force, so a dirty worktree needs both.',
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
    policyAction: 'updateProject',
    summary: 'Register (or update) the live preview link for a project so it shows on the dashboard and on your phone. Body: {approved, label, localUrl (e.g. http://127.0.0.1:5173), port?, kind?, id? (to update an existing link), actor?}. Orca derives the tailnet URL. Approval-gated by the default policy: without "approved": true the call is refused with 409 and requiresApproval:true.',
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
