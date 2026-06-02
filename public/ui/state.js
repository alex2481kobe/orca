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
  policy: {},
  alerts: [],
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
  executorPanelOpen: true,
};

export const refs = {
  breadcrumbs: document.getElementById('breadcrumbs'),
  alerts: document.getElementById('alerts'),
  content: document.getElementById('content'),
  statusStrip: document.getElementById('status-strip'),
  blockers: document.getElementById('blockers'),
  sidebarProjects: document.getElementById('sidebar-projects'),
  topbarSubtitle: document.getElementById('topbar-subtitle'),
  topbarTitle: document.getElementById('topbar-title'),
};
// Audit queue is rendered inside refs.content for the new operator shell.
refs.actions = refs.content;
