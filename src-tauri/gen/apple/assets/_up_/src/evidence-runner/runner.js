// Playwright/native evidence capture runner. Extracted from evidence-runner.js.

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  normalizeModes,
  resolveArtifactDir,
  nowIso,
  safeImportPlaywright,
  captureChannel,
  nativeCaptureAvailable,
  captureViaNativeBridge,
  detectPlaywright,
  outputText,
  safeFire,
  EVIDENCE_PREFIX,
  MIME_HINT,
} from './native-bridge.js';

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

    // Defense in depth: callers (registry) validate the URL via url-policy before
    // reaching here, but refuse non-http(s) schemes outright so a file:// /
    // chrome:// / data: URL can never reach Playwright or the native bridge
    // (local-file read / scheme-abuse vector) even if a caller forgets to validate.
    if (!/^https?:\/\//i.test(url)) {
      summary.error = 'Evidence capture only supports http(s) URLs.';
      await safeFire(this.onError, lane, `Evidence capture refused non-http(s) URL for lane ${lane.id}.`);
      return { captured: false, reason: summary.error, evidence: summary };
    }

    // Native WKWebView fast-path (macOS desktop app): screenshots only. Falls
    // through to Playwright for video/traces or if the native bridge fails.
    const onlyScreenshot = requestedModes.length === 1 && requestedModes[0] === 'screenshot';
    if (onlyScreenshot && nativeCaptureAvailable()) {
      const nativeTimestamp = Date.now();
      const nativeShotRel = `${EVIDENCE_PREFIX}${nativeTimestamp}-shot.png`;
      const nativeShotPath = path.join(artifactDir, nativeShotRel);
      const nativeLogRel = `${EVIDENCE_PREFIX}${nativeTimestamp}-log.txt`;
      const nativeLogPath = path.join(artifactDir, nativeLogRel);
      const native = await captureViaNativeBridge({ url, outPath: nativeShotPath, timeoutMs });
      if (native.ok) {
        const output = {
          ...summary,
          completedAt: nowIso(),
          status: 'captured',
          backend: 'native-webview',
          produced: [nativeShotRel, nativeLogRel],
          artifactExtensionByMode: { screenshot: MIME_HINT.screenshot },
        };
        await fs.writeFile(nativeLogPath, outputText(output));
        await safeFire(this.onLog, lane, `Evidence captured for ${url} via native webview.`);
        return { captured: true, evidence: output, files: output.produced };
      }
      await safeFire(this.onLog, lane, `Native capture unavailable (${native.reason}); falling back to Playwright.`);
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

    let browser = null;
    try {
      const channel = captureChannel();
      browser = await playwright.chromium.launch({
        headless: true,
        ...(channel ? { channel } : {}),
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
      let videoRelPath = null;
      try {
        if (wantsTrace) {
          await context.tracing.start({
            name: `lane-${lane.id}-${captureTimestamp}`,
            screenshots: true,
            snapshots: true,
          });
        }

        const page = await context.newPage();
        await page.setViewportSize({ width: 1366, height: 768 });
        await page.goto(url, {
          waitUntil: 'networkidle',
          timeout: timeoutMs,
        });

        if (wantsScreenshot) {
          const screenshot = await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => null);
          if (screenshot) {
            captureFiles.push(`evidence-${captureTimestamp}-shot.png`);
          }
        }

        if (wantsTrace) {
          await context.tracing.stop({ path: tracePath });
          captureFiles.push(`evidence-${captureTimestamp}-trace.zip`);
        }

        // Video is finalized when the page closes; read its path afterwards.
        const video = wantsVideo ? page.video() : null;
        await page.close();
        if (video) {
          const videoPath = await video.path().catch(() => null);
          if (videoPath) videoRelPath = path.relative(artifactDir, videoPath);
        }
      } finally {
        await context.close().catch(() => {});
      }
      if (videoRelPath) captureFiles.push(videoRelPath);

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
    } finally {
      // Always release the browser process, even if goto/screenshot/trace threw.
      if (browser) await browser.close().catch(() => {});
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
