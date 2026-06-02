// Live evidence capture (URL-policy validation + Playwright runner orchestration)
// as a prototype mixin for OrcaRegistry. Extracted from registry.js.

import { nowIso } from './registry-utils.js';
import { sanitizeQuickLinkText } from './registry-quick-links.js';
import { validateEvidenceUrl } from './url-policy.js';

export const evidenceCaptureMethods = {
  async captureLaneEvidence(laneLocator, {
    url,
    presetId,
    modes,
    timeoutMs,
    oneTimeUrlApproved = false,
    allowSensitiveCapture = false,
    approved,
    actor = 'dashboard',
  } = {}) {
    const lane = this.getLane(laneLocator);
    if (!lane) {
      throw { status: 404, message: 'Lane not found.' };
    }

    const policyCheck = this.evaluateActionPolicy('captureEvidence', { actor, approved });
    if (!policyCheck.allowed) {
      throw {
        status: 409,
        message: policyCheck.message,
        requiresApproval: true,
        risk: policyCheck.policy.risk,
      };
    }

    const presetList = this.getEvidencePresets(lane.id).presets || [];
    const requestedPresetId = sanitizeQuickLinkText(presetId || '', '', 160);
    if (requestedPresetId && url) {
      throw { status: 422, message: 'Use either presetId or url for evidence capture, not both.' };
    }
    const preset = requestedPresetId
      ? presetList.find((item) => item.id === requestedPresetId)
      : null;
    if (requestedPresetId && !preset) {
      throw { status: 404, message: 'Evidence preset not found.' };
    }
    const allowedUrls = presetList.map((item) => item.url).filter(Boolean);
    const requestedUrl = String(preset?.url || url || presetList[0]?.url || lane.targetUrl || '').trim();
    const networkPolicy = validateEvidenceUrl(requestedUrl, {
      allowedUrls,
      oneTimeApproved: oneTimeUrlApproved,
      allowSensitive: allowSensitiveCapture,
    });

    const result = await this.evidenceRunner.capture(lane, {
      url: networkPolicy.url,
      modes,
      timeoutMs,
      actor,
      networkPolicy,
    });
    lane.lastEvidenceCaptureAt = nowIso();
    lane.lastEvidence = result.evidence || null;

    if (result.captured) {
      this.recordAudit({
        type: 'lane_evidence_captured',
        actor,
        projectId: lane.projectId,
        sessionId: lane.sessionId,
        laneId: lane.id,
        summary: `Evidence captured for lane ${lane.title}`,
        evidence: result.evidence,
        status: 'passed',
      });
      this.appendLaneLog(lane, `Evidence capture completed for ${networkPolicy.url}.`);
    } else {
      this.recordAudit({
        type: 'lane_evidence_failed',
        actor,
        projectId: lane.projectId,
        sessionId: lane.sessionId,
        laneId: lane.id,
        summary: `Evidence capture failed for lane ${lane.title}`,
        evidence: result.evidence || { reason: result.reason || 'Failed to capture evidence.' },
        status: 'failed',
      });
      this.appendLaneLog(lane, `Evidence capture failed: ${result.reason || 'failed'}`);
    }

    this.persistState();
    return result;
  },
};
