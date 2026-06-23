// Verify the per-lane live terminal stream: connect to GET /api/lanes/:id/stream,
// confirm an initial 'snapshot' of existing terminal.log, then live 'append' frames
// as new bytes are written to the file.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const projectCwd = process.cwd();
const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'orca-lane-stream-'));
process.chdir(stateDir);
process.env.PORT = '0'; process.env.ORCA_HOST = '127.0.0.1';
process.env.ORCA_CREDENTIAL_BACKEND = 'memory'; process.env.ORCA_RATE_LIMIT_DISABLED = 'true';
const sm = await import(path.join(projectCwd, 'src/server.js'));
const { OrcaRegistry } = await import(path.join(projectCwd, 'src/registry.js'));
// The server module has its own registry singleton; we need to drive THAT lane's
// terminal.log. Simplest: create the lane via the server's HTTP API so it's the
// same registry, then write the file at the deterministic path.
const s = await sm.startServer(0, '127.0.0.1');
const base = `http://127.0.0.1:${s.address().port}`;

const project = await fetch(base + '/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Stream Proj', actor: 'test', approved: true }) }).then((r) => r.json());
const session = await fetch(`${base}/api/projects/${project.id}/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Stream Sess', actor: 'test', approved: true }) }).then((r) => r.json());
const lane = await fetch(`${base}/api/sessions/${session.id}/lanes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Stream Lane', executorType: 'mock', actor: 'test', approved: true }) }).then((r) => r.json());

const logPath = path.join(stateDir, 'artifacts', session.id, lane.id, 'terminal.log');
await fsp.mkdir(path.dirname(logPath), { recursive: true });
const initialText = 'INITIAL LINE\n';
await fsp.writeFile(logPath, initialText);

// Connect to the SSE stream and collect frames.
const events = [];
const liveText = Array.from({ length: 620 }, (_, index) => `LIVE-${String(index).padStart(3, '0')}:${'z'.repeat(1000)}\n`).join('');
const res = await fetch(`${base}/api/lanes/${lane.id}/stream`);
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
const readLoop = (async () => {
  for (let i = 0; i < 40; i += 1) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, idx); buffer = buffer.slice(idx + 2);
      const evMatch = frame.match(/^event: (.+)$/m);
      const dataMatch = frame.match(/^data: (.+)$/m);
      if (evMatch) events.push({ event: evMatch[1], data: dataMatch ? JSON.parse(dataMatch[1]) : null });
    }
    const appendText = events.filter((e) => e.event === 'append').map((e) => e.data?.text || '').join('');
    if (events.some((e) => e.event === 'snapshot') && appendText.length >= liveText.length) break;
  }
})();
// After connecting, append more output to the log to trigger a live 'append'.
await new Promise((r) => setTimeout(r, 500));
await fsp.appendFile(logPath, liveText);
await Promise.race([readLoop, new Promise((r) => setTimeout(r, 4000))]);
try { await reader.cancel(); } catch { /* ignore */ }

const snapshot = events.find((e) => e.event === 'snapshot');
const appends = events.filter((e) => e.event === 'append');
let appendOffset = Buffer.byteLength(initialText);
let appendText = '';
let contiguous = appends.length > 0;
for (const append of appends) {
  if (append.data.offset !== appendOffset) contiguous = false;
  if (append.data.bytes !== Buffer.byteLength(append.data.text || '', 'utf8')) contiguous = false;
  if (append.data.bytes > 256 * 1024) contiguous = false;
  appendOffset = append.data.nextOffset;
  appendText += append.data.text || '';
  if (appendText.length >= liveText.length) break;
}
const pass = events.some((e) => e.event === 'stream_open')
  && Boolean(snapshot && snapshot.data.text.includes('INITIAL LINE'))
  && snapshot?.data?.offset === 0
  && snapshot?.data?.nextOffset === Buffer.byteLength(initialText)
  && appends.length >= 3
  && contiguous
  && appendText === liveText
  && appendOffset === Buffer.byteLength(initialText) + Buffer.byteLength(liveText);
console.log(JSON.stringify({
  gotStreamOpen: events.some((e) => e.event === 'stream_open'),
  snapshotHasInitial: Boolean(snapshot && snapshot.data.text.includes('INITIAL LINE')),
  snapshotNextOffset: snapshot?.data?.nextOffset || null,
  appendEvents: appends.length,
  appendBytes: appendText.length,
  appendContiguous: contiguous,
  pass,
}, null, 2));
if (!pass) process.exitCode = 1;
if (sm.stopServer) await sm.stopServer(); await new Promise((r) => s.close(r));
process.exit(process.exitCode || 0);
