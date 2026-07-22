// Unauthenticated route sweep — the cheap replacement for the deleted
// route-security meta-guard (route-inventory.js). Boots the server WITH an API
// token set (so loopback is NOT auto-trusted as bootstrap admin), then probes
// every /api/* family + /artifacts with NO credentials. The security invariant:
// an unauthenticated caller (a phone with only the tailnet URL, or any attacker
// who reached the port) must never get a 2xx from anything except the two
// intentionally-public endpoints — GET /api/health and GET /api/auth/status.
// Any unauth 2xx elsewhere is a data/host leak and fails the build.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
process.chdir(await fs.mkdtemp(path.join(os.tmpdir(), 'orca-unauth-')));
process.env.PORT = '0';
process.env.ORCA_HOST = '127.0.0.1';
process.env.ORCA_CREDENTIAL_BACKEND = 'memory';
process.env.ORCA_RATE_LIMIT_DISABLED = 'true';
process.env.ORCA_API_TOKEN = 'sweep-secret-token'; // so loopback is NOT bootstrap admin

const sm = await import(path.join(repoRoot, 'src', 'server.js'));
const server = await sm.startServer(0, '127.0.0.1');
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

let failures = 0;
const log = (tag, msg) => console.log(`[unauth-sweep] ${tag} — ${msg}`);
const fail = (msg) => { failures += 1; console.error(`[unauth-sweep FAIL] ${msg}`); };

// { method, path, public? } — public entries must return 2xx; everything else
// must NEVER return 2xx (401/403/404/405 are all acceptable denials).
const PROBES = [
  // intentionally public
  ['GET', '/api/health', true],
  ['GET', '/api/auth/status', true],
  // auth family — protected
  ['GET', '/api/auth/sessions'],
  ['POST', '/api/auth/pairing-codes'],
  ['POST', '/api/auth/logout'],
  ['POST', '/api/auth/pair'], // public route, but with no/invalid code must not 2xx
  // data / host routes — all protected
  ['GET', '/api/overview'],
  ['GET', '/api/projects'],
  ['POST', '/api/projects'],
  ['POST', '/api/orchestrators'],
  ['GET', '/api/orchestrators'],
  // orchestrator container sub-routes (all lease/admin-gated)
  ['GET', '/api/orchestrators/orc-x/status'],
  ['GET', '/api/orchestrators/orc-x/lanes'],
  ['POST', '/api/orchestrators/orc-x/lanes'],
  ['POST', '/api/orchestrators/orc-x/executors'],
  ['POST', '/api/orchestrators/orc-x/resign'],
  ['POST', '/api/orchestrators/orc-x/heartbeat'],
  ['POST', '/api/orchestrators/orc-x/audit-done-lanes'],
  ['GET', '/api/orchestrators/orc-x/events/drain'],
  ['POST', '/api/orchestrators/orc-x/events/ack'],
  ['GET', '/api/orchestrators/orc-x/events/replay'],
  ['POST', '/api/orchestrators/orc-x/emergency-stop'],
  // lane routes — reads AND every mutating write (deny-by-default before lookup)
  ['GET', '/api/lanes/does-not-exist'],
  ['GET', '/api/lanes/does-not-exist/stream'],
  ['GET', '/api/lanes/does-not-exist/terminal-tail'],
  ['POST', '/api/lanes/does-not-exist/terminal-input'],
  ['GET', '/api/lanes/does-not-exist/artifacts'],
  ['GET', '/api/lanes/does-not-exist/artifacts/evidence.png'],
  ['POST', '/api/lanes/does-not-exist/heartbeat'],
  ['POST', '/api/lanes/does-not-exist/submit'],
  ['POST', '/api/lanes/does-not-exist/retry'],
  ['POST', '/api/lanes/does-not-exist/stop'],
  ['DELETE', '/api/lanes/does-not-exist'],
  ['PATCH', '/api/lanes/does-not-exist/controls'],
  ['POST', '/api/lanes/does-not-exist/integrate'],
  ['POST', '/api/lanes/does-not-exist/worktree/discard'],
  ['POST', '/api/lanes/does-not-exist/audit'],
  ['POST', '/api/lanes/does-not-exist/audit/accept'],
  ['POST', '/api/lanes/does-not-exist/audit/request-fix'],
  ['POST', '/api/lanes/does-not-exist/audit/block'],
  ['POST', '/api/lanes/does-not-exist/audit/findings'],
  ['GET', '/api/lanes/does-not-exist/approvals'],
  ['POST', '/api/lanes/does-not-exist/approvals'],
  ['POST', '/api/lanes/does-not-exist/approvals/ap-x/decide'],
  ['POST', '/api/emergency-stop'],
  ['GET', '/api/audit/events'],
  ['POST', '/api/audit/events/ev-x/ack'],
  ['GET', '/api/private-access'],
  ['POST', '/api/private-access/serve'],
  ['GET', '/api/streams/events'],
  ['POST', '/api/mcp'],
  ['GET', '/api/mcp'],
  ['POST', '/api/agent-tools/next-action'],
  ['GET', '/api/policy'],
  ['GET', '/api/system/blockers'],
  ['GET', '/artifacts/any/lane/evidence.json'],
];

for (const [method, p, isPublic] of PROBES) {
  let status;
  try {
    const res = await fetch(base + p, { method, headers: { accept: 'application/json' } });
    status = res.status;
  } catch (error) {
    fail(`${method} ${p} — request threw: ${error.message}`);
    continue;
  }
  const is2xx = status >= 200 && status < 300;
  if (isPublic) {
    if (!is2xx) fail(`${method} ${p} — public route should be 2xx, got ${status}`);
    else log('public', `${method} ${p} → ${status} ok`);
  } else if (is2xx) {
    fail(`${method} ${p} — UNAUTHENTICATED 2xx (${status}) — data/host leak!`);
  } else {
    log('denied', `${method} ${p} → ${status}`);
  }
}

// Also confirm the token DOES work (so we're testing a real gate, not a broken server).
const authed = await fetch(base + '/api/overview', { headers: { authorization: 'Bearer sweep-secret-token', accept: 'application/json' } });
if (authed.status !== 200) fail(`authed GET /api/overview should be 200 with the token, got ${authed.status}`);
else log('control', `authed GET /api/overview → 200 (gate is real)`);

await new Promise((r) => server.close(r));
if (sm.stopServer) await sm.stopServer();

if (failures) { console.error(`[unauth-sweep] ${failures} failure(s)`); process.exit(1); }
console.log('[unauth-sweep] done — no unauthenticated 2xx outside health/status');
