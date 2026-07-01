// Bounded working-memory contract for agent compaction. This is not a chat log:
// each agent writes a concise, structured handoff so compacts/reconnects keep
// the state that matters without growing a second transcript.

import { randomUUID } from 'node:crypto';
import { nowIso, clonePayload, safeArray } from './registry-utils.js';

const CONTRACT_VERSION = 'orca.agent-memory.v2';
const VALID_ROLES = new Set(['supervisor', 'orchestrator', 'executor', 'auditor', 'critique', 'dashboard']);
const ROLE_ALL_READ = new Set(['supervisor', 'orchestrator', 'dashboard']);
const MAX_MEMORY_ENTRIES = 80;
const MAX_SERIALIZED_ENTRY_CHARS = 5000;
const VALID_STATE_PHASES = new Set(['investigating', 'executing', 'handoff', 'blocked', 'done']);
const SECRET_TEXT_PATTERN = /(bearer\s+[A-Za-z0-9._~+/-]+=*|sk[-_][A-Za-z0-9._-]{12,}|ghp_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/gi;

const ARRAY_FIELDS = {
  activeWork: { maxItems: 12, maxChars: 260 },
  decisions: { maxItems: 12, maxChars: 260 },
  blockers: { maxItems: 8, maxChars: 260 },
  nextActions: { maxItems: 12, maxChars: 260 },
  risks: { maxItems: 8, maxChars: 260 },
  futureImplementations: { maxItems: 12, maxChars: 260 },
  openQuestions: { maxItems: 8, maxChars: 260 },
  activeImplementationIds: { maxItems: 12, maxChars: 120 },
};

const TEXT_FIELDS = {
  currentFocus: 800,
  handoffNotes: 1200,
};

const ALLOWED_UPDATE_KEYS = new Set([
  'actor',
  'replace',
  'ifMatch',
  'compactedAt',
  'statePhase',
  ...Object.keys(TEXT_FIELDS),
  ...Object.keys(ARRAY_FIELDS),
]);

function cleanText(value, fallback = '', max = 400) {
  const text = String(value || fallback || '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ')
    .replace(SECRET_TEXT_PATTERN, '[redacted]')
    .trim();
  return text.slice(0, max);
}

function normalizeRole(role) {
  const value = cleanText(role, 'dashboard', 40).toLowerCase();
  return VALID_ROLES.has(value) ? value : 'dashboard';
}

function normalizeActor(actor) {
  return cleanText(actor, 'dashboard', 80).toLowerCase() || 'dashboard';
}

function normalizeLaneId(laneId) {
  return laneId ? cleanText(laneId, '', 120) : null;
}

function memoryKey({ role, actor, laneId = null }) {
  const normalizedRole = normalizeRole(role);
  const normalizedActor = normalizeActor(actor);
  const lanePart = normalizedRole === 'executor' || normalizedRole === 'critique'
    ? `:${normalizeLaneId(laneId) || 'session'}`
    : '';
  return `${normalizedRole}:${normalizedActor}${lanePart}`;
}

function normalizeTextArray(value, { maxItems, maxChars }) {
  const seen = new Set();
  const items = safeArray(value)
    .map((item) => cleanText(item, '', maxChars))
    .filter(Boolean);
  const deduped = [];
  for (const item of items) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped
    .slice(0, maxItems);
}

function normalizeMemoryPatch(payload = {}, previous = {}, { replace = false } = {}) {
  const next = replace ? {} : { ...previous };
  for (const [field, maxChars] of Object.entries(TEXT_FIELDS)) {
    if (payload[field] !== undefined) next[field] = cleanText(payload[field], '', maxChars);
    else if (replace) next[field] = '';
  }
  for (const [field, limits] of Object.entries(ARRAY_FIELDS)) {
    if (payload[field] !== undefined) next[field] = normalizeTextArray(payload[field], limits);
    else if (replace) next[field] = [];
  }
  if (payload.statePhase !== undefined) {
    const phase = cleanText(payload.statePhase, '', 40).toLowerCase();
    next.statePhase = VALID_STATE_PHASES.has(phase) ? phase : '';
  } else if (replace) {
    next.statePhase = '';
  }
  return {
    statePhase: next.statePhase || '',
    currentFocus: next.currentFocus || '',
    activeWork: safeArray(next.activeWork).slice(0, ARRAY_FIELDS.activeWork.maxItems),
    decisions: safeArray(next.decisions).slice(0, ARRAY_FIELDS.decisions.maxItems),
    blockers: safeArray(next.blockers).slice(0, ARRAY_FIELDS.blockers.maxItems),
    nextActions: safeArray(next.nextActions).slice(0, ARRAY_FIELDS.nextActions.maxItems),
    risks: safeArray(next.risks).slice(0, ARRAY_FIELDS.risks.maxItems),
    futureImplementations: safeArray(next.futureImplementations).slice(0, ARRAY_FIELDS.futureImplementations.maxItems),
    openQuestions: safeArray(next.openQuestions).slice(0, ARRAY_FIELDS.openQuestions.maxItems),
    activeImplementationIds: safeArray(next.activeImplementationIds).slice(0, ARRAY_FIELDS.activeImplementationIds.maxItems),
    handoffNotes: next.handoffNotes || '',
  };
}

function hasMemoryContent(entry) {
  return Boolean(entry.statePhase || entry.currentFocus || entry.handoffNotes)
    || Object.keys(ARRAY_FIELDS).some((field) => safeArray(entry[field]).length > 0);
}

function assertKnownPayloadKeys(payload = {}) {
  const unknown = Object.keys(payload || {}).filter((key) => !ALLOWED_UPDATE_KEYS.has(key));
  if (unknown.length) {
    throw {
      status: 422,
      message: `Unknown agent memory field(s): ${unknown.slice(0, 8).join(', ')}.`,
    };
  }
}

function assertCompactBudget(entry) {
  const serialized = JSON.stringify({
    statePhase: entry.statePhase || '',
    currentFocus: entry.currentFocus || '',
    activeWork: safeArray(entry.activeWork),
    decisions: safeArray(entry.decisions),
    blockers: safeArray(entry.blockers),
    nextActions: safeArray(entry.nextActions),
    risks: safeArray(entry.risks),
    futureImplementations: safeArray(entry.futureImplementations),
    openQuestions: safeArray(entry.openQuestions),
    activeImplementationIds: safeArray(entry.activeImplementationIds),
    handoffNotes: entry.handoffNotes || '',
  });
  if (serialized.length > MAX_SERIALIZED_ENTRY_CHARS) {
    throw {
      status: 413,
      message: `Agent memory exceeds the ${MAX_SERIALIZED_ENTRY_CHARS}-character compact budget.`,
    };
  }
}

function publicMemory(entry) {
  return clonePayload({
    version: CONTRACT_VERSION,
    id: entry.id,
    compactId: entry.compactId || null,
    role: entry.role,
    actor: entry.actor,
    laneId: entry.laneId || null,
    updatedAt: entry.updatedAt,
    compactedAt: entry.compactedAt || entry.updatedAt,
    statePhase: entry.statePhase || '',
    currentFocus: entry.currentFocus || '',
    activeWork: safeArray(entry.activeWork),
    decisions: safeArray(entry.decisions),
    blockers: safeArray(entry.blockers),
    nextActions: safeArray(entry.nextActions),
    risks: safeArray(entry.risks),
    futureImplementations: safeArray(entry.futureImplementations),
    openQuestions: safeArray(entry.openQuestions),
    activeImplementationIds: safeArray(entry.activeImplementationIds),
    handoffNotes: entry.handoffNotes || '',
  });
}

export const agentMemoryMethods = {
  listSessionAgentMemory(sessionLocator, {
    role = 'dashboard',
    actor = 'dashboard',
    laneId = null,
    limit = 20,
  } = {}) {
    const session = this.getSession(sessionLocator);
    if (!session) throw { status: 404, message: 'Session not found.' };
    const normalizedRole = normalizeRole(role);
    const normalizedActor = normalizeActor(actor);
    const normalizedLaneId = normalizeLaneId(laneId);
    const key = memoryKey({ role: normalizedRole, actor: normalizedActor, laneId: normalizedLaneId });
    const max = Math.max(1, Math.min(50, Number.parseInt(limit, 10) || 20));
    let entries = safeArray(session.agentMemory)
      .filter((entry) => entry && typeof entry.id === 'string');
    if (!ROLE_ALL_READ.has(normalizedRole)) {
      entries = entries.filter((entry) => entry.id === key);
    }
    entries = entries
      .sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0))
      .slice(0, max)
      .map(publicMemory);
    return {
      version: CONTRACT_VERSION,
      projectId: session.projectId,
      sessionId: session.id,
      role: normalizedRole,
      actor: normalizedActor,
      laneId: normalizedLaneId,
      entries,
    };
  },

  updateSessionAgentMemory(sessionLocator, payload = {}, {
    role = 'dashboard',
    actor = 'dashboard',
    laneId = null,
  } = {}) {
    const session = this.getSession(sessionLocator);
    if (!session) throw { status: 404, message: 'Session not found.' };
    assertKnownPayloadKeys(payload);
    const normalizedRole = normalizeRole(role);
    const normalizedActor = normalizeActor(actor);
    const normalizedLaneId = normalizeLaneId(laneId);
    if ((normalizedRole === 'executor' || normalizedRole === 'critique') && !normalizedLaneId) {
      throw { status: 422, message: `${normalizedRole} memory updates require a lane-scoped lease.` };
    }
    if (normalizedLaneId) {
      const lane = this.getLane(normalizedLaneId);
      if (!lane || lane.sessionId !== session.id) {
        throw { status: 404, message: 'Lane not found for this session.' };
      }
    }
    const key = memoryKey({ role: normalizedRole, actor: normalizedActor, laneId: normalizedLaneId });
    const now = nowIso();
    const source = safeArray(session.agentMemory).filter((entry) => entry && typeof entry.id === 'string');
    const index = source.findIndex((entry) => entry.id === key);
    const previous = index >= 0 ? source[index] : {};
    const ifMatch = cleanText(payload.ifMatch, '', 120);
    if (ifMatch && (!previous.compactId || previous.compactId !== ifMatch)) {
      throw { status: 409, message: 'Agent memory ifMatch is stale.' };
    }
    const replace = payload.replace !== false;
    const normalized = normalizeMemoryPatch(payload, previous, { replace });
    if (!hasMemoryContent(normalized)) {
      throw { status: 422, message: 'Agent memory must include at least one compact state field.' };
    }
    const entry = {
      id: key,
      version: CONTRACT_VERSION,
      compactId: randomUUID(),
      role: normalizedRole,
      actor: normalizedActor,
      laneId: normalizedLaneId,
      sessionId: session.id,
      projectId: session.projectId,
      updatedAt: now,
      compactedAt: payload.compactedAt ? cleanText(payload.compactedAt, now, 40) : now,
      ...normalized,
    };
    assertCompactBudget(entry);
    if (index >= 0) source[index] = entry;
    else source.unshift(entry);
    session.agentMemory = source
      .sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0))
      .slice(0, MAX_MEMORY_ENTRIES);
    session.updatedAt = now;
    this.recordAudit({
      type: 'session_agent_memory_updated',
      actor: normalizedActor,
      projectId: session.projectId,
      sessionId: session.id,
      laneId: normalizedLaneId,
      summary: `Agent memory updated for ${normalizedRole}:${normalizedActor}`,
      status: 'passed',
      evidence: {
        role: normalizedRole,
        laneScoped: Boolean(normalizedLaneId),
        fieldCount: Object.keys(TEXT_FIELDS).filter((field) => entry[field]).length
          + Object.keys(ARRAY_FIELDS).filter((field) => safeArray(entry[field]).length).length,
      },
    });
    this.persistState();
    return this.listSessionAgentMemory(session.id, {
      role: normalizedRole,
      actor: normalizedActor,
      laneId: normalizedLaneId,
      limit: ROLE_ALL_READ.has(normalizedRole) ? 20 : 1,
    });
  },
};
