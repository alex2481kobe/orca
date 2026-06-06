// Verify agent OUTPUT still renders in the UI after the lightweight-list/detail
// rearchitecture: inject a session whose active orchestrator lane has agent events,
// render the session view + the lane-detail view, and assert the agent-event
// timeline + live-terminal mount actually appear (the "seeing stuff" path).
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const projectCwd = process.cwd();
process.chdir(await fs.mkdtemp(path.join(os.tmpdir(), 'orca-verify-state-')));
process.env.PORT = '0'; process.env.ORCA_HOST = '127.0.0.1';
process.env.ORCA_CREDENTIAL_BACKEND = 'memory'; process.env.ORCA_RATE_LIMIT_DISABLED = 'true';
const sm = await import('../src/server.js');
const s = await sm.startServer(0, '127.0.0.1');
const base = `http://127.0.0.1:${s.address().port}`;
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1100, height: 900 }, colorScheme: 'dark' });
const p = await ctx.newPage();

const seed = (laneId) => ({
  projects: [{ id: 'p1', slug: 'test-proj', name: 'P', route: '/projects/test-proj' }],
  sessions: [{ id: 'sess-1', projectId: 'p1', name: 'S', route: '/projects/test-proj/sessions/sess-1',
    orchestratorThread: { activeLaneId: laneId, laneIds: [laneId], messages: [{ role: 'assistant', content: 'working on it' }] } }],
  lanes: [{ id: laneId, sessionId: 'sess-1', owner: 'orchestrator', title: 'Worker', state: 'running', executorType: 'mock',
    agentEvents: Array.from({ length: 30 }, (_, i) => ({ type: 'output', content: `AGENTLINE-${i}`, at: new Date(Date.now() + i).toISOString() })),
    agentEventCount: 30 }],
});

// --- Session view: console should show the active lane's agent-event timeline ---
await p.goto(base + '/projects/test-proj/sessions/sess-1', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(500);
const sessionView = await p.evaluate(async (data) => {
  const { shell } = await import('/ui/state.js');
  const views = await import('/ui/render-views.js');
  Object.assign(shell, data);
  shell.route = { projectSlug: 'test-proj', sessionId: 'sess-1', laneId: null };
  views.render();
  return {
    hasTimeline: Boolean(document.querySelector('.agent-event-list')),
    showsEventText: (document.body.textContent || '').includes('AGENTLINE-29'),
  };
}, seed('lane-1'));

// --- Lane detail view: full timeline + live terminal mount ---
await p.goto(base + '/projects/test-proj/sessions/sess-1/lanes/lane-1', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(500);
const laneView = await p.evaluate(async (data) => {
  const { shell } = await import('/ui/state.js');
  const views = await import('/ui/render-views.js');
  Object.assign(shell, data);
  shell.route = { projectSlug: 'test-proj', sessionId: 'sess-1', laneId: 'lane-1' };
  views.render();
  return {
    hasTimeline: Boolean(document.querySelector('.agent-event-list')),
    showsEventText: (document.body.textContent || '').includes('AGENTLINE-29'),
    hasLiveTerminalMount: Boolean(document.querySelector('.lane-stream')),
  };
}, seed('lane-1'));

const result = {
  sessionConsole_timeline: sessionView.hasTimeline,
  sessionConsole_showsAgentOutput: sessionView.showsEventText,
  laneDetail_timeline: laneView.hasTimeline,
  laneDetail_showsAgentOutput: laneView.showsEventText,
  laneDetail_liveTerminalMount: laneView.hasLiveTerminalMount,
};
result.pass = Object.values(result).every(Boolean);
console.log('[verify] agent-output-visible:', JSON.stringify(result, null, 2));
await b.close(); if (sm.stopServer) await sm.stopServer(); await new Promise((r) => s.close(r));
