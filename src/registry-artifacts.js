// Static artifact file serving with fail-closed path resolution, as a prototype
// mixin for OrcaRegistry. Preserved from the removed evidence module because the
// operator-gated static file server (server-routes/static-server.js) still serves
// lane artifact files (logs, attachments) and MUST keep its traversal/symlink guards.

import fs from 'node:fs/promises';
import path from 'node:path';
import { isPathWithinBoundary } from './registry-utils.js';

export const artifactMethods = {
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
