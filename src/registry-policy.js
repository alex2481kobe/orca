// Action approval/risk policy table. Extracted from registry.js. The server
// merges persisted overrides on top of this (never weakening a hardcoded
// requiresApproval for a known action). evaluateActionPolicy/getPolicyMap consume it.
export const defaultPolicy = {
  createProject: {
    requiresApproval: true,
    risk: 'high',
    message: 'Creating a project can change dashboard topology and expose automation surfaces.',
  },
  createLane: {
    requiresApproval: true,
    risk: 'high',
    message: 'Spawns executor process and can mutate workspace state.',
  },
  createSession: {
    requiresApproval: true,
    risk: 'medium',
    message: 'Creates project coordination sessions and increases execution capacity.',
  },
  updateSession: {
    requiresApproval: true,
    risk: 'medium',
    message: 'Session updates can change execution limits and operational state.',
  },
  updateProject: {
    requiresApproval: true,
    risk: 'medium',
    message: 'Project updates can alter routes, quick links, and routing state.',
  },
  deleteSession: {
    requiresApproval: true,
    risk: 'high',
    message: 'Permanently deletes an archived session, lanes, backlog tasks, and workspace data.',
  },
  deleteProject: {
    requiresApproval: true,
    risk: 'high',
    message: 'Permanently deletes an archived project and all of its sessions.',
  },
  stopLane: {
    requiresApproval: true,
    risk: 'high',
    message: 'Stops an active lane and may lose in-flight state.',
  },
  retryLane: {
    requiresApproval: false,
    risk: 'medium',
    message: 'Replays a lane from last known terminal state.',
  },
  updateLaneControls: {
    requiresApproval: true,
    risk: 'high',
    message: 'Changes agent model, mode, or intelligence controls for a lane.',
  },
  auditLane: {
    requiresApproval: false,
    risk: 'medium',
    message: 'Queues lane for review without mutating external state.',
  },
  auditDoneLanes: {
    requiresApproval: false,
    risk: 'medium',
    message: 'Queues review for finished lanes.',
  },
  captureEvidence: {
    requiresApproval: false,
    risk: 'low',
    message: 'Captures lane evidence via browser automation.',
  },
  clearEvidenceArtifacts: {
    requiresApproval: true,
    risk: 'medium',
    message: 'Clears generated evidence artifacts for a lane.',
  },
  waiveCritique: {
    requiresApproval: true,
    risk: 'medium',
    message: 'Waives a required self-verification gate before audit.',
  },
  cleanupArtifacts: {
    requiresApproval: true,
    risk: 'high',
    message: 'Removes archived lane artifacts from disk.',
  },
  manageCleanupSchedule: {
    requiresApproval: true,
    risk: 'medium',
    message: 'Changes periodic cleanup policy and can increase data retention risk.',
  },
  manageMcpTools: {
    requiresApproval: true,
    risk: 'high',
    message: 'MCP tool changes can run arbitrary local commands.',
  },
  manageCapacity: {
    requiresApproval: true,
    risk: 'medium',
    message: 'Changes session agent capacity and spawn policy.',
  },
  requestCapacity: {
    requiresApproval: false,
    risk: 'medium',
    message: 'Requests more executor capacity without spawning agents.',
  },
  manageAppBackups: {
    requiresApproval: true,
    risk: 'high',
    message: 'App backup import/export can expose or merge local project coordination state.',
  },
};
