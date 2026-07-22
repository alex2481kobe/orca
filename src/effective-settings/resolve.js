// Effective-settings resolution (merge precedence). Extracted from
// effective-settings.js.

import {
  CONTRACT_VERSION,
  DEFAULT_EFFECTIVE_SETTINGS,
  clonePayload,
  sanitizeSettingsOverrides,
} from './schema.js';
import { isWorktreeMode } from '../registry-lane-config.js';

function mergeSettings(base, override) {
  const next = clonePayload(base);
  for (const [group, values] of Object.entries(override || {})) {
    next[group] = {
      ...(next[group] || {}),
      ...values,
    };
  }
  return next;
}

function hasSettings(value) {
  return Boolean(value && Object.keys(value).length);
}

function sessionFieldSettings(session) {
  if (!session) return {};
  const settings = {};
  const spawn = {};
  if (session.spawnPolicy !== undefined) spawn.spawnPolicy = session.spawnPolicy;
  if (session.approvedCapacity !== undefined) spawn.approvedCapacity = session.approvedCapacity;
  if (session.soloMode !== undefined) spawn.soloMode = session.soloMode !== false;
  if (session.idleShutdownMode !== undefined) spawn.idleShutdownMode = session.idleShutdownMode;
  // The orchestrator-container seam has no session record to carry a forced
  // worktree mode: it omits the field (undefined) to mean "no override at this
  // layer". Only carry a real enum value into the layered settings so anything
  // else falls through to the defaults instead of tripping the schema sanitizer.
  if (session.worktreeMode !== undefined && isWorktreeMode(session.worktreeMode)) {
    spawn.worktreeMode = session.worktreeMode;
  }
  if (Object.keys(spawn).length) settings.spawn = spawn;

  if (session.critiqueMode !== undefined && session.critiqueMode !== 'none') {
    settings.critique = { mode: session.critiqueMode };
  }

  if (session.artifactRetentionDays !== undefined && session.artifactRetentionDays !== null) {
    const retentionDays = session.artifactRetentionDays;
    settings.evidence = { retentionDays };
    settings.cleanup = { retentionDays };
  }
  return sanitizeSettingsOverrides(settings);
}

function laneFieldSettings(lane) {
  if (!lane) return {};
  const settings = {};
  if (lane.critiqueMode !== undefined) settings.critique = { mode: lane.critiqueMode };
  if (lane.targetUrl) {
    settings.critique = {
      ...(settings.critique || {}),
      visualBrowserMode: 'visual-required',
    };
    settings.evidence = {
      ...(settings.evidence || {}),
      screenshotRequiredForVisual: true,
    };
  }
  return sanitizeSettingsOverrides(settings);
}

export function buildEffectiveSettings({
  project = null,
  session = null,
  lane = null,
  actionOverride = null,
} = {}) {
  let settings = clonePayload(DEFAULT_EFFECTIVE_SETTINGS);
  const sourcesApplied = [{
    scope: 'global',
    source: 'defaults',
    id: null,
    fields: Object.keys(settings),
  }];

  const applySource = (scope, source, id, overrides) => {
    const sanitized = sanitizeSettingsOverrides(overrides || {});
    if (!hasSettings(sanitized)) return;
    settings = mergeSettings(settings, sanitized);
    sourcesApplied.push({
      scope,
      source,
      id: id || null,
      fields: Object.keys(sanitized),
    });
  };

  if (project) applySource('project', 'settingsOverrides', project.id, project.settingsOverrides);
  if (session) {
    applySource('session', 'fields', session.id, sessionFieldSettings(session));
    applySource('session', 'settingsOverrides', session.id, session.settingsOverrides);
  }
  if (lane) {
    applySource('lane', 'fields', lane.id, laneFieldSettings(lane));
    applySource('lane', 'settingsOverrides', lane.id, lane.settingsOverrides);
  }
  if (actionOverride) applySource('action', 'oneTimeOverride', null, actionOverride);

  return {
    contractVersion: CONTRACT_VERSION,
    generatedAt: new Date().toISOString(),
    precedence: [
      'global defaults',
      'project settingsOverrides',
      'session fields',
      'session settingsOverrides',
      'lane fields',
      'lane settingsOverrides',
      'one-time action override',
    ],
    scope: {
      projectId: project?.id || null,
      projectSlug: project?.slug || null,
      sessionId: session?.id || null,
      laneId: lane?.id || null,
    },
    sourcesApplied,
    settings,
  };
}
