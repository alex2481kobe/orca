// Durable agent wakeup queue. This is separate from in-app notifications:
// notifications are user-facing read state, while agent events are work items
// that supervisors/orchestrators can drain and acknowledge over MCP/API.

import { randomUUID } from 'node:crypto';
import { nowIso, clonePayload, safeArray } from './registry-utils.js';

const VALID_TARGET_ROLES = new Set(['supervisor', 'orchestrator', 'any']);
const VALID_SEVERITIES = new Set(['info', 'success', 'warning', 'error']);
const MAX_AGENT_QUEUE = 1000;
const MAX_ACKS_PER_EVENT = 64;
const SECRET_KEY_PATTERN = /(token|secret|password|credential|authorization|cookie|api[-_ ]?key|apikey|access[-_ ]?token|refresh[-_ ]?token|bearer|private[-_ ]?key|client[-_ ]?secret|session[-_ ]?token|jwt)/i;
const SECRET_VALUE_PATTERN = /^(bearer\s+|sk[-_]|ghp_|github_pat_|xox[baprs]-|eyj[a-z0-9_-]*\.)/i;

function cleanText(value, fallback = '', max = 500) {
  const text = String(value || fallback || '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ')
    .trim();
  return text.slice(0, max);
}

function normalizeTargetRole(role) {
  const value = cleanText(role, 'orchestrator', 40).toLowerCase();
  return VALID_TARGET_ROLES.has(value) ? value : 'orchestrator';
}

function normalizeSeverity(severity) {
  const value = cleanText(severity, 'info', 20).toLowerCase();
  return VALID_SEVERITIES.has(value) ? value : 'info';
}

function sanitizeMetadata(value, depth = 0) {
  if (depth > 4) return null;
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeMetadata(item, depth + 1));
  }
  if (typeof value === 'object') {
    const output = {};
    for (const [key, entry] of Object.entries(value).slice(0, 100)) {
      const safeKey = cleanText(key, '', 80);
      if (!safeKey || SECRET_KEY_PATTERN.test(safeKey)) continue;
      output[safeKey] = sanitizeMetadata(entry, depth + 1);
    }
    return output;
  }
  if (typeof value === 'string') {
    const text = cleanText(value, '', 1000);
    return SECRET_VALUE_PATTERN.test(text) ? '[redacted]' : text;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  return null;
}

function roleCanSeeEvent(role, event) {
  const caller = cleanText(role, 'dashboard', 40).toLowerCase();
  if (caller === 'dashboard') return true;
  if (caller === 'supervisor') return true;
  if (caller === 'orchestrator') {
    return event.targetRole === 'orchestrator' || event.targetRole === 'any';
  }
  return false;
}

function consumerKey({ role = 'dashboard', actor = 'dashboard' } = {}) {
  return `${cleanText(role, 'dashboard', 40).toLowerCase()}:${cleanText(actor, 'dashboard', 80).toLowerCase()}`;
}

function publicEventForConsumer(event, key) {
  const clone = clonePayload(event);
  const ack = event.acks && typeof event.acks === 'object' ? event.acks[key] : null;
  clone.ackedAt = ack?.ackedAt || null;
  clone.ackedBy = ack?.ackedBy || null;
  delete clone.acks;
  return clone;
}

function normalizeAcks(acks, keepKey = null) {
  if (!acks || typeof acks !== 'object') return {};
  const entries = Object.entries(acks)
    .map(([key, value]) => {
      const safeKey = cleanText(key, '', 140).toLowerCase();
      if (!safeKey || !value || typeof value !== 'object') return null;
      const ackedAt = cleanText(value.ackedAt, '', 40);
      return [safeKey, {
        ackedAt,
        ackedBy: cleanText(value.ackedBy, 'dashboard', 80),
      }];
    })
    .filter(Boolean)
    .sort((a, b) => (Date.parse(b[1].ackedAt) || 0) - (Date.parse(a[1].ackedAt) || 0));
  if (!entries.length) return {};
  let selected = entries.slice(0, MAX_ACKS_PER_EVENT);
  if (keepKey && !selected.some(([key]) => key === keepKey)) {
    const kept = entries.find(([key]) => key === keepKey);
    if (kept) selected = [kept, ...selected.slice(0, MAX_ACKS_PER_EVENT - 1)];
  }
  return Object.fromEntries(selected);
}

export function normalizeAgentQueueForRestore(queue = []) {
  return safeArray(queue)
    .filter((item) => item && typeof item.id === 'string')
    .slice(0, MAX_AGENT_QUEUE)
    .map((event) => ({
      ...event,
      seq: Number.parseInt(event.seq, 10) || 0,
      acks: normalizeAcks(event.acks),
      metadata: sanitizeMetadata(event.metadata) || {},
    }));
}

export const agentQueueMethods = {
  enqueueAgentEvent({
    type = 'agent_event',
    targetRole = 'orchestrator',
    title = 'Agent event',
    body = '',
    severity = 'info',
    actor = 'system',
    projectId = null,
    sessionId = null,
    laneId = null,
    loopId = null,
    taskId = null,
    dedupeKey = null,
    metadata = {},
  } = {}) {
    const normalizedType = cleanText(type, 'agent_event', 80);
    const normalizedRole = normalizeTargetRole(targetRole);
    const normalizedDedupeKey = dedupeKey ? cleanText(dedupeKey, '', 240) : null;
    const now = nowIso();
    if (normalizedDedupeKey) {
      const existing = (this.agentQueue || []).find((event) =>
        !event.ackedAt
        && event.dedupeKey === normalizedDedupeKey
        && event.sessionId === (sessionId || null)
        && event.targetRole === normalizedRole);
      if (existing) {
        existing.updatedAt = now;
        existing.occurrences = Math.min(10_000, (Number.parseInt(existing.occurrences, 10) || 1) + 1);
        existing.lastActor = cleanText(actor, 'system', 80);
        existing.acks = normalizeAcks(existing.acks);
        this.persistState();
        return clonePayload(existing);
      }
    }

    const event = {
      id: randomUUID(),
      seq: safeArray(this.agentQueue)
        .reduce((max, entry) => Math.max(max, Number.parseInt(entry.seq, 10) || 0), 0) + 1,
      createdAt: now,
      updatedAt: now,
      acks: {},
      type: normalizedType,
      targetRole: normalizedRole,
      severity: normalizeSeverity(severity),
      title: cleanText(title, 'Agent event', 160),
      body: cleanText(body, '', 1200),
      actor: cleanText(actor, 'system', 80),
      lastActor: cleanText(actor, 'system', 80),
      projectId: projectId || null,
      sessionId: sessionId || null,
      laneId: laneId || null,
      loopId: loopId || null,
      taskId: taskId || null,
      dedupeKey: normalizedDedupeKey,
      occurrences: 1,
      metadata: sanitizeMetadata(metadata) || {},
    };
    this.agentQueue.unshift(event);
    if (this.agentQueue.length > MAX_AGENT_QUEUE) {
      this.agentQueue.length = MAX_AGENT_QUEUE;
    }
    this.recordAudit({
      type: 'agent_event_enqueued',
      actor: event.actor,
      projectId: event.projectId,
      sessionId: event.sessionId,
      laneId: event.laneId,
      summary: `Agent event queued: ${event.title}`,
      status: event.severity === 'error' ? 'failed' : 'passed',
      evidence: {
        eventId: event.id,
        eventType: event.type,
        targetRole: event.targetRole,
        dedupeKey: event.dedupeKey,
      },
    });
    this.persistState();
    return clonePayload(event);
  },

  listAgentEvents(sessionLocator, {
    role = 'dashboard',
    actor = 'dashboard',
    unackedOnly = true,
    limit = 50,
    type = null,
    afterSeq = null,
  } = {}) {
    const session = this.getSession(sessionLocator);
    if (!session) throw { status: 404, message: 'Session not found.' };
    const max = Math.max(1, Math.min(200, Number.parseInt(limit, 10) || 50));
    const wantedType = type ? cleanText(type, '', 80) : null;
    const key = consumerKey({ role, actor });
    const minSeq = afterSeq === null || afterSeq === undefined
      ? null
      : Math.max(0, Number.parseInt(afterSeq, 10) || 0);
    const events = safeArray(this.agentQueue)
      .filter((event) => event.sessionId === session.id)
      .filter((event) => roleCanSeeEvent(role, event))
      .filter((event) => !unackedOnly || !(event.acks && event.acks[key]))
      .filter((event) => !wantedType || event.type === wantedType)
      .filter((event) => minSeq === null || (Number.parseInt(event.seq, 10) || 0) > minSeq)
      .sort((a, b) => (Number.parseInt(a.seq, 10) || 0) - (Number.parseInt(b.seq, 10) || 0))
      .slice(0, max)
      .map((event) => publicEventForConsumer(event, key));
    const unackedCount = safeArray(this.agentQueue)
      .filter((event) => event.sessionId === session.id)
      .filter((event) => roleCanSeeEvent(role, event))
      .filter((event) => !(event.acks && event.acks[key])).length;
    return {
      sessionId: session.id,
      role: cleanText(role, 'dashboard', 40).toLowerCase(),
      unackedCount,
      events,
    };
  },

  drainAgentEvents(sessionLocator, options = {}) {
    return this.listAgentEvents(sessionLocator, { ...options, unackedOnly: true });
  },

  replayAgentEvents(sessionLocator, options = {}) {
    return this.listAgentEvents(sessionLocator, { ...options, unackedOnly: false });
  },

  ackAgentEvent(eventLocator, {
    actor = 'dashboard',
    role = 'dashboard',
    sessionId = null,
  } = {}) {
    const id = String(eventLocator || '').trim();
    const event = safeArray(this.agentQueue).find((entry) => entry.id === id);
    if (!event) throw { status: 404, message: 'Agent event not found.' };
    if (sessionId && event.sessionId !== sessionId) {
      throw { status: 404, message: 'Agent event not found for this session.' };
    }
    if (!roleCanSeeEvent(role, event)) {
      throw { status: 403, message: 'This role cannot acknowledge that agent event.' };
    }
    const key = consumerKey({ role, actor });
    if (!event.acks || typeof event.acks !== 'object') event.acks = {};
    if (!event.acks[key]) {
      const ackedAt = nowIso();
      event.acks[key] = {
        ackedAt,
        ackedBy: cleanText(actor, 'dashboard', 80),
      };
      event.acks = normalizeAcks(event.acks, key);
      event.updatedAt = ackedAt;
      this.recordAudit({
        type: 'agent_event_acked',
        actor: event.acks[key].ackedBy,
        projectId: event.projectId,
        sessionId: event.sessionId,
        laneId: event.laneId,
        summary: `Agent event acknowledged: ${event.title}`,
        status: 'passed',
        evidence: {
          eventId: event.id,
          eventType: event.type,
          targetRole: event.targetRole,
        },
      });
      this.persistState();
    }
    return publicEventForConsumer(event, key);
  },

  ackAgentEvents(sessionLocator, {
    eventIds = [],
    actor = 'dashboard',
    role = 'dashboard',
  } = {}) {
    const session = this.getSession(sessionLocator);
    if (!session) throw { status: 404, message: 'Session not found.' };
    const ids = safeArray(eventIds).map((id) => String(id || '').trim()).filter(Boolean).slice(0, 200);
    if (!ids.length) throw { status: 422, message: 'Provide at least one event id to acknowledge.' };
    const events = [];
    for (const id of ids) {
      events.push(this.ackAgentEvent(id, { actor, role, sessionId: session.id }));
    }
    return {
      sessionId: session.id,
      acked: events.length,
      events,
    };
  },
};
