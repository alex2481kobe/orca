import { clonePayload } from './registry-utils.js';

// Action approval/risk policy table + its one accessor. Extracted from registry.js. The server
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
  updateProject: {
    requiresApproval: true,
    risk: 'medium',
    message: 'Project updates can alter routes, quick links, and routing state.',
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
  // Still load-bearing: lane.worktree.discard (removeLaneWorktree) gates on it.
  cleanupArtifacts: {
    requiresApproval: true,
    risk: 'high',
    message: 'Removes a lane\'s managed git worktree from disk.',
  },
};

export const policyMethods = {
  getPolicyMap() {
    return clonePayload(this.policies);
  },
};
