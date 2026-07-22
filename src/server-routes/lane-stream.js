// Per-lane LIVE terminal stream (GET /api/lanes/:id/stream) — the "terminal feel"
// for the ONE lane a user has open. Tails that lane's raw terminal.log and pushes
// new bytes over SSE as they arrive, so the focused lane reads like the real
// terminal while the dashboard stays structured + lightweight. It is self-
// authorizing before the JSON gate: operator auth may stream any lane, and scoped
// tool leases may stream only lanes they can read with lane.get.
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { writeSse, streamHeartbeatMs } from '../event-streams.js';

const SNAPSHOT_MAX = 64 * 1024; // last 64KB sent on connect (bounds initial payload)
const READ_MAX = 256 * 1024; // max bytes pushed per poll tick
const POLL_MS = 350;
const MAX_CONCURRENT_LANE_STREAMS = 128; // guard against fd/interval exhaustion

// Number of live lane streams currently holding a persistent FileHandle + poll
// interval. Bounded by MAX_CONCURRENT_LANE_STREAMS so a flood of connections
// can't exhaust file descriptors.
let activeLaneStreams = 0;

export function createLaneStream(deps) {
  const { registry, applySecurityHeaders, setCacheHeaders, sendJson, hasStreamAuth, hasLaneStreamAuth } = deps;

  function laneTerminalLogPath(lane) {
    // Mirror the executor's runtimeDir (cli-adapter.js). lane.id/sessionId come
    // from the registry (not raw URL), so the path can't be traversal-controlled.
    return path.join(process.cwd(), 'artifacts', String(lane.sessionId || 'orphan'), String(lane.id), 'terminal.log');
  }

  // Read the newly-appended bytes from an already-open handle. `fh.stat()` is an
  // fstat on the live descriptor, so it reflects the file's current size as the
  // executor appends. Keeping ONE handle open across ticks avoids the open/stat/
  // close syscall churn that used to run every POLL_MS per connected client. The
  // executor (cli-adapter.js) rotates by truncating terminal.log in place, which
  // shrinks the size on this same inode — so `stat.size < start` still catches a
  // rotation/reset, and the caller closes + reopens the handle against the fresh
  // file. The 256KB per-tick cap and the exact { text, offset, reset } shape are
  // preserved unchanged.
  async function readNewBytes(fh, start, maxLen) {
    const stat = await fh.stat();
    if (stat.size < start) return { text: '', offset: 0, reset: true }; // truncated/rotated
    if (stat.size === start) return { text: '', offset: start, reset: false };
    const len = Math.min(maxLen, stat.size - start);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    return { text: buf.toString('utf8'), offset: start + len, reset: false };
  }

  function handleLaneStream(req, res, laneId) {
    const lane = registry.getLane(laneId);
    const streamAuthorized = () => (typeof hasLaneStreamAuth === 'function'
      ? hasLaneStreamAuth(req, lane || { id: laneId })
      : hasStreamAuth(req));
    if (!streamAuthorized()) {
      return sendJson(res, 401, { error: 'Unauthorized stream. Pair this device, supply a valid token, or use a lane.get tool lease.' });
    }
    if (!lane) return sendJson(res, 404, { error: 'Lane not found.' });
    if (activeLaneStreams >= MAX_CONCURRENT_LANE_STREAMS) {
      return sendJson(res, 503, { error: 'Too many concurrent lane streams. Close an open lane terminal and retry.' });
    }
    const logPath = laneTerminalLogPath(lane);

    res.statusCode = 200;
    applySecurityHeaders(res, req);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    setCacheHeaders(res);
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('X-Orca-Stream', 'lane');
    writeSse(res, 'stream_open', { laneId: lane.id, startedAt: new Date().toISOString() });

    let offset = 0;
    let closed = false;
    let reading = false;
    let pollFh = null; // ONE persistent handle for the poll loop's lifetime
    const heartbeatMs = streamHeartbeatMs();
    let lastHeartbeat = Date.now();

    activeLaneStreams += 1;

    // Drop the persistent poll handle (rotation recovery, error recovery, or
    // teardown). Fire-and-forget close; pollFh is nulled first so the next tick
    // reopens against the current file.
    const dropPollHandle = () => {
      const stale = pollFh;
      pollFh = null;
      if (stale) stale.close().catch(() => {});
    };

    const cleanup = () => {
      if (closed) return; // idempotent: registered on both res.close and req.close
      closed = true;
      clearInterval(interval);
      dropPollHandle();
      activeLaneStreams -= 1;
    };

    // Initial snapshot: the tail of whatever already exists (file may not exist yet
    // if the lane is still queued — that's fine, we start at 0 and tail as it grows).
    (async () => {
      try {
        const fh = await fsp.open(logPath, 'r');
        const stat = await fh.stat();
        const start = Math.max(0, stat.size - SNAPSHOT_MAX);
        const len = stat.size - start;
        const buf = Buffer.alloc(len);
        if (len > 0) await fh.read(buf, 0, len, start);
        await fh.close().catch(() => {});
        offset = stat.size;
        if (!closed) writeSse(res, 'snapshot', {
          text: buf.toString('utf8'),
          truncated: start > 0,
          offset: start,
          nextOffset: stat.size,
          size: stat.size,
        });
      } catch {
        if (!closed) writeSse(res, 'snapshot', {
          text: '',
          truncated: false,
          offset: 0,
          nextOffset: 0,
          size: 0,
        });
      }
    })();

    const interval = setInterval(async () => {
      if (closed || reading) return;
      if (!streamAuthorized()) { writeSse(res, 'stream_close', { reason: 'auth_revoked' }); cleanup(); try { res.end(); } catch { /* ignore */ } return; }
      reading = true;
      try {
        // Lazily (re)open the persistent handle. The file may not exist yet if the
        // lane is still queued — open() throws, we swallow it, and retry next tick.
        if (!pollFh) pollFh = await fsp.open(logPath, 'r');
        const startOffset = offset;
        const { text, offset: next, reset } = await readNewBytes(pollFh, offset, READ_MAX);
        if (reset) {
          // Rotation / in-place truncation: rewind to 0 and reopen against the
          // fresh file (the current handle may point at the pre-truncation inode).
          offset = 0;
          dropPollHandle();
        } else if (text) {
          offset = next;
          if (!closed) writeSse(res, 'append', {
            text,
            offset: startOffset,
            nextOffset: next,
            bytes: Buffer.byteLength(text, 'utf8'),
          });
        }
        if (!closed && Date.now() - lastHeartbeat >= heartbeatMs) {
          lastHeartbeat = Date.now();
          writeSse(res, 'heartbeat', { at: new Date().toISOString() });
        }
      } catch {
        // File not ready / transient read error — drop the (possibly bad) handle
        // so we reopen cleanly next tick, matching the old open-per-tick recovery.
        dropPollHandle();
      } finally { reading = false; }
    }, POLL_MS);
    if (typeof interval.unref === 'function') interval.unref();
    if (typeof res.on === 'function') res.on('close', cleanup);
    if (typeof req.on === 'function') req.on('close', cleanup);
    return undefined;
  }

  return { handleLaneStream };
}
