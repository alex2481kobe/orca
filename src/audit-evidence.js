// Audit evidence points at a lane; it never carries a copy of one.
//
// Audit events used to embed the lane object itself (`evidence: { lane }`). In
// memory that was a LIVE reference, so an event's "evidence" kept changing with
// the lane; on disk every event re-serialized the whole lane, logs and agent
// events included — 300 MB of a 525 MB state file (see
// docs/audits/2026-09-10-state-bloat-diagnosis.md). Nothing ever read it.
//
// An event now records which lane, the state it was in AT THE EVENT, when the
// lane last changed, and a digest of the exact record it saw. The full record
// stays in the lane itself (hot state, or the lane's archive once retired).

import { createHash } from 'node:crypto';

// A lane's bulky streams. Never part of evidence or of the digest: they live in
// the lane's journal files and change on every output line.
export const LANE_STREAM_FIELDS = Object.freeze(['logs', 'agentEvents']);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) out[key] = canonical(value[key]);
    }
    return out;
  }
  return value;
}

export function laneRecordWithoutStreams(lane) {
  const record = {};
  for (const [key, value] of Object.entries(lane || {})) {
    if (!LANE_STREAM_FIELDS.includes(key)) record[key] = value;
  }
  return record;
}

// sha256 over the lane record minus its streams, with keys sorted, so the same
// record hashes the same whether it is the live object, a copy restored from
// state.json, or the one inside a lane archive.
export function laneDigest(lane) {
  const text = JSON.stringify(canonical(JSON.parse(JSON.stringify(laneRecordWithoutStreams(lane)))));
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

const clip = (value, max) => (value === undefined || value === null ? null : String(value).slice(0, max));

// The small, point-in-time view of a lane an audit event keeps.
export function laneEvidenceRef(lane) {
  const source = lane || {};
  return {
    laneRef: {
      id: clip(source.id, 200),
      title: clip(source.title, 240),
      state: clip(source.state, 60),
      auditState: clip(source.auditState, 60),
      executorType: clip(source.executorType, 80),
      updatedAt: clip(source.updatedAt, 40),
      completedAt: clip(source.completedAt, 40),
      exitReason: clip(source.exitReason, 500),
      digest: laneDigest(source),
    },
  };
}

// recordAudit's guard, also used by the v3 -> v4 migration: evidence that still
// carries a lane object has that object replaced by a reference. Anything else
// passes through unchanged.
export function compactAuditEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return evidence;
  const { lane } = evidence;
  if (!lane || typeof lane !== 'object' || Array.isArray(lane)) return evidence;
  const { lane: _embedded, ...rest } = evidence;
  return { ...rest, ...laneEvidenceRef(lane) };
}
