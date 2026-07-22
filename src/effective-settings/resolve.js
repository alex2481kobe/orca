// Effective-settings resolution (merge precedence). Extracted from
// effective-settings.js.

import {
  CONTRACT_VERSION,
  DEFAULT_EFFECTIVE_SETTINGS,
  clonePayload,
  sanitizeSettingsOverrides,
} from './schema.js';

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
  if (session) applySource('session', 'settingsOverrides', session.id, session.settingsOverrides);
  if (lane) applySource('lane', 'settingsOverrides', lane.id, lane.settingsOverrides);
  if (actionOverride) applySource('action', 'oneTimeOverride', null, actionOverride);

  return {
    contractVersion: CONTRACT_VERSION,
    generatedAt: new Date().toISOString(),
    precedence: [
      'global defaults',
      'project settingsOverrides',
      'session settingsOverrides',
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
