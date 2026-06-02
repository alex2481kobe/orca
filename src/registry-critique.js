// Critique (self-verification) + evidence-artifact-clearing methods, as a
// prototype mixin for OrcaRegistry. Extracted from registry.js.

import { randomUUID } from 'node:crypto';
import { LANE_STATES } from './worker-contract.js';
import { nowIso, clonePayload, safeArray } from './registry-utils.js';
import { normalizeCritiqueMode } from './registry-lane-config.js';

const { NEEDS_CRITIQUE: NEEDS_CRITIQUE_STATE, READY_FOR_AUDIT: READY_FOR_AUDIT_STATE } = LANE_STATES;

export const critiqueMethods = {
  critiqueRequiredForLane(lane) {
    return ['required', 'visual-required'].includes(normalizeCritiqueMode(lane?.critiqueMode, 'suggested'));
  },

  critiqueSatisfiedForLane(lane) {
    if (!this.critiqueRequiredForLane(lane)) return true;
    return lane?.critiqueState === 'satisfied' || lane?.critiqueState === 'waived';
  },

  hasFreshVisualEvidence(lane) {
    if (!lane?.lastEvidenceCaptureAt || !lane?.lastEvidence) return false;
    if (lane.completedAt && Date.parse(lane.lastEvidenceCaptureAt) < Date.parse(lane.completedAt)) return false;
    const requested = Array.isArray(lane.lastEvidence.requested) ? lane.lastEvidence.requested : [];
    const produced = Array.isArray(lane.lastEvidence.produced) ? lane.lastEvidence.produced : [];
    const askedForScreenshot = requested.includes('screenshot') || produced.some((item) => String(item || '').includes('screenshot'));
    return askedForScreenshot && !['failed', 'degraded'].includes(String(lane.lastEvidence.status || '').toLowerCase());
  },

  createCritiqueBundle(laneLocator, { actor = 'dashboard' } = {}) {
    const lane = this.getLane(laneLocator);
    if (!lane) throw { status: 404, message: 'Lane not found.' };
    const nonce = randomUUID();
    lane.critiqueNonce = nonce;
    lane.critiqueState = 'in_progress';
    lane.updatedAt = nowIso();
    const bundle = {
      laneId: lane.id,
      sessionId: lane.sessionId,
      projectId: lane.projectId,
      critiqueMode: normalizeCritiqueMode(lane.critiqueMode),
      critiqueRevision: lane.critiqueRevision || 1,
      critiqueNonce: nonce,
      evidenceRequired: lane.critiqueMode === 'visual-required',
      evidenceFresh: lane.critiqueMode === 'visual-required' ? this.hasFreshVisualEvidence(lane) : Boolean(lane.lastEvidence),
      latestEvidence: clonePayload(lane.lastEvidence || null),
      state: lane.state,
      taskPrompt: lane.taskPrompt || '',
      targetUrl: lane.targetUrl || '',
    };
    this.recordAudit({
      type: 'critique_bundle_created',
      actor,
      projectId: lane.projectId,
      sessionId: lane.sessionId,
      laneId: lane.id,
      summary: `Critique bundle created for lane ${lane.title}`,
      status: 'passed',
      evidence: { laneId: lane.id, critiqueMode: lane.critiqueMode, critiqueRevision: bundle.critiqueRevision },
    });
    this.persistState();
    return bundle;
  },

  recordCritiqueFindings(laneLocator, {
    critiqueNonce,
    checksRun = [],
    visualEvidenceReviewed = false,
    issues = [],
    fixes = [],
    risks = [],
    ready = false,
    actor = 'dashboard',
  } = {}) {
    const lane = this.getLane(laneLocator);
    if (!lane) throw { status: 404, message: 'Lane not found.' };
    if (!lane.critiqueNonce || critiqueNonce !== lane.critiqueNonce) {
      throw { status: 409, message: 'Critique findings are stale or missing the current critique nonce.' };
    }
    if (lane.critiqueMode === 'visual-required' && !this.hasFreshVisualEvidence(lane)) {
      throw { status: 409, message: 'Visual-required critique needs fresh screenshot evidence before findings can satisfy the gate.' };
    }
    const finding = {
      id: randomUUID(),
      actor: String(actor || 'dashboard').slice(0, 120),
      recordedAt: nowIso(),
      critiqueRevision: lane.critiqueRevision || 1,
      critiqueNonce,
      checksRun: safeArray(checksRun).map((item) => String(item || '').trim()).filter(Boolean).slice(0, 50),
      visualEvidenceReviewed: Boolean(visualEvidenceReviewed),
      issues: safeArray(issues).map((item) => String(item || '').trim()).filter(Boolean).slice(0, 50),
      fixes: safeArray(fixes).map((item) => String(item || '').trim()).filter(Boolean).slice(0, 50),
      risks: safeArray(risks).map((item) => String(item || '').trim()).filter(Boolean).slice(0, 50),
      ready: Boolean(ready),
    };
    lane.critiqueFindings = [...safeArray(lane.critiqueFindings), finding].slice(-50);
    lane.critiqueState = finding.ready ? 'satisfied' : 'needed';
    lane.critiqueNonce = null;
    if (finding.ready && lane.state === NEEDS_CRITIQUE_STATE) {
      lane.state = READY_FOR_AUDIT_STATE;
    }
    lane.updatedAt = nowIso();
    this.recordAudit({
      type: 'critique_findings_recorded',
      actor: finding.actor,
      projectId: lane.projectId,
      sessionId: lane.sessionId,
      laneId: lane.id,
      summary: `Critique findings recorded for lane ${lane.title}`,
      status: finding.ready ? 'passed' : 'pending',
      evidence: finding,
    });
    this.persistState();
    return { lane: clonePayload(lane), finding: clonePayload(finding) };
  },

  waiveCritique(laneLocator, { reason = '', actor = 'dashboard', approved } = {}) {
    const lane = this.getLane(laneLocator);
    if (!lane) throw { status: 404, message: 'Lane not found.' };
    const policyCheck = this.evaluateActionPolicy('waiveCritique', { actor, approved });
    if (!policyCheck.allowed) {
      throw {
        status: 409,
        message: policyCheck.message,
        requiresApproval: true,
        risk: policyCheck.policy.risk,
      };
    }
    const waiverReason = String(reason || '').trim();
    if (!waiverReason) throw { status: 422, message: 'Critique waiver requires a reason.' };
    lane.critiqueState = 'waived';
    lane.critiqueNonce = null;
    if (lane.state === NEEDS_CRITIQUE_STATE) lane.state = READY_FOR_AUDIT_STATE;
    lane.updatedAt = nowIso();
    const waiver = {
      id: randomUUID(),
      actor: String(actor || 'dashboard').slice(0, 120),
      reason: waiverReason.slice(0, 1000),
      waivedAt: nowIso(),
      critiqueMode: lane.critiqueMode,
      evidenceFresh: this.hasFreshVisualEvidence(lane),
    };
    lane.critiqueFindings = [...safeArray(lane.critiqueFindings), { ...waiver, waived: true }].slice(-50);
    this.recordAudit({
      type: 'critique_waived',
      actor: waiver.actor,
      projectId: lane.projectId,
      sessionId: lane.sessionId,
      laneId: lane.id,
      summary: `Critique waived for lane ${lane.title}`,
      status: 'passed',
      evidence: waiver,
    });
    this.persistState();
    return { lane: clonePayload(lane), waiver };
  },

  async clearLaneEvidenceArtifacts(laneLocator, {
    actor = 'dashboard',
    approved,
  } = {}) {
    const lane = this.getLane(laneLocator);
    if (!lane) {
      throw { status: 404, message: 'Lane not found.' };
    }

    const policyCheck = this.evaluateActionPolicy('clearEvidenceArtifacts', { actor, approved });
    if (!policyCheck.allowed) {
      throw {
        status: 409,
        message: policyCheck.message,
        requiresApproval: true,
        risk: policyCheck.policy.risk,
      };
    }

    const result = await this.evidenceRunner.clearEvidence(lane);
    lane.lastEvidence = null;
    lane.lastEvidenceCaptureAt = null;
    if (result.removed) {
      this.recordAudit({
        type: 'lane_evidence_cleared',
        actor,
        projectId: lane.projectId,
        sessionId: lane.sessionId,
        laneId: lane.id,
        summary: `Evidence artifacts cleared for lane ${lane.title}`,
        evidence: { laneId: lane.id },
        status: 'passed',
      });
      this.appendLaneLog(lane, 'Evidence artifacts cleared.');
    } else {
      this.recordAudit({
        type: 'lane_evidence_cleared',
        actor,
        projectId: lane.projectId,
        sessionId: lane.sessionId,
        laneId: lane.id,
        summary: `No evidence artifacts to clear for lane ${lane.title}`,
        evidence: { laneId: lane.id },
        status: 'passed',
      });
    }

    this.persistState();
    return { removed: result.removed };
  },
};
