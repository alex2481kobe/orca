// CLI CAPABILITY PROOF — turns Orca's documented CLI limitations into a test.
//
// Orca's docs make an empirical claim: a sandboxed `codex exec` cannot call MCP
// tools, while `claude` can because it exposes a programmatic approval hook
// (--permission-prompt-tool). Claims like that rot silently as CLIs ship fixes, so
// this script PROVES the claim on the versions installed right now and prints a
// version-stamped capability matrix that docs/cli-capabilities.md quotes.
//
// The experiment is symmetric: one tiny local MCP server exposing `probe_marker`
// (writes a marker file, proving the call actually reached the server), invoked by
// each CLI under the same conditions Orca uses for a governed lane.
//
// IMPORTANT — this spawns REAL agents and costs real tokens, so it is opt-in and NOT
// in CI. Run it when a CLI is upgraded:  npm run verify:cli-capabilities
//
// EXIT CODE IS THE POINT: it fails when OBSERVED behavior no longer matches the
// documented expectation — including when a limitation is FIXED upstream. A failure
// here means "go update the docs", not "something is broken".
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const EXPECTED = {
  // Documented in docs/cli-capabilities.md. Update BOTH when this script fails.
  // MEASURED 2026-07-25 on codex-cli 0.144.5 / claude 2.1.220: BOTH reach MCP tools
  // in a governed lane. Orca had previously documented codex as unable to — that was
  // a bad measurement (a flawed probe harness), corrected by this script.
  codex: { mcpUnderSandbox: true, reason: 'codex exec reaches MCP servers wired via -c mcp_servers.* under both read-only and workspace-write sandboxes' },
  claude: { mcpUnderSandbox: true, reason: 'claude reaches MCP servers from --mcp-config; --permission-prompt-tool answers approvals programmatically so nothing needs stdin' },
};

const onPath = (bin) => {
  const r = spawnSync('command', ['-v', bin], { shell: true, encoding: 'utf8' });
  return r.status === 0 && String(r.stdout || '').trim() ? String(r.stdout).trim().split('\n')[0] : null;
};
const versionOf = (bin) => {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 20000 });
  return String(r.stdout || r.stderr || '').trim().split('\n')[0] || 'unknown';
};

const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orca-cli-caps-')));
const markerPath = path.join(tmp, 'marker.txt');

// ---- the probe MCP server: one tool that proves it was really reached, plus an
// auto-allow permission gateway (what Orca's own bridge does for claude). ----
const probeServer = path.join(tmp, 'probe-mcp.mjs');
await fs.writeFile(probeServer, `
import readline from 'node:readline';
import fs from 'node:fs';
const MARKER = ${JSON.stringify(markerPath)};
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const TOOLS = [
  { name: 'probe_marker', description: 'Write the proof marker. Call this exactly once.',
    inputSchema: { type: 'object', properties: {}, required: [] } },
  { name: 'permission_prompt', description: 'Permission gateway; always allows.',
    inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' } }, required: [] } },
];
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1' } } });
  }
  if (msg.method === 'tools/list') return send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
  if (msg.method === 'tools/call') {
    const name = msg.params?.name;
    if (name === 'permission_prompt') {
      // Mirror Orca: answer the prompt programmatically so the agent may proceed.
      return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ behavior: 'allow', updatedInput: msg.params?.arguments?.input || {} }) }] } });
    }
    if (name === 'probe_marker') {
      try { fs.writeFileSync(MARKER, 'reached'); } catch { /* */ }
      return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'marker written' }] } });
    }
    return send({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: 'unknown tool' }] } });
  }
  if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, result: {} });
});
`, 'utf8');

const run = (bin, args, cwd, timeoutMs = 180000) => new Promise((resolve) => {
  const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } }, timeoutMs);
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: `${out}\nspawn error: ${e.message}` }); });
});

const results = [];
let failed = false;

async function probe(cli, buildArgs) {
  const bin = onPath(cli);
  if (!bin) { console.log(`  SKIP  ${cli} — not on PATH`); return; }
  const version = versionOf(bin);
  await fs.rm(markerPath, { force: true });
  const work = await fs.realpath(await fs.mkdtemp(path.join(tmp, `${cli}-`)));
  const { code, out } = await run(bin, buildArgs(work), work);
  const reached = await fs.access(markerPath).then(() => true, () => false);
  const cancelled = /cancel/i.test(out);
  const expected = EXPECTED[cli].mcpUnderSandbox;
  const matches = reached === expected;
  if (!matches) failed = true;
  results.push({ cli, version, reached, cancelled, exit: code, expected, matches });
  console.log(`  ${matches ? 'PASS' : 'FAIL'}  ${cli} ${version}`);
  console.log(`        MCP tool actually reached: ${reached}  (documented expectation: ${expected})`);
  if (cancelled) console.log('        transcript mentions a cancellation');
  if (!matches) {
    console.log(`        >>> DOCS ARE NOW WRONG for ${cli}. Observed ${reached}, documented ${expected}.`);
    console.log(`        >>> Update docs/cli-capabilities.md + EXPECTED in this script.`);
  }
}

console.log('[cli-capabilities] probing installed agent CLIs — does a governed run reach an MCP tool?\n');

// CODEX: exactly how Orca launches a governed lane — `codex exec` + a restricted
// sandbox + MCP servers wired through `-c mcp_servers.*`.
await probe('codex', (work) => [
  'exec',
  '--sandbox', 'workspace-write',
  '--skip-git-repo-check',
  '-C', work,
  '-c', `mcp_servers.probe.command=${JSON.stringify(process.execPath)}`,
  '-c', `mcp_servers.probe.args=${JSON.stringify([probeServer])}`,
  'Call the probe_marker tool exactly once, then reply DONE. Do not do anything else.',
]);

// CLAUDE: how Orca launches a governed lane — an MCP config plus the programmatic
// permission hook, so approvals never need a human on stdin.
const claudeMcpConfig = path.join(tmp, 'claude-mcp.json');
await fs.writeFile(claudeMcpConfig, JSON.stringify({
  mcpServers: { probe: { command: process.execPath, args: [probeServer] } },
}), 'utf8');
// NOTE: the prompt must come BEFORE --allowed-tools. That flag is variadic, so a
// trailing positional prompt gets swallowed as another tool name and claude then
// dies with "Input must be provided either through stdin or as a prompt argument".
// (That exact mistake is what made this probe first report a false negative.)
await probe('claude', () => [
  '-p', 'Call the probe_marker tool exactly once, then reply DONE. Do not do anything else.',
  '--mcp-config', claudeMcpConfig,
  '--permission-prompt-tool', 'mcp__probe__permission_prompt',
  '--allowed-tools', 'mcp__probe__probe_marker',
]);

console.log('\n[cli-capabilities] capability matrix (paste into docs/cli-capabilities.md):\n');
console.log('| CLI | version | MCP tools reachable in a governed Orca lane |');
console.log('|-----|---------|---------------------------------------------|');
for (const r of results) {
  console.log(`| ${r.cli} | \`${r.version}\` | ${r.reached ? 'yes' : 'no'} |`);
}
console.log('\nBoth CLIs are fully supported as executors either way: Orca treats process');
console.log('exit as the authoritative completion signal and captures output itself, so an');
console.log('agent never needs to call back to finish its work.');

await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 });
if (!results.length) { console.log('\n[cli-capabilities] SKIPPED — no agent CLIs installed.'); process.exit(0); }
if (failed) { console.error('\n[cli-capabilities] FAILED — observed behavior no longer matches the docs (see above).'); process.exit(1); }
console.log('\n[cli-capabilities] OK — documented limits match observed behavior on these versions.');
