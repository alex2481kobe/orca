import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const serverEntry = path.join(root, 'src', 'server.js');
const orcaAgentPath = path.join(root, 'scripts', 'orca-agent.mjs');
let importCounter = 0;

async function withRealOrcaServer(callback) {
  const previousCwd = process.cwd();
  const previousEnv = { ...process.env };
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-agent-cli-'));
  process.chdir(tempDir);
  process.env.ORCA_API_TOKEN = 'orca-agent-cli-token';
  process.env.ORCA_AUTO_AUDIT = 'false';
  process.env.ORCA_RATE_LIMIT_DISABLED = 'true';
  process.env.PORT = '0';
  process.env.ORCA_HOST = '127.0.0.1';
  const moduleUrl = `${pathToFileURL(serverEntry).href}?orca-agent-cli=${Date.now()}-${++importCounter}`;
  const { startServer, stopServer } = await import(moduleUrl);
  const server = await startServer(0, '127.0.0.1');
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const requestJson = async (requestPath, { method = 'GET', token = process.env.ORCA_API_TOKEN, headers = {}, body } = {}) => {
    const nextHeaders = { accept: 'application/json', ...headers };
    if (token) nextHeaders['x-orca-token'] = token;
    const init = { method, headers: nextHeaders };
    if (body !== undefined) {
      nextHeaders['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const response = await fetch(`${baseUrl}${requestPath}`, init);
    const raw = await response.text();
    let parsed = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = { raw }; }
    return { status: response.status, body: parsed };
  };

  try {
    await callback({ baseUrl, requestJson, token: process.env.ORCA_API_TOKEN, tempDir });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (typeof stopServer === 'function') await stopServer();
    for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
    for (const [key, value] of Object.entries(previousEnv)) process.env[key] = value;
    process.chdir(previousCwd);
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
}

function runOrcaAgent(args, env, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [orcaAgentPath, ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`orca-agent timed out: ${args.join(' ')}`));
    }, 8000);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    if (typeof options.onSpawn === 'function') {
      try { options.onSpawn(child); } catch (error) {
        child.kill();
        clearTimeout(timer);
        reject(error);
      }
    }
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function runGit(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

test('orca-agent start cold-starts a companion project, session, and orchestrator owner', async () => {
  await withRealOrcaServer(async ({ baseUrl, requestJson, token, tempDir }) => {
    const env = {
      HOME: tempDir,
      ORCA_AGENT_TOOLS_BASE_URL: baseUrl,
      ORCA_API_TOKEN: token,
      ORCA_TOOL_LEASE_TOKEN: '',
    };

    const started = await runOrcaAgent(['start', 'Cold start run', '--leader', 'mock', '--cap', '2'], env);
    assert.equal(started.code, 0, started.stderr);
    const body = JSON.parse(started.stdout);
    assert.ok(body.sessionId);
    assert.ok(body.project);
    assert.match(body.next, new RegExp(`orca-agent bulk-add ${body.sessionId}`));

    const projects = await requestJson('/api/projects');
    assert.equal(projects.status, 200);
    assert.equal(projects.body.length, 1);
    assert.equal(projects.body[0].id, body.project);
    assert.equal(projects.body[0].name, 'Companion Runs');

    const sessions = await requestJson(`/api/projects/${body.project}/sessions`);
    assert.equal(sessions.status, 200);
    assert.equal(sessions.body.length, 1);
    assert.equal(sessions.body[0].id, body.sessionId);
    assert.equal(sessions.body[0].name, 'Cold start run');
    assert.equal(sessions.body[0].spawnPolicy, 'auto');
    assert.equal(sessions.body[0].approvedCapacity, 2);

    const status = await requestJson(`/api/sessions/${body.sessionId}/orchestrator/status`);
    assert.equal(status.status, 200);
    assert.equal(status.body.activeOrchestrator.actor, 'orca-agent-orchestrator');
  });
});

test('orca-agent tail reads bounded lane output and enforces session-scoped leases', async () => {
  await withRealOrcaServer(async ({ baseUrl, requestJson, token, tempDir }) => {
    const project = await requestJson('/api/projects', {
      method: 'POST',
      body: { name: 'Orca Agent CLI Project', approved: true },
    });
    assert.equal(project.status, 201);
    const hiddenProject = await requestJson('/api/projects', {
      method: 'POST',
      body: { name: 'Hidden Orca Agent CLI Project', approved: true },
    });
    assert.equal(hiddenProject.status, 201);
    const session = await requestJson(`/api/projects/${project.body.id}/sessions`, {
      method: 'POST',
      body: { name: 'Orca Agent CLI Session', approved: true },
    });
    assert.equal(session.status, 201);
    const otherSession = await requestJson(`/api/projects/${project.body.id}/sessions`, {
      method: 'POST',
      body: { name: 'Other CLI Session', approved: true },
    });
    assert.equal(otherSession.status, 201);
    const lane = await requestJson(`/api/sessions/${session.body.id}/lanes`, {
      method: 'POST',
      body: { title: 'CLI visible lane', executorType: 'mock', approved: true },
    });
    assert.equal(lane.status, 201);

    const logDir = path.join(process.cwd(), 'artifacts', session.body.id, lane.body.id);
    await fs.mkdir(logDir, { recursive: true });
    await fs.writeFile(path.join(logDir, 'terminal.log'), 'CLI INITIAL OUTPUT\nCLI LIVE OUTPUT\n');

    const lease = await requestJson('/api/agent-tools/leases', {
      method: 'POST',
      body: {
        actor: 'orca-agent-cli-supervisor',
        role: 'supervisor',
        projectId: project.body.id,
        sessionId: session.body.id,
        ttlMs: 10 * 60 * 1000,
      },
    });
    assert.equal(lease.status, 201);

    const env = {
      HOME: tempDir,
      ORCA_AGENT_TOOLS_BASE_URL: baseUrl,
      ORCA_TOOL_LEASE_TOKEN: lease.body.leaseToken,
      ORCA_API_TOKEN: token,
    };
    const projects = await runOrcaAgent(['projects'], env);
    assert.equal(projects.code, 0, projects.stderr);
    assert.deepEqual(JSON.parse(projects.stdout).map((item) => item.id), [project.body.id]);

    const result = await runOrcaAgent(['tail', lane.body.id, '--max-bytes', '4096'], env);
    assert.equal(result.code, 0, result.stderr);
    const tail = JSON.parse(result.stdout);
    assert.equal(tail.laneId, lane.body.id);
    assert.equal(tail.text.includes('CLI LIVE OUTPUT'), true);
    assert.equal(tail.eof, true);

    const incremental = await runOrcaAgent(['tail', lane.body.id, '--offset', '4', '--max-bytes', '7'], env);
    assert.equal(incremental.code, 0, incremental.stderr);
    assert.equal(JSON.parse(incremental.stdout).text, 'INITIAL');

    const wrongLease = await requestJson('/api/agent-tools/leases', {
      method: 'POST',
      body: {
        actor: 'wrong-cli-supervisor',
        role: 'supervisor',
        projectId: project.body.id,
        sessionId: otherSession.body.id,
        ttlMs: 10 * 60 * 1000,
      },
    });
    assert.equal(wrongLease.status, 201);
    const denied = await runOrcaAgent(['tail', lane.body.id, '--max-bytes', '4096'], {
      ...env,
      ORCA_TOOL_LEASE_TOKEN: wrongLease.body.leaseToken,
    });
    assert.equal(denied.code, 2);
    assert.match(denied.stderr, /Tool lease session mismatch/);
  });
});

test('orca-agent aggregate watches stream all visible worker lanes without crossing scope', async () => {
  await withRealOrcaServer(async ({ baseUrl, requestJson, token, tempDir }) => {
    const project = await requestJson('/api/projects', {
      method: 'POST',
      body: { name: 'Aggregate Watch Project', approved: true },
    });
    assert.equal(project.status, 201);
    const hiddenProject = await requestJson('/api/projects', {
      method: 'POST',
      body: { name: 'Hidden Aggregate Watch Project', approved: true },
    });
    assert.equal(hiddenProject.status, 201);
    const session = await requestJson(`/api/projects/${project.body.id}/sessions`, {
      method: 'POST',
      body: { name: 'Aggregate Watch Session', approved: true },
    });
    assert.equal(session.status, 201);
    const hiddenSession = await requestJson(`/api/projects/${hiddenProject.body.id}/sessions`, {
      method: 'POST',
      body: { name: 'Hidden Aggregate Watch Session', approved: true },
    });
    assert.equal(hiddenSession.status, 201);

    const laneOne = await requestJson(`/api/sessions/${session.body.id}/lanes`, {
      method: 'POST',
      body: { title: 'Aggregate lane one', executorType: 'mock', approved: true },
    });
    const laneTwo = await requestJson(`/api/sessions/${session.body.id}/lanes`, {
      method: 'POST',
      body: { title: 'Aggregate lane two', executorType: 'mock', approved: true },
    });
    const doneLane = await requestJson(`/api/sessions/${session.body.id}/lanes`, {
      method: 'POST',
      body: { title: 'Aggregate accepted lane', executorType: 'mock', approved: true },
    });
    const hiddenLane = await requestJson(`/api/sessions/${hiddenSession.body.id}/lanes`, {
      method: 'POST',
      body: { title: 'Hidden aggregate lane', executorType: 'mock', approved: true },
    });
    assert.equal(laneOne.status, 201);
    assert.equal(laneTwo.status, 201);
    assert.equal(doneLane.status, 201);
    assert.equal(hiddenLane.status, 201);

    const logPath = async (lane) => {
      const logDir = path.join(process.cwd(), 'artifacts', lane.sessionId, lane.id);
      await fs.mkdir(logDir, { recursive: true });
      return path.join(logDir, 'terminal.log');
    };
    const oneLog = await logPath(laneOne.body);
    const twoLog = await logPath(laneTwo.body);
    const doneLog = await logPath(doneLane.body);
    const hiddenLog = await logPath(hiddenLane.body);
    await fs.writeFile(oneLog, 'AGG ONE INITIAL\n');
    await fs.writeFile(twoLog, 'AGG TWO INITIAL\n');
    await fs.writeFile(doneLog, 'AGG DONE INITIAL\n');
    await fs.writeFile(hiddenLog, 'AGG HIDDEN INITIAL\n');

    const acceptedDone = await requestJson(`/api/lanes/${doneLane.body.id}/audit/accept`, {
      method: 'POST',
      body: { summary: 'Accepted for terminal-output review.' },
    });
    assert.equal(acceptedDone.status, 200);
    assert.equal(acceptedDone.body.lane.state, 'accepted');

    const env = {
      HOME: tempDir,
      ORCA_AGENT_TOOLS_BASE_URL: baseUrl,
      ORCA_API_TOKEN: token,
      ORCA_TOOL_LEASE_TOKEN: '',
    };
    const enrolled = await runOrcaAgent(['enroll', session.body.id, '--project', project.body.id], env);
    assert.equal(enrolled.code, 0, enrolled.stderr);

    const sessionWatch = await runOrcaAgent([
      'watch-session',
      session.body.id,
      '--project',
      project.body.id,
      '--json',
      '--max-events',
      '6',
      '--idle-ms',
      '500',
    ], env, {
      onSpawn: () => {
        setTimeout(() => {
          fs.appendFile(oneLog, 'AGG ONE LIVE\n').catch(() => {});
          fs.appendFile(twoLog, 'AGG TWO LIVE\n').catch(() => {});
          fs.appendFile(hiddenLog, 'AGG HIDDEN LIVE\n').catch(() => {});
        }, 100);
      },
    });
    assert.equal(sessionWatch.code, 0, sessionWatch.stderr);
    const sessionEvents = sessionWatch.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const visibleLaneIds = new Set([laneOne.body.id, laneTwo.body.id]);
    assert.equal(sessionEvents.every((event) => visibleLaneIds.has(event.laneId)), true);
    assert.equal(sessionEvents.some((event) => event.event === 'append' && event.data.text.includes('AGG ONE LIVE')), true);
    assert.equal(sessionEvents.some((event) => event.event === 'append' && event.data.text.includes('AGG TWO LIVE')), true);
    assert.equal(JSON.stringify(sessionEvents).includes(hiddenLane.body.id), false);
    assert.equal(JSON.stringify(sessionEvents).includes('AGG HIDDEN'), false);
    assert.equal(JSON.stringify(sessionEvents).includes(doneLane.body.id), false);
    assert.equal(JSON.stringify(sessionEvents).includes('AGG DONE'), false);

    const doneWatch = await runOrcaAgent([
      'watch-session',
      session.body.id,
      '--project',
      project.body.id,
      '--json',
      '--done',
      '--idle-ms',
      '250',
    ], env);
    assert.equal(doneWatch.code, 0, doneWatch.stderr);
    const doneEvents = doneWatch.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(doneEvents.some((event) =>
      event.laneId === doneLane.body.id
      && event.event === 'snapshot'
      && event.data.text.includes('AGG DONE INITIAL')), true);

    const supervisorLease = await requestJson('/api/agent-tools/leases', {
      method: 'POST',
      body: {
        actor: 'aggregate-supervisor',
        role: 'supervisor',
        projectId: project.body.id,
        sessionId: session.body.id,
        ttlMs: 10 * 60 * 1000,
      },
    });
    assert.equal(supervisorLease.status, 201);
    const supervisorEnv = {
      ...env,
      ORCA_AGENT_ROLE: 'supervisor',
      ORCA_TOOL_LEASE_TOKEN: supervisorLease.body.leaseToken,
    };

    const supervisorWatch = await runOrcaAgent([
      'supervisor-watch-all',
      '--project',
      project.body.id,
      '--session',
      session.body.id,
      '--json',
      '--max-events',
      '6',
      '--idle-ms',
      '500',
    ], supervisorEnv, {
      onSpawn: () => {
        setTimeout(() => {
          fs.appendFile(oneLog, 'AGG SUP ONE LIVE\n').catch(() => {});
          fs.appendFile(twoLog, 'AGG SUP TWO LIVE\n').catch(() => {});
          fs.appendFile(hiddenLog, 'AGG SUP HIDDEN LIVE\n').catch(() => {});
        }, 100);
      },
    });
    assert.equal(supervisorWatch.code, 0, supervisorWatch.stderr);
    const supervisorEvents = supervisorWatch.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(supervisorEvents.every((event) => visibleLaneIds.has(event.laneId)), true);
    assert.equal(supervisorEvents.some((event) => event.event === 'append' && event.data.text.includes('AGG SUP ONE LIVE')), true);
    assert.equal(supervisorEvents.some((event) => event.event === 'append' && event.data.text.includes('AGG SUP TWO LIVE')), true);
    assert.equal(JSON.stringify(supervisorEvents).includes(hiddenLane.body.id), false);
    assert.equal(JSON.stringify(supervisorEvents).includes('AGG SUP HIDDEN'), false);

    const deniedHidden = await runOrcaAgent([
      'supervisor-watch-all',
      '--project',
      hiddenProject.body.id,
      '--session',
      hiddenSession.body.id,
      '--json',
      '--max-events',
      '1',
    ], supervisorEnv);
    assert.equal(deniedHidden.code, 2);
    assert.match(deniedHidden.stderr, /Tool lease project mismatch|Tool lease session mismatch/);
  });
});

test('orca-agent enroll attaches to an existing session and enforces takeover ownership', async () => {
  await withRealOrcaServer(async ({ baseUrl, requestJson, token, tempDir }) => {
    const project = await requestJson('/api/projects', {
      method: 'POST',
      body: { name: 'CLI Orchestrator Attach Project', approved: true },
    });
    assert.equal(project.status, 201);
    const session = await requestJson(`/api/projects/${project.body.id}/sessions`, {
      method: 'POST',
      body: { name: 'Existing CLI Orchestrator Session', approved: true },
    });
    assert.equal(session.status, 201);
    const lane = await requestJson(`/api/sessions/${session.body.id}/lanes`, {
      method: 'POST',
      body: { title: 'Existing executor lane', executorType: 'mock', approved: true },
    });
    assert.equal(lane.status, 201);

    const counts = async () => {
      const projects = await requestJson('/api/projects');
      const sessions = await requestJson(`/api/projects/${project.body.id}/sessions`);
      const lanes = await requestJson(`/api/sessions/${session.body.id}/lanes`);
      assert.equal(projects.status, 200);
      assert.equal(sessions.status, 200);
      assert.equal(lanes.status, 200);
      return {
        projects: projects.body.length,
        sessions: sessions.body.length,
        lanes: lanes.body.length,
      };
    };
    const beforeAttach = await counts();

    const env = {
      HOME: tempDir,
      ORCA_AGENT_TOOLS_BASE_URL: baseUrl,
      ORCA_API_TOKEN: token,
      ORCA_TOOL_LEASE_TOKEN: '',
    };

    const enrolled = await runOrcaAgent(['enroll', session.body.id, '--project', project.body.id], env);
    assert.equal(enrolled.code, 0, enrolled.stderr);
    const enrolledBody = JSON.parse(enrolled.stdout);
    assert.equal(enrolledBody.activeOrchestrator.active, true);
    assert.equal(enrolledBody.activeOrchestrator.actor, 'orca-agent-orchestrator');
    assert.deepEqual(await counts(), beforeAttach);

    const cachePath = path.join(tempDir, '.orca', 'agent-leases.json');
    const cache = JSON.parse(await fs.readFile(cachePath, 'utf8'));
    const ownerCacheKey = Object.keys(cache)
      .find((key) => key.includes('role=orchestrator') && key.includes(`project=${project.body.id}`) && key.includes(`session=${session.body.id}`));
    assert.ok(ownerCacheKey, `expected scoped orchestrator cache key, got ${Object.keys(cache).join(', ')}`);
    assert.equal(JSON.stringify(cache).includes(token), false);

    const status = await runOrcaAgent(['status', session.body.id, '--project', project.body.id], env);
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /owner: orca-agent-orchestrator/);
    assert.match(status.stdout, /Existing executor lane/);

    const competingLease = await requestJson('/api/agent-tools/leases', {
      method: 'POST',
      body: {
        actor: 'competing-cli-orchestrator',
        role: 'orchestrator',
        projectId: project.body.id,
        sessionId: session.body.id,
        ttlMs: 10 * 60 * 1000,
      },
    });
    assert.equal(competingLease.status, 201);
    const competingEnv = {
      ...env,
      ORCA_TOOL_LEASE_TOKEN: competingLease.body.leaseToken,
    };

    const refused = await runOrcaAgent(['enroll', session.body.id, '--project', project.body.id], competingEnv);
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /active orchestrator|takeover/i);
    assert.deepEqual(await counts(), beforeAttach);

    const takeover = await runOrcaAgent(['enroll', session.body.id, '--project', project.body.id, '--takeover'], competingEnv);
    assert.equal(takeover.code, 0, takeover.stderr);
    const takeoverBody = JSON.parse(takeover.stdout);
    assert.equal(takeoverBody.activeOrchestrator.actor, 'competing-cli-orchestrator');

    const ownerStatusAfterTakeover = await runOrcaAgent(['status', session.body.id, '--project', project.body.id], env);
    assert.equal(ownerStatusAfterTakeover.code, 0, ownerStatusAfterTakeover.stderr);
    assert.match(ownerStatusAfterTakeover.stdout, /owner: competing-cli-orchestrator/);

    const resignedByOldOwner = await runOrcaAgent(['resign', session.body.id, '--project', project.body.id], env);
    assert.equal(resignedByOldOwner.code, 2);
    assert.match(resignedByOldOwner.stderr, /active orchestrator|does not hold/i);

    const resigned = await runOrcaAgent(['resign', session.body.id, '--project', project.body.id], competingEnv);
    assert.equal(resigned.code, 0, resigned.stderr);
    const resignedBody = JSON.parse(resigned.stdout);
    assert.equal(resignedBody.released, true);

    const finalStatus = await runOrcaAgent(['status', session.body.id, '--project', project.body.id], env);
    assert.equal(finalStatus.code, 0, finalStatus.stderr);
    assert.match(finalStatus.stdout, /owner: \(none\)/);
    assert.deepEqual(await counts(), beforeAttach);
  });
});

test('orca-agent manages project live links while preserving supervisor read-only boundaries', async () => {
  await withRealOrcaServer(async ({ baseUrl, requestJson, token, tempDir }) => {
    const project = await requestJson('/api/projects', {
      method: 'POST',
      body: { name: 'CLI Live Link Project', approved: true },
    });
    assert.equal(project.status, 201);
    const hiddenProject = await requestJson('/api/projects', {
      method: 'POST',
      body: { name: 'Hidden CLI Live Link Project', approved: true },
    });
    assert.equal(hiddenProject.status, 201);

    const env = {
      HOME: tempDir,
      ORCA_AGENT_TOOLS_BASE_URL: baseUrl,
      ORCA_API_TOKEN: token,
      ORCA_TOOL_LEASE_TOKEN: '',
    };
    const localUrl = `${baseUrl}/api/health`;
    const upserted = await runOrcaAgent([
      'link-upsert',
      project.body.id,
      'Phone Vite',
      localUrl,
      '--local',
      localUrl,
      '--tailnet',
      'http://orca.example.ts.net:5173',
      '--port',
      '5173',
      '--kind',
      'vite',
      '--favorite',
      '--check',
      '--prefer',
      'local',
    ], env);
    assert.equal(upserted.code, 0, upserted.stderr);
    const upsertedBody = JSON.parse(upserted.stdout);
    assert.equal(upsertedBody.saved.link.label, 'Phone Vite');
    assert.equal(upsertedBody.saved.link.kind, 'vite');
    assert.equal(upsertedBody.saved.link.favorite, true);
    assert.equal(upsertedBody.saved.link.tailnetHttpUrl, 'http://orca.example.ts.net:5173/');
    assert.equal(upsertedBody.checked.result.status, 'reachable');
    assert.equal(upsertedBody.checked.result.httpStatus, 200);
    assert.match(upsertedBody.checked.result.checkedUrl, /\/api\/health$/);

    const linkId = upsertedBody.saved.link.id;
    const links = await runOrcaAgent(['links', project.body.id, '--project', project.body.id], env);
    assert.equal(links.code, 0, links.stderr);
    const linksBody = JSON.parse(links.stdout);
    assert.equal(linksBody.projectId, project.body.id);
    assert.deepEqual(linksBody.quickLinks.map((link) => link.id), [linkId]);

    const checked = await runOrcaAgent(['link-check', project.body.id, linkId, '--prefer', 'local'], env);
    assert.equal(checked.code, 0, checked.stderr);
    assert.equal(JSON.parse(checked.stdout).result.status, 'reachable');

    const tailnetLink = await runOrcaAgent([
      'link-tailnet',
      project.body.id,
      'Phone Direct',
      `${baseUrl}/`,
      '--fake',
      'logged-in',
      '--port',
      '5173',
      '--kind',
      'vite',
      '--favorite',
      '--health-path',
      '/api/health',
      '--check',
      '--prefer',
      'local',
    ], env);
    assert.equal(tailnetLink.code, 0, tailnetLink.stderr);
    const tailnetLinkBody = JSON.parse(tailnetLink.stdout);
    const tailnetLinkId = tailnetLinkBody.saved.link.id;
    assert.equal(tailnetLinkBody.saved.link.label, 'Phone Direct');
    assert.equal(tailnetLinkBody.saved.link.localUrl, `${baseUrl}/`);
    assert.equal(tailnetLinkBody.saved.link.tailnetHttpUrl, 'http://orca.test-tailnet.ts.net:5173/');
    assert.equal(tailnetLinkBody.saved.link.kind, 'vite');
    assert.equal(tailnetLinkBody.checked.result.status, 'reachable');
    assert.equal(tailnetLinkBody.checked.result.checkedUrl, `${baseUrl}/api/health`);

    const tailnetMissing = await runOrcaAgent([
      'link-tailnet',
      project.body.id,
      'Missing Tailnet',
      `${baseUrl}/`,
      '--fake',
      'missing',
    ], env);
    assert.equal(tailnetMissing.code, 2);
    assert.match(tailnetMissing.stderr, /Tailscale is not ready/);

    const cachePath = path.join(tempDir, '.orca', 'agent-leases.json');
    const cache = JSON.parse(await fs.readFile(cachePath, 'utf8'));
    const keys = Object.keys(cache);
    assert.ok(keys.some((key) => key.includes('role=orchestrator') && key.includes(`project=${project.body.id}`)));
    assert.equal(JSON.stringify(cache).includes(token), false);

    const supervisorLease = await requestJson('/api/agent-tools/leases', {
      method: 'POST',
      body: {
        actor: 'cli-link-supervisor',
        role: 'supervisor',
        projectId: project.body.id,
        ttlMs: 10 * 60 * 1000,
      },
    });
    assert.equal(supervisorLease.status, 201);
    const supervisorEnv = {
      ...env,
      ORCA_AGENT_ROLE: 'supervisor',
      ORCA_TOOL_LEASE_TOKEN: supervisorLease.body.leaseToken,
    };

    const supervisorLinks = await runOrcaAgent(['links', project.body.id], supervisorEnv);
    assert.equal(supervisorLinks.code, 0, supervisorLinks.stderr);
    assert.deepEqual(
      JSON.parse(supervisorLinks.stdout).quickLinks.map((link) => link.id).sort(),
      [linkId, tailnetLinkId].sort()
    );

    const deniedHidden = await runOrcaAgent(['links', hiddenProject.body.id], supervisorEnv);
    assert.equal(deniedHidden.code, 2);
    assert.match(deniedHidden.stderr, /Tool lease project mismatch/);

    const tailnet = await runOrcaAgent(['tailscale-status', '--fake', 'serve-http'], supervisorEnv);
    assert.equal(tailnet.code, 0, tailnet.stderr);
    assert.equal(JSON.parse(tailnet.stdout).serveMode, 'tailnet-http');

    const setup = await runOrcaAgent(['tailscale-setup', '--local', localUrl], supervisorEnv);
    assert.equal(setup.code, 0, setup.stderr);
    assert.equal(Array.isArray(JSON.parse(setup.stdout).commands), true);

    const deniedUpsert = await runOrcaAgent([
      'link-upsert',
      project.body.id,
      'Supervisor Mutation',
      localUrl,
    ], supervisorEnv);
    assert.equal(deniedUpsert.code, 2);
    assert.match(deniedUpsert.stderr, /does not grant this tool/);

    const deniedTailnetUpsert = await runOrcaAgent([
      'link-tailnet',
      project.body.id,
      'Supervisor Tailnet Mutation',
      `${baseUrl}/`,
      '--fake',
      'logged-in',
    ], supervisorEnv);
    assert.equal(deniedTailnetUpsert.code, 2);
    assert.match(deniedTailnetUpsert.stderr, /does not grant this tool/);

    const deniedCheck = await runOrcaAgent(['link-check', project.body.id, linkId, '--prefer', 'local'], supervisorEnv);
    assert.equal(deniedCheck.code, 2);
    assert.match(deniedCheck.stderr, /does not grant this tool/);
  });
});

test('orca-agent creates repo-backed sessions and isolated worktree lanes from the CLI', async () => {
  await withRealOrcaServer(async ({ baseUrl, requestJson, token, tempDir }) => {
    const repoDir = path.join(tempDir, 'fixture-repo');
    await fs.mkdir(repoDir, { recursive: true });
    runGit(['init'], repoDir);
    runGit(['config', 'user.email', 'orca-agent-cli@example.test'], repoDir);
    runGit(['config', 'user.name', 'Orca Agent CLI'], repoDir);
    await fs.writeFile(path.join(repoDir, 'README.md'), '# Orca agent CLI repo\n');
    runGit(['add', 'README.md'], repoDir);
    runGit(['commit', '-m', 'Initial fixture commit'], repoDir);
    runGit(['branch', '-M', 'main'], repoDir);

    const project = await requestJson('/api/projects', {
      method: 'POST',
      body: { name: 'CLI Repo Project', approved: true },
    });
    assert.equal(project.status, 201);
    const env = {
      HOME: tempDir,
      ORCA_AGENT_TOOLS_BASE_URL: baseUrl,
      ORCA_API_TOKEN: token,
      ORCA_TOOL_LEASE_TOKEN: '',
    };

    const created = await runOrcaAgent([
      'create-session',
      project.body.id,
      'CLI Repo Session',
      '--repo-root',
      repoDir,
      '--worktree-mode',
      'isolated',
      '--cap',
      '2',
      '--leader',
      'codex',
    ], env);
    assert.equal(created.code, 0, created.stderr);
    const session = JSON.parse(created.stdout);
    assert.equal(session.projectId, project.body.id);
    assert.equal(session.name, 'CLI Repo Session');
    assert.equal(session.leader, 'codex');
    assert.equal(session.worktreeMode, 'isolated');
    assert.equal(session.approvedCapacity, 2);
    assert.equal(await fs.realpath(session.repoRoot), await fs.realpath(repoDir));

    const enrolled = await runOrcaAgent(['enroll', session.id, '--project', project.body.id], env);
    assert.equal(enrolled.code, 0, enrolled.stderr);
    assert.equal(JSON.parse(enrolled.stdout).activeOrchestrator.actor, 'orca-agent-orchestrator');

    const lanePayload = {
      approved: true,
      title: 'CLI repo worker',
      executorType: 'mock',
      taskPrompt: 'Prove the CLI repo-backed worktree flow.',
      branch: 'dogfood/cli-repo-worker',
    };
    const laneRun = await runOrcaAgent([
      'call',
      'POST',
      `/api/sessions/${session.id}/lanes`,
      JSON.stringify(lanePayload),
      '--project',
      project.body.id,
      '--session',
      session.id,
    ], env);
    assert.equal(laneRun.code, 0, laneRun.stderr);
    const lane = JSON.parse(laneRun.stdout);
    assert.equal(lane.sessionId, session.id);
    assert.equal(lane.repoRoot, session.repoRoot);
    assert.equal(lane.worktreeMode, 'isolated');
    assert.equal(lane.branch, 'dogfood/cli-repo-worker');
    assert.equal(lane.branch.startsWith('codex/'), false);
    assert.ok(lane.worktreePath);
    const worktreeReal = await fs.realpath(lane.worktreePath);
    const repoReal = await fs.realpath(repoDir);
    assert.notEqual(worktreeReal, repoReal);
    const expectedBase = path.join(tempDir, '.orca', 'workspaces', session.id, 'worktrees');
    assert.equal(worktreeReal.startsWith(`${await fs.realpath(expectedBase)}${path.sep}`), true);
    assert.match(runGit(['worktree', 'list', '--porcelain'], repoDir).stdout, new RegExp(lane.worktreePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const cachePath = path.join(tempDir, '.orca', 'agent-leases.json');
    const cache = JSON.parse(await fs.readFile(cachePath, 'utf8'));
    const keys = Object.keys(cache);
    assert.ok(keys.some((key) => key.includes('role=orchestrator') && key.includes(`project=${project.body.id}`)));
    assert.ok(keys.some((key) => key.includes('role=orchestrator') && key.includes(`session=${session.id}`)));
    assert.equal(JSON.stringify(cache).includes(token), false);
  });
});

test('orca-agent supervisor commands attach with role-scoped leases and resign cleanly', async () => {
  await withRealOrcaServer(async ({ baseUrl, requestJson, token, tempDir }) => {
    const project = await requestJson('/api/projects', {
      method: 'POST',
      body: { name: 'CLI Supervisor Project', approved: true },
    });
    assert.equal(project.status, 201);
    const hiddenProject = await requestJson('/api/projects', {
      method: 'POST',
      body: { name: 'Hidden CLI Supervisor Project', approved: true },
    });
    assert.equal(hiddenProject.status, 201);
    const session = await requestJson(`/api/projects/${project.body.id}/sessions`, {
      method: 'POST',
      body: { name: 'CLI Supervised Session', approved: true },
    });
    assert.equal(session.status, 201);
    const hiddenSession = await requestJson(`/api/projects/${project.body.id}/sessions`, {
      method: 'POST',
      body: { name: 'Hidden CLI Supervised Session', approved: true },
    });
    assert.equal(hiddenSession.status, 201);
    const lane = await requestJson(`/api/sessions/${session.body.id}/lanes`, {
      method: 'POST',
      body: { title: 'CLI supervised lane', executorType: 'mock', approved: true },
    });
    assert.equal(lane.status, 201);
    const task = await requestJson(`/api/sessions/${session.body.id}/tasks`, {
      method: 'POST',
      body: {
        title: 'CLI supervised pending task',
        executorType: 'mock',
        approved: true,
      },
    });
    assert.equal(task.status, 201);
    const logDir = path.join(process.cwd(), 'artifacts', session.body.id, lane.body.id);
    const logPath = path.join(logDir, 'terminal.log');
    await fs.mkdir(logDir, { recursive: true });
    await fs.writeFile(logPath, 'CLI WATCH INITIAL\n');

    const counts = async () => {
      const projects = await requestJson('/api/projects');
      const sessions = await requestJson(`/api/projects/${project.body.id}/sessions`);
      const lanes = await requestJson(`/api/sessions/${session.body.id}/lanes`);
      assert.equal(projects.status, 200);
      assert.equal(sessions.status, 200);
      assert.equal(lanes.status, 200);
      return {
        projects: projects.body.length,
        sessions: sessions.body.length,
        lanes: lanes.body.length,
      };
    };
    const beforeAttach = await counts();

    const env = {
      HOME: tempDir,
      ORCA_AGENT_TOOLS_BASE_URL: baseUrl,
      ORCA_API_TOKEN: token,
      ORCA_TOOL_LEASE_TOKEN: '',
    };

    const bootstrap = await runOrcaAgent([
      'bootstrap',
      '--role',
      'supervisor',
      '--project',
      project.body.id,
      '--session',
      session.body.id,
    ], env);
    assert.equal(bootstrap.code, 0, bootstrap.stderr);
    const bootstrapBody = JSON.parse(bootstrap.stdout);
    assert.equal(bootstrapBody.role, 'supervisor');
    assert.equal(bootstrapBody.actor, 'orca-agent-supervisor');
    assert.equal(String(bootstrapBody.export).includes(bootstrapBody.leaseToken), true);
    assert.equal(JSON.stringify(bootstrapBody).includes(token), false);

    const cachePath = path.join(tempDir, '.orca', 'agent-leases.json');
    const cacheAfterBootstrap = JSON.parse(await fs.readFile(cachePath, 'utf8'));
    const bootstrapSupervisorKey = Object.keys(cacheAfterBootstrap).find((key) =>
      key.includes('role=supervisor') &&
      key.includes(`project=${project.body.id}`) &&
      key.includes(`session=${session.body.id}`));
    assert.ok(bootstrapSupervisorKey, `expected bootstrapped supervisor cache key, got ${Object.keys(cacheAfterBootstrap).join(', ')}`);
    assert.equal(cacheAfterBootstrap[bootstrapSupervisorKey].leaseToken, bootstrapBody.leaseToken);
    assert.equal(JSON.stringify(cacheAfterBootstrap).includes(token), false);

    const status = await runOrcaAgent(['status', session.body.id, '--project', project.body.id], env);
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /owner: /);

    const overviewRun = await runOrcaAgent([
      'supervisor-overview',
      '--project',
      project.body.id,
      '--session',
      session.body.id,
    ], env);
    assert.equal(overviewRun.code, 0, overviewRun.stderr);
    const overview = JSON.parse(overviewRun.stdout);
    assert.deepEqual(overview.projects.map((item) => item.id), [project.body.id]);
    assert.deepEqual(overview.projects[0].sessions.map((item) => item.id), [session.body.id]);
    assert.equal(JSON.stringify(overview).includes(hiddenProject.body.id), false);
    assert.equal(JSON.stringify(overview).includes(hiddenSession.body.id), false);
    const matchingSupervisors = overview.activeSupervisors.filter((lease) => lease.actor === 'orca-agent-supervisor');
    assert.equal(matchingSupervisors.length, 1);
    assert.equal(overview.activeSupervisors.some((lease) => lease.actor === 'desktop-app'), false);
    assert.deepEqual(await counts(), beforeAttach);

    const overviewSummary = await runOrcaAgent([
      'supervisor-overview',
      '--project',
      project.body.id,
      '--session',
      session.body.id,
      '--summary',
    ], env);
    assert.equal(overviewSummary.code, 0, overviewSummary.stderr);
    assert.match(overviewSummary.stdout, /active supervisors: /);
    assert.match(overviewSummary.stdout, /attention:/);
    assert.match(overviewSummary.stdout, /CLI Supervisor Project \/ CLI Supervised Session -> orchestrator\.status/);
    assert.equal(overviewSummary.stdout.includes(hiddenProject.body.id), false);
    assert.equal(overviewSummary.stdout.includes(hiddenSession.body.id), false);

    const cache = JSON.parse(await fs.readFile(cachePath, 'utf8'));
    const keys = Object.keys(cache);
    const orchestratorKey = keys.find((key) => key.includes('role=orchestrator') && key.includes(`project=${project.body.id}`) && key.includes(`session=${session.body.id}`));
    const supervisorKey = keys.find((key) => key.includes('role=supervisor') && key.includes(`project=${project.body.id}`) && key.includes(`session=${session.body.id}`));
    assert.ok(orchestratorKey, `expected orchestrator cache key, got ${keys.join(', ')}`);
    assert.ok(supervisorKey, `expected supervisor cache key, got ${keys.join(', ')}`);
    assert.equal(cache[supervisorKey].leaseToken, bootstrapBody.leaseToken);
    assert.notEqual(cache[orchestratorKey].leaseToken, cache[supervisorKey].leaseToken);
    assert.equal(JSON.stringify(cache).includes(token), false);

    const deniedHidden = await runOrcaAgent([
      'supervisor-overview',
      '--project',
      project.body.id,
      '--session',
      hiddenSession.body.id,
    ], {
      ...env,
      ORCA_TOOL_LEASE_TOKEN: cache[supervisorKey].leaseToken,
    });
    assert.equal(deniedHidden.code, 2);
    assert.match(deniedHidden.stderr, /Tool lease session mismatch/);

    const supervisorStatus = await runOrcaAgent(['supervisor-status', session.body.id, '--project', project.body.id], env);
    assert.equal(supervisorStatus.code, 0, supervisorStatus.stderr);
    assert.match(supervisorStatus.stdout, /next: /);

    const watched = await runOrcaAgent([
      'supervisor-watch',
      lane.body.id,
      '--project',
      project.body.id,
      '--session',
      session.body.id,
      '--json',
      '--max-events',
      '3',
    ], env, {
      onSpawn: () => {
        setTimeout(() => {
          fs.appendFile(logPath, 'CLI WATCH LIVE\n').catch(() => {});
        }, 100);
      },
    });
    assert.equal(watched.code, 0, watched.stderr);
    const watchEvents = watched.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.deepEqual(watchEvents.map((event) => event.event), ['stream_open', 'snapshot', 'append']);
    assert.equal(watchEvents[1].data.text, 'CLI WATCH INITIAL\n');
    assert.equal(watchEvents[2].data.text, 'CLI WATCH LIVE\n');
    assert.equal(watchEvents[2].data.offset, 'CLI WATCH INITIAL\n'.length);

    const idleWatch = await runOrcaAgent([
      'supervisor-watch',
      lane.body.id,
      '--project',
      project.body.id,
      '--session',
      session.body.id,
      '--json',
      '--idle-ms',
      '250',
    ], env);
    assert.equal(idleWatch.code, 0, idleWatch.stderr);
    const idleEvents = idleWatch.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(idleEvents.some((event) => event.event === 'snapshot' && event.data.text.includes('CLI WATCH LIVE')), true);

    const audit = await runOrcaAgent([
      'supervisor-audit',
      session.body.id,
      'request_fix',
      'CLI supervisor requested one more check.',
      '--project',
      project.body.id,
      '--finding',
      'CLI supervisor dogfood proof.',
      '--next-task',
      'Address the CLI supervisor finding.',
    ], env);
    assert.equal(audit.code, 0, audit.stderr);
    const auditBody = JSON.parse(audit.stdout);
    assert.equal(auditBody.supervisorReview.status, 'fix_requested');

    const supervisorThread = await runOrcaAgent([
      'supervisor-thread',
      session.body.id,
      '--project',
      project.body.id,
    ], env);
    assert.equal(supervisorThread.code, 0, supervisorThread.stderr);
    const threadBody = JSON.parse(supervisorThread.stdout);
    assert.equal(threadBody.sessionId, session.body.id);
    assert.equal(threadBody.messages.some((message) =>
      String(message.content || '').includes('CLI supervisor requested one more check.')), true);
    assert.equal(JSON.stringify(threadBody).includes(hiddenSession.body.id), false);

    const orchestratorStatusAfterAudit = await runOrcaAgent([
      'status',
      session.body.id,
      '--project',
      project.body.id,
    ], env);
    assert.equal(orchestratorStatusAfterAudit.code, 0, orchestratorStatusAfterAudit.stderr);
    assert.match(orchestratorStatusAfterAudit.stdout, /supervisor: fix_requested/);
    assert.match(orchestratorStatusAfterAudit.stdout, /Address the CLI supervisor finding\./);

    const resign = await runOrcaAgent([
      'supervisor-resign',
      '--project',
      project.body.id,
      '--session',
      session.body.id,
    ], env);
    assert.equal(resign.code, 0, resign.stderr);
    const resignBody = JSON.parse(resign.stdout);
    assert.equal(resignBody.resigned, true);
    assert.equal(resignBody.lease.active, false);

    const cacheAfterResign = JSON.parse(await fs.readFile(cachePath, 'utf8'));
    assert.equal(Object.keys(cacheAfterResign).some((key) => key.includes('role=supervisor') && key.includes(`session=${session.body.id}`)), false);

    const afterResign = await requestJson(`/api/supervisor/overview?projectId=${project.body.id}&sessionId=${session.body.id}`);
    assert.equal(afterResign.status, 200);
    assert.equal(afterResign.body.activeSupervisors.some((lease) => lease.actor === 'orca-agent-supervisor'), false);
    assert.deepEqual(await counts(), beforeAttach);
  });
});
