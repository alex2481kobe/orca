import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_CAPTURE = ['screenshot'];
const MIME_HINT = {
  screenshot: 'png',
  trace: 'zip',
  video: 'webm',
  log: 'txt',
};
const EVIDENCE_PREFIX = 'evidence-';

function sanitizeMode(value) {
  if (!value || typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (['screenshot', 'trace', 'video', 'log'].includes(normalized)) {
    return normalized;
  }
  return null;
}

function normalizeModes(rawModes) {
  if (!rawModes) return DEFAULT_CAPTURE;
  if (!Array.isArray(rawModes)) {
    const single = sanitizeMode(rawModes);
    return single ? [single] : DEFAULT_CAPTURE;
  }
  const dedup = new Set();
  for (const mode of rawModes) {
    const normalized = sanitizeMode(mode);
    if (normalized) dedup.add(normalized);
  }
  return dedup.size ? [...dedup] : DEFAULT_CAPTURE;
}

function resolveArtifactDir(lane) {
  return path.join(process.cwd(), 'artifacts', lane.sessionId || 'orphan', lane.id);
}

function nowIso() {
  return new Date().toISOString();
}

let _playwrightCache;
async function safeImportPlaywright() {
  if (_playwrightCache !== undefined) return _playwrightCache;
  try {
    _playwrightCache = await import('playwright');
  } catch (error) {
    _playwrightCache = null;
  }
  return _playwrightCache;
}

export async function detectPlaywright() {
  const pw = await safeImportPlaywright();
  return Boolean(pw && pw.chromium);
}

export class PlaywrightEvidenceRunner {
  constructor({
    onLog = async () => {},
    onError = async () => {},
    playwrightCommand = 'playwright',
  } = {}) {
    this.onLog = onLog;
    this.onError = onError;
    this.playwrightCommand = playwrightCommand;
    this._hasPlaywright = null;
  }

  async ensurePlaywrightDetected() {
    if (this._hasPlaywright === null) {
      this._hasPlaywright = await detectPlaywright();
    }
    return this._hasPlaywright;
  }

  hasPlaywright() {
    // Synchronous best-effort: trigger detect if we haven't yet, return cached.
    if (this._hasPlaywright === null) {
      // Fire and forget; first /api/system/blockers call after install picks it up.
      this.ensurePlaywrightDetected().catch(() => {});
      return false;
    }
    return this._hasPlaywright;
  }

  async capture(lane, options = {}) {
    const requestedModes = normalizeModes(options.modes);
    const url = String(options.url || '').trim();
    const timeoutMs = Number.parseInt(options.timeoutMs, 10) || 12000;
    const artifactDir = resolveArtifactDir(lane);
    await fs.mkdir(artifactDir, { recursive: true });
    const now = nowIso();

    const summary = {
      laneId: lane.id,
      sessionId: lane.sessionId,
      projectId: lane.projectId,
      requested: requestedModes,
      url,
      networkPolicy: options.networkPolicy || null,
      sensitivity: options.networkPolicy?.sensitive ? 'sensitive' : 'normal',
      redactionStatus: options.networkPolicy?.sensitive ? 'requires-explicit-approval' : 'not-required',
      startedAt: now,
      commandUsed: this.playwrightCommand,
      produced: [],
    };

    if (!url) {
      summary.error = 'Evidence capture requires a target URL.';
      await safeFire(this.onError, lane, `Evidence capture skipped for lane ${lane.id} due to missing URL.`);
      return { captured: false, reason: summary.error, evidence: summary };
    }

    const playwright = await safeImportPlaywright();
    if (!playwright) {
      // Optional fallback path for environments where Playwright package is intentionally absent.
      const manifestPath = path.join(artifactDir, `evidence-${Date.now()}.json`);
      await fs.writeFile(
        manifestPath,
        JSON.stringify({
          ...summary,
          error: `Playwright package is not installed on this host. Set up Playwright locally and rerun capture.`,
        }, null, 2),
      );
      summary.produced.push(path.basename(manifestPath));
      summary.status = 'degraded';
      summary.error = 'Playwright is not installed in this environment.';
      await safeFire(this.onLog, lane, summary.error);
      return {
        captured: false,
        reason: summary.error,
        evidence: summary,
      };
    }

  const captureFiles = [];
  const captureTimestamp = Date.now();
  const screenshotPath = path.join(artifactDir, `evidence-${captureTimestamp}-shot.png`);
  const tracePath = path.join(artifactDir, `evidence-${captureTimestamp}-trace.zip`);
  const logPath = path.join(artifactDir, `evidence-${captureTimestamp}-log.txt`);

    try {
      const browser = await playwright.chromium.launch({
        headless: true,
      });
      const contextOptions = {};
      const wantsVideo = requestedModes.includes('video');
      const wantsTrace = requestedModes.includes('trace');

      if (wantsVideo) {
        contextOptions.recordVideo = {
          dir: artifactDir,
          size: { width: 1280, height: 720 },
        };
      }
      const wantsScreenshot = requestedModes.includes('screenshot');

      const context = await browser.newContext(contextOptions);
      if (wantsTrace) {
        await context.tracing.start({
          name: `lane-${lane.id}-${captureTimestamp}`,
          screenshots: true,
          snapshots: true,
        });
      }

      const page = await context.newPage();
      await page.goto(url, {
        waitUntil: 'networkidle',
        timeout: timeoutMs,
      });
      await page.setViewportSize({ width: 1366, height: 768 });

      if (wantsScreenshot) {
        const screenshot = await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => null);
        if (screenshot) {
          captureFiles.push(`evidence-${captureTimestamp}-shot.png`);
        }
      }

      if (wantsVideo) {
        const video = page.video();
        if (video) {
          const videoPath = await video.path();
          if (videoPath) {
            captureFiles.push(path.relative(artifactDir, videoPath));
          }
        }
      }

      if (wantsTrace) {
        await context.tracing.stop({ path: tracePath });
        captureFiles.push(`evidence-${captureTimestamp}-trace.zip`);
      }

      await page.close();
      await context.close();
      await browser.close();

      if (!captureFiles.includes(`evidence-${captureTimestamp}-log.txt`)) {
        captureFiles.push(`evidence-${captureTimestamp}-log.txt`);
      }

      const output = {
        ...summary,
        completedAt: nowIso(),
        status: 'captured',
        produced: captureFiles,
        artifactExtensionByMode: {
          screenshot: MIME_HINT.screenshot,
          trace: MIME_HINT.trace,
          video: MIME_HINT.video,
          log: MIME_HINT.log,
        },
      };
      await fs.writeFile(logPath, outputText(output));
      await safeFire(this.onLog, lane, `Evidence captured for ${url}. Modes: ${requestedModes.join(', ')}`);

      return { captured: true, evidence: output, files: captureFiles };
    } catch (error) {
      const failure = {
        ...summary,
        status: 'failed',
        error: error.message || 'Evidence capture failed.',
        completedAt: nowIso(),
      };
      await fs.writeFile(logPath, outputText(failure));
      await safeFire(this.onError, lane, failure.error);
      return {
        captured: false,
        reason: failure.error,
        evidence: failure,
      };
    }
  }

  async clearEvidence(lane) {
    const artifactDir = resolveArtifactDir(lane);
    try {
      const entries = await fs.readdir(artifactDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const name = entry.name;
        if (!name.startsWith(EVIDENCE_PREFIX) && name !== 'outcome.txt' && name !== 'transcript.json') {
          continue;
        }
        await fs.unlink(path.join(artifactDir, name));
      }
    } catch {
      return { removed: false };
    }
    return { removed: true };
  }
}

function outputText(payload) {
  return `${JSON.stringify(payload, null, 2)}
`;
}

function safeFire(callback, ...args) {
  try {
    return Promise.resolve(callback(...args)).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}
