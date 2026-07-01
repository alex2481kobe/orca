// Shared mutable UI state for the Orca dashboard: the single `shell` store and
// cached DOM `refs`. Exported objects are mutated in place by feature modules
// (ES live bindings share the same instance across imports). Extracted from app.js.

export const shell = {
  route: {
    projectSlug: null,
    sessionId: null,
    laneId: null,
  },
  projects: [],
  sessions: [],
  lanes: [],
  backlogs: {},
  policy: {},
  mobileManifest: null,
  apiToken: '',
  cleanupSchedule: null,
  pendingAuditEvents: [],
  mcpTools: [],
  executorProfiles: null,
  executorCliInfo: {},
  systemBlockers: [],
  privateAccess: null,
  providerCatalog: null,
  providerHealth: {},
  effectiveSettings: null,
  authStatus: null,
  notifications: null,
  authSessions: null,
  lastPairing: null,
  // Transient "device paired ✓" confirmation shown on the workstation right after
  // a remote device consumes a pairing code; cleared a few seconds later.
  pairingAccepted: null,
  executorPanelOpen: false,
  workstationPicker: null,
  supervisorOverview: null,
  lastWorkspaceHref: '/',
  // Per-session chat composer drafts, keyed by sessionId. The single source of
  // truth for the message box — the DOM textarea is rehydrated from here on every
  // render, so NO re-render (poll, SSE, structural rebuild, modal, route change)
  // can ever clear what the operator is typing.
  composerDrafts: {},
  // Per-session operator preference for a terminal-style view of the active
  // orchestrator lane. This is intentionally client-only: it changes how this
  // browser watches the run, not the session contract.
  chatTerminalOpenBySession: {},
  // Client-only DRAFT chats, keyed by sentinel id `draft-<projectId>`. A "New chat"
  // is a draft until the first message is sent — only then is a real server session
  // created (see ensureRealSession). An untouched draft is never persisted, so it
  // never clutters the sidebar or disk.
  draftSessions: {},
  // Branch/worktree info cache, keyed by session (or draft) id.
  gitInfo: {},
};

// Build a client-only draft "New chat" session that looks enough like a real one
// for the session view to render. Stable id per project so re-opening reuses it.
export function makeDraftSession(project, leader) {
  const now = new Date().toISOString();
  const id = `draft-${project.id}`;
  return {
    id,
    projectId: project.id,
    name: 'New chat',
    leader: leader || project.leader || '',
    repoRoot: project.repoRoot || '',
    route: `/projects/${project.slug || project.id}/sessions/${id}`,
    state: 'active',
    isDraft: true,
    orchestratorThread: { messages: [], laneIds: [], activeLaneId: null },
    createdAt: now,
    updatedAt: now,
  };
}

export const refs = {
  breadcrumbs: document.getElementById('breadcrumbs'),
  alerts: document.getElementById('alerts'),
  content: document.getElementById('content'),
  statusStrip: document.getElementById('status-strip'),
  blockers: document.getElementById('blockers'),
  sidebarProjects: document.getElementById('sidebar-projects'),
  topbarTitle: document.getElementById('topbar-title'),
  pickerOverlay: document.getElementById('picker-overlay'),
};
// Audit queue is rendered inside refs.content for the new operator shell.
refs.actions = refs.content;
