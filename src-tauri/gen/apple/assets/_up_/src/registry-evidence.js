// Evidence file listing + artifact serving methods, as a prototype mixin for
// OrcaRegistry. Extracted from registry.js.

import fs from 'node:fs/promises';
import path from 'node:path';
import { nowIso, isPathWithinBoundary } from './registry-utils.js';
import { effectiveQuickLinkUrl } from './registry-quick-links.js';

function inferEvidenceMode(filename) {
  if (!filename) return null;
  if (filename.endsWith('-shot.png')) return 'screenshot';
  if (filename.endsWith('-trace.zip')) return 'trace';
  if (filename.endsWith('.webm')) return 'video';
  if (filename.endsWith('-log.txt')) return 'log';
  return null;
}

function normalizeEvidenceModeList(mode) {
  if (!mode) return null;
  const normalized = String(mode || '').trim().toLowerCase();
  if (!normalized) return null;
  const mapped = ['screenshot', 'trace', 'video', 'log'].includes(normalized) ? normalized : null;
  return mapped;
}

export const evidenceMethods = {
  async getEvidenceFiles(laneLocator) {
    const lane = this.getLane(laneLocator);
    if (!lane) {
      throw { status: 404, message: 'Lane not found.' };
    }

    const files = await this.listArtifactFiles(lane.id);
    const evidence = [];
    for (const filename of files) {
      if (!filename.startsWith('evidence-') && !filename.endsWith('-log.txt')) {
        continue;
      }
      const mode = inferEvidenceMode(filename);
      if (!mode) continue;
      const filePath = path.join(process.cwd(), 'artifacts', lane.sessionId, lane.id, filename);
      const stats = await fs.stat(filePath);
      evidence.push({
        name: filename,
        mode,
        at: stats.mtime.toISOString(),
        size: stats.size,
        url: `/artifacts/${lane.sessionId}/${lane.id}/${filename}`,
      });
    }
    evidence.sort((left, right) => new Date(right.at) - new Date(left.at));
    return evidence;
  },

  getEvidencePresets(laneLocator) {
    const lane = this.getLane(laneLocator);
    if (!lane) {
      throw { status: 404, message: 'Lane not found.' };
    }
    const project = this.projects.find((item) => item.id === lane.projectId) || null;
    const presets = [];
    if (lane.targetUrl) {
      presets.push({
        id: 'lane-target',
        label: 'Lane target URL',
        url: lane.targetUrl,
        source: 'lane',
        kind: 'target-url',
      });
    }
    if (project) {
      for (const link of project.quickLinks || []) {
        if (!link) continue;
        const presetUrl = effectiveQuickLinkUrl(link, { prefer: 'auto' });
        if (!presetUrl || presetUrl.startsWith('/')) continue;
        presets.push({
          id: `project-link:${link.id}`,
          label: link.label || presetUrl,
          url: presetUrl,
          source: 'project-quick-link',
          kind: link.kind || 'other',
          linkId: link.id,
        });
      }
    }
    return {
      laneId: lane.id,
      sessionId: lane.sessionId,
      presets,
    };
  },

  async getLatestEvidence(laneLocator, { mode = null } = {}) {
    const lane = this.getLane(laneLocator);
    if (!lane) {
      throw { status: 404, message: 'Lane not found.' };
    }
    const requestedMode = normalizeEvidenceModeList(mode);
    const evidenceFiles = await this.getEvidenceFiles(lane.id);
    const result = {
      laneId: lane.id,
      sessionId: lane.sessionId,
      generatedAt: nowIso(),
      files: {},
      requestedMode: requestedMode || 'all',
    };

    const includeAll = !requestedMode;
    if (includeAll) {
      for (const item of evidenceFiles) {
        if (!result.files[item.mode]) {
          result.files[item.mode] = item;
        }
      }
    } else {
      result.files[requestedMode] = evidenceFiles.find((item) => item.mode === requestedMode) || null;
    }
    return result;
  },

  async getArtifactFile(laneLocator, filename) {
    const lane = this.getLane(laneLocator);
    if (!lane) {
      throw { status: 404, message: 'Lane not found.' };
    }

    if (!filename) {
      throw { status: 400, message: 'Invalid artifact filename.' };
    }

    let decoded = filename;
    try {
      decoded = decodeURIComponent(String(filename));
    } catch {
      throw { status: 400, message: 'Invalid artifact filename encoding.' };
    }

    if (
      decoded.includes('\0')
      || decoded.includes('..')
      || decoded.startsWith('/')
      || decoded.startsWith('\\')
      || path.isAbsolute(decoded)
      || /[\\]/.test(decoded)
    ) {
      throw { status: 400, message: 'Invalid artifact filename.' };
    }

    const laneDir = path.join(process.cwd(), 'artifacts', lane.sessionId, lane.id);
    const filePath = path.join(laneDir, decoded);
    if (!isPathWithinBoundary(filePath, laneDir)) {
      throw { status: 400, message: 'Artifact path escapes lane boundary.' };
    }

    let stats;
    try {
      stats = await fs.lstat(filePath);
    } catch (error) {
      const status = error?.code === 'ENOENT' ? 404 : 500;
      throw { status, message: 'Artifact file not found.' };
    }
    if (stats.isSymbolicLink()) {
      throw { status: 400, message: 'Artifact path resolves to a symlink and was refused.' };
    }
    if (!stats.isFile()) {
      throw { status: 404, message: 'Artifact file not found.' };
    }
    // lstat above only inspects the LEAF — an INTERMEDIATE symlink component
    // (plantable by the lane's own agent) could still redirect outside the lane
    // dir. Resolve every component and re-verify containment.
    try {
      const realPath = await fs.realpath(filePath);
      const realLaneDir = await fs.realpath(laneDir);
      if (!isPathWithinBoundary(realPath, realLaneDir)) {
        throw { status: 400, message: 'Artifact path escapes lane boundary.' };
      }
    } catch (error) {
      if (error && error.status) throw error;
      throw { status: 400, message: 'Artifact path could not be resolved.' };
    }

    return {
      lane,
      filePath,
      fullPath: filePath,
    };
  },
};
