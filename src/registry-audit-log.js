// Audit-event recording/query + per-lane log & agent-event appenders
// (with growth caps) as a prototype mixin for OrcaRegistry.

import { randomUUID } from 'node:crypto';
import { nowIso, clonePayload } from './registry-utils.js';
import { compactAuditEvidence } from './audit-evidence.js';

import { MAX_AGENT_EVENT_ENTRIES, MAX_LANE_LOG_ENTRIES } from './registry-lane-journal.js';
import { MAX_RESULT_CONTENT, applyLaneResult } from './lane-result.js';

// Routine event lines stay cheap; the events that CARRY a lane's final report
// get the result budget, so storing an event is never what cuts the report.
const MAX_EVENT_CONTENT = 12000;
const RESULT_EVENT_TYPES = new Set(['message.assistant.final', 'agent.done']);
const eventContentCap = (type) => (RESULT_EVENT_TYPES.has(String(type)) ? MAX_RESULT_CONTENT : MAX_EVENT_CONTENT);

function isOrchestratorStartStub(value) {
  return /^Started\s+.+\s+orchestrator lane\s+"/i.test(String(value || '').trim());
}

function isGenericCompletionText(value, lane) {
  const text = String(value || '').trim().toLowerCase();
  const executor = String(lane?.executorType || '').trim().toLowerCase();
  return !text
    || text === 'agent completed'
    || text === `${executor} execution completed`
    || text.endsWith(' execution completed')
    || text.includes('self-verification required before audit');
}

function boundedObject(value, maxBytes = 2000) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const text = JSON.stringify(value);
    if (!text || text.length > maxBytes) return null;
    return clonePayload(value);
  } catch {
    return null;
  }
}

function promoteOrchestratorThreadOutput(registry, lane, agentEvent, now) {
  if (String(lane?.owner || '') !== 'orchestrator') return;
  const session = typeof registry.getSession === 'function' ? registry.getSession(lane.sessionId) : null;
  const thread = session?.orchestratorThread;
  if (!thread || !Array.isArray(thread.messages)) return;

  let message = [...thread.messages].reverse()
    .find((entry) => entry && entry.role === 'assistant' && entry.laneId === lane.id);
  if (!message) {
    message = {
      id: randomUUID(),
      role: 'assistant',
      content: '',
      laneId: lane.id,
      createdAt: now,
    };
    thread.messages.push(message);
  }

  const type = String(agentEvent.type || '');
  const content = String(agentEvent.content || '').trim();
  const current = String(message.content || '');
  const currentIsStub = isOrchestratorStartStub(current);
  let nextContent = '';

  if ((type === 'message.assistant.final' || type === 'message.assistant.delta') && content) {
    nextContent = type === 'message.assistant.final'
      ? content
      : `${currentIsStub ? '' : current}${content}`;
  } else if (type === 'agent.done' && content && (currentIsStub || !current) && !isGenericCompletionText(content, lane)) {
    nextContent = content;
  } else if (type === 'error' && content) {
    nextContent = currentIsStub || !current ? `Error: ${content}` : `${current}\n\nError: ${content}`;
  }

  if (!nextContent || nextContent === current) return;
  message.content = nextContent.slice(0, MAX_EVENT_CONTENT);
  message.updatedAt = now;
  thread.updatedAt = now;
}

export const auditLogMethods = {
  appendLaneLog(lane, message, { persist = false } = {}) {
    if (!lane || !message) return;
    // A lane restored from disk loads its journal before it grows.
    this.ensureLaneStreams(lane);
    lane.logs.push({
      at: nowIso(),
      message,
    });
    // Cap per-lane log growth so a chatty/long-running lane can't grow state.json
    // (and every transcript write) without bound.
    if (lane.logs.length > MAX_LANE_LOG_ENTRIES) {
      // The cap bounds memory, not the record: journal a line before the cap can
      // drop it, even when more than the cap arrives between debounced flushes.
      if (!this._journaled.has(lane.logs[0])) this._flushLaneJournals();
      lane.logs = lane.logs.slice(-MAX_LANE_LOG_ENTRIES);
    }
    lane.updatedAt = nowIso();
    this._streamRevision = (this._streamRevision || 0) + 1;
    this._scheduleJournalFlush();
    if (!this._starting && persist) {
      this.persistState();
    }
  },

  appendLaneAgentEvent(lane, agentEvent, { persist = false } = {}) {
    if (!lane || !agentEvent || typeof agentEvent !== 'object') return;
    this.ensureLaneStreams(lane);
    const now = nowIso();
    // Any agent output/tool activity keeps the lane's idle-shutdown clock fresh.
    lane.lastActivityAt = now;
    const usage = boundedObject(agentEvent.usage || agentEvent.stats || agentEvent.tokens);
    lane.agentEvents.push({
      id: randomUUID(),
      at: now,
      source: String(agentEvent.source || lane.executorType || 'agent').slice(0, 80),
      type: String(agentEvent.type || 'event').slice(0, 120),
      title: agentEvent.title ? String(agentEvent.title).slice(0, 240) : '',
      content: agentEvent.content ? String(agentEvent.content).slice(0, eventContentCap(agentEvent.type)) : '',
      stream: agentEvent.stream ? String(agentEvent.stream).slice(0, 40) : '',
      command: agentEvent.command ? String(agentEvent.command).slice(0, 2000) : '',
      toolName: agentEvent.toolName ? String(agentEvent.toolName).slice(0, 160) : '',
      callId: agentEvent.callId ? String(agentEvent.callId).slice(0, 160) : '',
      externalSessionId: agentEvent.externalSessionId ? String(agentEvent.externalSessionId).slice(0, 200) : '',
      durationMs: Number.isFinite(agentEvent.durationMs) ? agentEvent.durationMs : null,
      ...(usage ? { usage } : {}),
    });
    if (lane.agentEvents.length > MAX_AGENT_EVENT_ENTRIES) {
      if (!this._journaled.has(lane.agentEvents[0])) this._flushLaneJournals();
      lane.agentEvents = lane.agentEvents.slice(-MAX_AGENT_EVENT_ENTRIES);
    }
    // Promote the agent's final assistant message (parsed from the executor's
    // stream-json / json result by the event normalizer) to a first-class lane
    // field, so the orchestrator/audit see the actual outcome — not just exit code
    // + raw logs. Last final message wins; uniform across all executor types.
    if (agentEvent.type === 'message.assistant.final' && agentEvent.content) {
      // The whole report goes to the lane's result.txt artifact; what stays on
      // the record is capped, and SAYS SO when it was cut (src/lane-result.js).
      const fullText = applyLaneResult(lane, agentEvent.content, now);
      if (typeof this.writeLaneResultArtifact === 'function') {
        this._trackAsync?.(this.writeLaneResultArtifact(lane, fullText).catch(() => {}));
      }
      if (lane.resultTruncated) {
        // appendLaneLog, not a raw push: the entry must obey the per-lane cap and
        // reach the journal like every other line.
        this.appendLaneLog(lane, `[orca] result truncated for storage: ${lane.resultFullLength} chars captured, first ${MAX_RESULT_CONTENT} kept on the lane; full text in the ${lane.resultArtifact} artifact.`);
      }
      if (usage) lane.tokenUsage = usage;
    } else if (agentEvent.type === 'agent.done' && usage) {
      lane.tokenUsage = usage;
    }
    promoteOrchestratorThreadOutput(this, lane, agentEvent, now);
    lane.updatedAt = now;
    this._streamRevision = (this._streamRevision || 0) + 1;
    this._scheduleJournalFlush();
    if (!this._starting && persist) {
      this.persistState();
    }
  },

  recordAudit(event) {
    const record = {
      id: randomUUID(),
      createdAt: nowIso(),
      status: event.status || 'pending',
      followUpQueued: event.followUpQueued || false,
      ...event,
    };
    // Evidence references a lane; it never embeds one (see audit-evidence.js).
    if (record.evidence) record.evidence = compactAuditEvidence(record.evidence);
    this.auditEvents.unshift(record);
    if (this.auditEvents.length > 200) {
      this.auditEvents.pop();
    }
    this.persistState();
    return record.id;
  },

  listAuditEvents({ status, sessionId, laneId } = {}) {
    let events = this.auditEvents;
    if (status) {
      events = events.filter((event) => event.status === status);
    }
    if (sessionId !== undefined) {
      const matchSessionId = String(sessionId);
      events = events.filter((event) => String(event.sessionId) === matchSessionId);
    }
    if (laneId !== undefined) {
      const matchLaneId = String(laneId);
      events = events.filter((event) => String(event.laneId) === matchLaneId);
    }
    return clonePayload(events);
  },

  acknowledgeAuditEvent(eventId, {
    actor = 'dashboard',
    notes,
  } = {}) {
    const event = this.auditEvents.find((item) => item.id === eventId);
    if (!event) {
      throw { status: 404, message: 'Audit event not found.' };
    }
    if (event.status !== 'pending') {
      throw {
        status: 409,
        message: `Audit event already ${event.status}; only pending events can be acknowledged.`,
      };
    }

    event.status = 'passed';
    event.reviewedBy = actor;
    event.reviewedAt = nowIso();
    if (notes) event.reviewNotes = notes;

    this.recordAudit({
      type: 'audit_event_acknowledged',
      actor,
      projectId: event.projectId,
      sessionId: event.sessionId,
      laneId: event.laneId,
      summary: `Audit event acknowledged for ${event.type}`,
      evidence: { sourceEventId: event.id },
      status: 'passed',
    });

    this.persistState();
    return clonePayload(event);
  },
};
