import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

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

// lane.sessionId / lane.id are server-generated, but treat them as untrusted
// path segments anyway so a crafted/corrupt lane can never escape artifacts/.
function safePathSegment(value, fallback) {
  const text = String(value || '').trim();
  return /^[A-Za-z0-9._-]{1,128}$/.test(text) && text !== '.' && text !== '..'
    ? text
    : fallback;
}

function resolveArtifactDir(lane) {
  const sessionSeg = safePathSegment(lane.sessionId, 'orphan');
  const laneSeg = safePathSegment(lane.id, 'unknown-lane');
  const root = path.join(process.cwd(), 'artifacts');
  const dir = path.join(root, sessionSeg, laneSeg);
  if (dir !== root && !dir.startsWith(root + path.sep)) {
    throw { status: 400, message: 'Invalid artifact path.' };
  }
  return dir;
}

function nowIso() {
  return new Date().toISOString();
}

let _playwrightCache;
async function safeImportPlaywright() {
  if (_playwrightCache !== undefined) return _playwrightCache;
  // Prefer an on-demand install location (set by the governed capture-setup
  // installer) so the read-only app bundle can stay Playwright-free. Fall back
  // to a normally-resolvable 'playwright' (source/dev installs).
  const onDemandDir = String(process.env.ORCA_PLAYWRIGHT_DIR || '').trim();
  if (onDemandDir) {
    try {
      const entry = path.join(onDemandDir, 'node_modules', 'playwright', 'index.js');
      _playwrightCache = await import(pathToFileURL(entry).href);
      return _playwrightCache;
    } catch {
      // Fall through to the default resolver.
    }
  }
  try {
    _playwrightCache = await import('playwright');
  } catch (error) {
    _playwrightCache = null;
  }
  return _playwrightCache;
}

// Optional system-browser channel (e.g. 'chrome') chosen by capture setup to
// avoid downloading Chromium. Empty => use Playwright's bundled Chromium.
function captureChannel() {
  const channel = String(process.env.ORCA_CAPTURE_CHANNEL || '').trim();
  return /^[a-z-]{1,32}$/.test(channel) ? channel : null;
}

// Native WKWebView capture is advertised by the Tauri shell via env. The shell
// runs a loopback bridge with a shared token; we ask it to snapshot a URL to a
// file. Screenshots only — video/traces stay on Playwright.
function nativeCaptureAvailable() {
  return Boolean(String(process.env.ORCA_NATIVE_CAPTURE_URL || '').trim());
}

// Issue the loopback POST with node:http and `agent: false` so every capture
// opens a fresh socket. The bridge (tiny_http) closes the connection after each
// response; the global fetch/undici pool would otherwise try to reuse that dead
// socket on the next capture and fail with ECONNRESET ("native-error"). A new
// connection per request sidesteps the keep-alive race entirely.
function postCaptureRequest({ endpoint, token, payload, timeoutMs }) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL('/capture', endpoint);
    } catch (error) {
      resolve({ ok: false, reason: `native-error: ${error?.message || 'bad endpoint'}` });
      return;
    }
    const body = Buffer.from(JSON.stringify(payload));
    const req = http.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        agent: false, // fresh socket per request — no keep-alive reuse
        headers: {
          'content-type': 'application/json',
          'content-length': body.length,
          connection: 'close',
          'x-orca-native-token': token,
        },
      },
      (res) => {
        res.resume(); // drain so the socket can close cleanly
        res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode }));
      },
    );
    req.setTimeout(timeoutMs + 3000, () => {
      req.destroy(new Error('native capture request timed out'));
    });
    req.on('error', (error) => {
      const timedOut = error?.message?.includes('timed out');
      resolve({ ok: false, reason: timedOut ? 'native-timeout' : `native-error: ${error?.message || 'request failed'}` });
    });
    req.end(body);
  });
}

async function captureViaNativeBridge({ url, outPath, timeoutMs = 15000 }) {
  const endpoint = String(process.env.ORCA_NATIVE_CAPTURE_URL || '').trim();
  if (!endpoint) return { ok: false, reason: 'native-unavailable' };
  const token = String(process.env.ORCA_NATIVE_CAPTURE_TOKEN || '');
  const result = await postCaptureRequest({
    endpoint,
    token,
    payload: { url, outPath, timeoutMs },
    timeoutMs,
  });
  if (!result.ok) {
    return result.reason ? result : { ok: false, reason: `native-status-${result.status}` };
  }
  try {
    await fs.access(outPath); // the shell writes the PNG; confirm it landed
  } catch {
    return { ok: false, reason: 'native-missing-output' };
  }
  return { ok: true };
}

export async function detectPlaywright() {
  const pw = await safeImportPlaywright();
  if (!pw?.chromium) return false;
  try {
    await fs.access(pw.chromium.executablePath());
    return true;
  } catch {
    return false;
  }
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
