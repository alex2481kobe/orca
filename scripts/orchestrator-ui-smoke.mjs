#!/usr/bin/env node
/*
 * Proves the dashboard orchestrator chat can start an orchestrator lane and
 * render the resulting conversation/activity without direct API cheating.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const previousCwd = process.cwd();
const previousEnv = { ...process.env };
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-orch-ui-'));
const token = 'orchestrator-ui-smoke-token';
let server = null;
let stopServer = null;
let base = '';

const log = (label, info = '') => console.log(`[orchestrator-ui-smoke] ${label}${info ? ' — ' + info : ''}`);
const fail = (label, info = '') => {
  console.error(`[orchestrator-ui-smoke FAIL] ${label}${info ? ' — ' + info : ''}`);
  throw new Error(`${label}${info ? `: ${info}` : ''}`);
};

async function req(method, route, body, headers = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-orca-token': token,
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* noop */ }
  return { status: response.status, body: data, headers: Object.fromEntries(response.headers.entries()) };
}

async function createBrowserSessionCookie() {
  const pairing = await req('POST', '/api/auth/pairing-codes', {
    actor: 'orchestrator-ui-smoke',
    label: 'orchestrator ui smoke browser',
    ttlMs: 60_000,
  });
  if (pairing.status !== 201) fail('pairing code create', JSON.stringify(pairing.body));
  const paired = await req('POST', '/api/auth/pair', {
    code: pairing.body.pairing.code,
    label: 'orchestrator ui smoke browser',
  }, {});
  if (paired.status !== 200) fail('browser pair', JSON.stringify(paired.body));
  return paired.headers['set-cookie'] || '';
}

async function addSessionCookie(context, cookieHeader) {
  const [cookiePair] = String(cookieHeader || '').split(';');
  const [name, ...valueParts] = cookiePair.split('=');
  if (!name || !valueParts.length) return;
  await context.addCookies([{
    name: name.trim(),
    value: valueParts.join('=').trim(),
    url: base,
    httpOnly: true,
    sameSite: 'Lax',
  }]);
}

async function cleanup() {
  if (stopServer) await stopServer();
  if (server) await new Promise((resolve) => server.close(resolve));
  process.chdir(previousCwd);
  await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  for (const key of Object.keys(process.env)) {
    if (!(key in previousEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(previousEnv)) process.env[key] = value;
}

try {
  process.chdir(tempDir);
  process.env.PORT = '0';
  process.env.ORCA_HOST = '127.0.0.1';
  process.env.ORCA_API_TOKEN = token;
  process.env.ORCA_CREDENTIAL_BACKEND = 'memory';
  process.env.ORCA_RATE_LIMIT_DISABLED = 'true';
  // Product UI should only offer agents that resolve on disk. Use a tiny fake
  // Codex binary for the browser smoke instead of exposing the internal mock
  // adapter in the operator dropdown.
  const fakeBinDir = path.join(tempDir, 'bin');
  await fs.mkdir(fakeBinDir, { recursive: true });
  const fakeCodex = path.join(fakeBinDir, 'codex');
  await fs.writeFile(fakeCodex, [
    '#!/usr/bin/env node',
    'const args = process.argv.slice(2);',
    'if (args.includes("--version") || args.includes("-V")) { console.log("codex-cli 0.0.0-smoke"); process.exit(0); }',
    'if (args.includes("--help") || args.includes("-h")) { console.log("--model gpt-5\\n--effort (low|medium|high|xhigh)"); process.exit(0); }',
    'console.log(JSON.stringify({ msg: { type: "text", content: "I can help with that." } }));',
    'console.log(JSON.stringify({ msg: { type: "exec_approval_request", command: "npm test" } }));',
    'console.log(JSON.stringify({ msg: { type: "turn_complete", content: "I can help with that.", usage: { input_tokens: 8, output_tokens: 4 } } }));',
    '',
  ].join('\n'));
  await fs.chmod(fakeCodex, 0o755);
  process.env.ORCA_CODEX_BINARY = fakeCodex;
  process.env.ORCA_CODEX_ALLOWED_BINARIES = fakeCodex;
  for (const v of ['ORCA_CLAUDE_BINARY', 'ORCA_GEMINI_CLI_BINARY', 'ORCA_COMPOSER_CLI_BINARY']) process.env[v] = 'orca-absent-cli';

  const [{ chromium }, serverModule] = await Promise.all([
    import('playwright'),
    import('../src/server.js'),
  ]);
  server = await serverModule.startServer(0, '127.0.0.1');
  stopServer = serverModule.stopServer;
  const address = server.address();
  base = `http://127.0.0.1:${address.port}`;
  log('server', base);

  const project = await req('POST', '/api/projects', {
    actor: 'dashboard',
    approved: true,
    name: 'Orchestrator UI Smoke',
  });
  if (project.status !== 201) fail('project create', JSON.stringify(project.body));
  const session = await req('POST', `/api/projects/${project.body.id}/sessions`, {
    actor: 'dashboard',
    approved: true,
    name: 'Dashboard chat session',
    leader: 'codex',
    approvedCapacity: 2,
    spawnPolicy: 'within_capacity',
  });
  if (session.status !== 201) fail('session create', JSON.stringify(session.body));

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await addSessionCookie(context, await createBrowserSessionCookie());
    const page = await context.newPage();
    page.on('console', (message) => {
      if (['error', 'warning'].includes(message.type())) log(`browser ${message.type()}`, message.text());
    });
    page.on('pageerror', (error) => log('browser pageerror', error.stack || error.message));
    page.on('dialog', (dialog) => dialog.accept());
    await page.goto(`${base}${session.body.route}`, { waitUntil: 'networkidle', timeout: 20000 });
    await page.evaluate(() => {
      window.__orcaActionLog = [];
      document.addEventListener('click', (event) => {
        const target = event.target?.closest?.('[data-action]');
        if (!target) return;
        window.__orcaActionLog.push({
          action: target.dataset.action || '',
          laneId: target.dataset.laneId || '',
          sessionId: target.dataset.sessionId || '',
          at: Date.now(),
        });
      }, true);
    });
    await page.waitForSelector('#orchestrator-message-form textarea[name="message"]', { timeout: 15000 });
    // Selects are now custom dropdowns: click the trigger, then the option.
    const pick = async (name, value) => {
      const dd = page.locator(`#orchestrator-message-form .dd:has(select[name="${name}"])`);
      await dd.locator('.dd-trigger').click();
      await dd.locator(`.dd-opt[data-v="${value}"]`).click();
    };
    await pick('executorType', 'codex');
    await pick('permissionsProfile', 'plan');
    // Model is carried on a hidden field (chosen per-agent); set it directly.
    await page.$eval('#orchestrator-message-form input[name="model"]', (el, v) => { el.value = v; }, 'gpt-5');
    await page.fill('#orchestrator-message-form textarea[name="message"]', 'Start the launch verification lane from the dashboard chat.');
    const responsePromise = page.waitForResponse((response) => response.url().includes('/orchestrator/messages'), { timeout: 15000 });
    await page.click('#orchestrator-message-form button[type="submit"]');
    // Sending a chat message no longer pops a confirm modal — the operator's send
    // IS the approval (like a normal chat). The request fires straight through.
    const turnResponse = await responsePromise;
    if (turnResponse.status() !== 201) {
      fail('orchestrator message response', `${turnResponse.status()} ${await turnResponse.text()}`);
    }
    try {
      // Codex-style chat: the turn renders user + assistant message bubbles with
      // real assistant text, not merely process lifecycle events.
      await page.waitForFunction(() =>
        document.querySelectorAll('.chat-thread .msg').length >= 2
        && (document.querySelector('.chat-thread')?.textContent || '').includes('I can help with that.')
        && document.querySelector('.orchestrator-item')?.textContent.includes('codex'),
      { timeout: 15000 });
    } catch (error) {
      const text = await page.evaluate(() => (document.body.textContent || '').slice(0, 4000));
      fail('orchestrator chat/activity did not render', text);
    }
    const chatText = await page.locator('.chat-thread').innerText();
    if (chatText.includes('Started codex executor')) fail('chat leaked executor lifecycle copy', chatText);
    if (chatText.includes('Started codex orchestrator lane')) fail('chat leaked orchestrator stub instead of assistant reply', chatText);
    if (/\b(Queued|Started|Output|Done)\b/.test(chatText)) fail('chat leaked raw lifecycle/event labels', chatText);
    if (/activity items?/i.test(chatText)) fail('chat leaked vague activity-items copy', chatText);
    if (!chatText.includes('Terminal ran for') && !chatText.includes('Terminal active')) fail('chat missing compact terminal-aware run receipt', chatText);
    if (!chatText.includes('12 tokens')) fail('chat missing reported token usage', chatText);
    const visibleTimelineCount = await page.locator('.chat-thread .agent-event-list').count();
    if (visibleTimelineCount !== 0) fail('chat rendered full agent event timeline', String(visibleTimelineCount));
    const detailState = await page.locator('.chat-thread .chat-run-details').evaluateAll((items) => items.map((item) => item.open));
    if (!detailState.length) fail('chat missing collapsible activity receipt');
    if (detailState.some(Boolean)) fail('chat activity receipt should be collapsed after completion', JSON.stringify(detailState));
    await page.click('[data-action="toggleChatTerminal"]');
    await page.waitForSelector('.chat.chat-terminal-open .chat-terminal .lane-stream', { timeout: 10000 });
    const terminalMountCount = await page.locator('.chat.chat-terminal-open .chat-terminal .lane-stream').count();
    if (terminalMountCount !== 1) fail('chat terminal should mount exactly one live stream', String(terminalMountCount));
    await page.waitForFunction(() => {
      const text = document.querySelector('.chat.chat-terminal-open .chat-terminal .lane-stream')?.textContent || '';
      return text.trim() && !/Connecting to live output/i.test(text);
    }, { timeout: 10000 });
    const shotDir = path.join(previousCwd, 'artifacts', 'orchestrator-ui');
    await fs.mkdir(shotDir, { recursive: true });
    await page.screenshot({ path: path.join(shotDir, 'terminal-view.png'), fullPage: true });
    await page.click('[data-action="toggleChatTerminal"]');
    await page.waitForSelector('.chat:not(.chat-terminal-open) .chat-thread .msg-assistant', { timeout: 10000 });
    log('dashboard', 'message submitted and assistant reply rendered');

    const thread = await req('GET', `/api/sessions/${session.body.id}/orchestrator`);
    if (thread.status !== 200) fail('thread fetch', JSON.stringify(thread.body));
    const laneId = thread.body?.activeLaneId;
    if (!laneId) fail('missing active orchestrator lane', JSON.stringify(thread.body));
    const assistantTurn = (thread.body?.messages || []).find((message) => message.role === 'assistant' && message.laneId === laneId);
    if (!assistantTurn?.content?.includes('I can help with that.')) {
      fail('orchestrator thread missing promoted assistant reply', JSON.stringify(thread.body?.messages || []));
    }
    const lane = await req('GET', `/api/lanes/${laneId}`);
    if (lane.status !== 200) fail('lane fetch', JSON.stringify(lane.body));
    if (lane.body.owner !== 'orchestrator') fail('lane owner', JSON.stringify(lane.body));
    if (lane.body.executorType !== 'codex') fail('lane executor', JSON.stringify(lane.body));
    if (lane.body.model !== 'gpt-5') fail('lane model', JSON.stringify(lane.body));
    if (lane.body.permissionsProfile !== 'plan') fail('lane mode', JSON.stringify(lane.body));
    if (lane.body.intelligenceProfile !== 'high') fail('lane intelligence', JSON.stringify(lane.body));
    if (lane.body.presentationMode !== 'terminal') fail('chat-created CLI lane should use terminal presentation', JSON.stringify(lane.body));
    if ((lane.body.processMeta?.args || []).includes('--json')) fail('chat-created CLI lane should not use codex --json', JSON.stringify(lane.body.processMeta?.args || []));
    if (!Array.isArray(lane.body.agentEvents) || !lane.body.agentEvents.some((event) => event.type === 'agent.queued')) {
      fail('lane agent events', JSON.stringify(lane.body.agentEvents || []));
    }
    if (!lane.body.agentEvents.some((event) => event.type === 'message.assistant.final' || event.type === 'message.assistant.delta')) {
      fail('lane assistant output events', JSON.stringify(lane.body.agentEvents || []));
    }
    log('lane', `${laneId} ${lane.body.state} model=${lane.body.model} mode=${lane.body.permissionsProfile}`);

    await page.fill('#orchestrator-message-form textarea[name="message"]', 'Run this one in terminal presentation mode.');
    const terminalResponsePromise = page.waitForResponse((response) => response.url().includes('/orchestrator/messages'), { timeout: 15000 });
    await page.click('#orchestrator-message-form button[type="submit"]');
    const terminalTurnResponse = await terminalResponsePromise;
    if (terminalTurnResponse.status() !== 201) {
      fail('terminal mode message response', `${terminalTurnResponse.status()} ${await terminalTurnResponse.text()}`);
    }
    const terminalTurn = await terminalTurnResponse.json();
    const terminalLaneId = terminalTurn?.lane?.id;
    if (!terminalLaneId) fail('missing terminal-mode lane id', JSON.stringify(terminalTurn || null));
    await page.click('[data-action="toggleChatTerminal"]');
    const waitForTerminalLaneView = async () => {
      try {
        await page.waitForFunction((id) => {
          const head = document.querySelector('.chat.chat-terminal-open .chat-terminal-head');
          const stream = document.getElementById(`lane-stream-${id}`);
          return head?.dataset?.laneId === id && Boolean(stream);
        }, terminalLaneId, { timeout: 10000 });
      } catch (error) {
        const snapshot = await page.evaluate(async (id) => {
          let shellState = {};
          try {
            const state = await import('/ui/state.js');
            shellState = {
              route: state.shell.route,
              chatTerminalOpenBySession: state.shell.chatTerminalOpenBySession,
              chatTerminalTabBySession: state.shell.chatTerminalTabBySession,
              chatTerminalAgentLaneBySession: state.shell.chatTerminalAgentLaneBySession,
            };
          } catch (error) {
            shellState = { error: String(error?.message || error) };
          }
          return {
            shellState,
            chatClass: document.querySelector('.chat')?.className || '',
            terminalHtml: (document.querySelector('.chat-terminal')?.innerHTML || '').slice(0, 1200),
            headLaneId: document.querySelector('.chat-terminal-head')?.dataset?.laneId || '',
            streamIds: [...document.querySelectorAll('.chat-terminal .lane-stream')].map((el) => el.id),
            hasTargetStream: Boolean(document.getElementById(`lane-stream-${id}`)),
            actionLog: window.__orcaActionLog || [],
            bodyText: (document.body.textContent || '').slice(0, 1200),
          };
        }, terminalLaneId);
        fail('terminal lane view did not bind to the selected lane', JSON.stringify(snapshot));
      }
    };
    await waitForTerminalLaneView();
    const terminalHeaderCopy = await page.locator('.chat-terminal-head').innerText();
    if (/native CLI|structured chat|Agent terminal/i.test(terminalHeaderCopy)) fail('terminal header leaked old explanatory copy', terminalHeaderCopy);
    let terminalLane = null;
    for (let i = 0; i < 30; i += 1) {
      terminalLane = await req('GET', `/api/lanes/${terminalLaneId}`);
      if (terminalLane.status === 200 && terminalLane.body?.processMeta) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (terminalLane?.status !== 200) fail('terminal lane fetch', JSON.stringify(terminalLane?.body || null));
    if (terminalLane.body.presentationMode !== 'terminal') fail('terminal lane presentation mode', JSON.stringify(terminalLane.body));
    if ((terminalLane.body.processMeta?.args || []).includes('--json')) fail('terminal lane should not use codex --json', JSON.stringify(terminalLane.body.processMeta?.args || []));
    await page.waitForFunction(() => {
      const text = document.querySelector('.chat.chat-terminal-open .chat-terminal .lane-stream')?.textContent || '';
      return text.includes('turn_complete') || text.includes('I can help with that.');
    }, { timeout: 12000 });
    const terminalLayout = await page.evaluate(() => {
      const terminal = document.querySelector('.chat-terminal');
      const stream = document.querySelector('.chat-terminal .lane-stream');
      const composer = document.querySelector('#orchestrator-message-form');
      const tb = terminal?.getBoundingClientRect();
      const sb = stream?.getBoundingClientRect();
      return {
        composerVisible: composer ? getComputedStyle(composer).display !== 'none' : false,
        terminalHeight: tb?.height || 0,
        streamHeight: sb?.height || 0,
        bottomGap: tb && sb ? Math.round(tb.bottom - sb.bottom) : 999,
      };
    });
    if (terminalLayout.composerVisible) fail('agent terminal should replace the chat composer', JSON.stringify(terminalLayout));
    if (terminalLayout.streamHeight < Math.max(320, terminalLayout.terminalHeight * 0.58)) fail('agent terminal stream too short', JSON.stringify(terminalLayout));
    if (terminalLayout.bottomGap > 18) fail('agent terminal leaves excessive bottom gap', JSON.stringify(terminalLayout));
    const terminalHeaderLaneId = await page.locator('.chat-terminal-head').getAttribute('data-lane-id');
    if (terminalHeaderLaneId !== terminalLaneId) fail('terminal header is not bound to the terminal lane', `${terminalHeaderLaneId} expected ${terminalLaneId}`);
    await page.click(`.chat-terminal-head[data-lane-id="${terminalLaneId}"] [data-action="showLaneChat"]`);
    await page.waitForSelector(`.chat:not(.chat-terminal-open) .msg-assistant[data-lane-id="${terminalLaneId}"]`, { timeout: 10000 });
    const terminalTurnNode = page.locator(`.msg-assistant[data-lane-id="${terminalLaneId}"]`).first();
    const terminalTurnCount = await page.locator(`.msg-assistant[data-lane-id="${terminalLaneId}"]`).count();
    if (terminalTurnCount !== 1) fail('terminal lane rendered more than one assistant chat turn', String(terminalTurnCount));
    const terminalChatText = await page.locator('.chat-thread').innerText();
    if (terminalChatText.includes('Thinking...')) fail('terminal lane leaked stale thinking label after returning to chat', terminalChatText);
    if (!terminalChatText.includes('Terminal ran for') && !terminalChatText.includes('Terminal active')) fail('terminal lane missing terminal-aware chat receipt label', terminalChatText);
    if (!terminalChatText.includes('turn_complete') && !terminalChatText.includes('I can help with that.')) fail('terminal lane missing terminal transcript text', terminalChatText);
    const terminalTranscriptText = await terminalTurnNode.locator('.chat-agent-transcript').innerText().catch(() => '');
    const terminalReceiptCount = await terminalTurnNode.locator('.terminal-chat-receipt').count();
    if (terminalTranscriptText.trim() && terminalReceiptCount !== 0) {
      fail('terminal lane duplicated parsed assistant text and terminal receipt in chat', await terminalTurnNode.innerText());
    }
    if (!terminalTranscriptText.trim() && terminalReceiptCount !== 1) {
      fail('terminal lane without parsed text should keep one terminal receipt', await terminalTurnNode.innerText());
    }
    const bridgeCount = await terminalTurnNode.locator('[data-action="showLaneTerminal"]').count();
    if (bridgeCount !== 1) fail('terminal turn missing one chat-to-terminal bridge', String(bridgeCount));
    await terminalTurnNode.locator('[data-action="showLaneTerminal"]').click();
    await waitForTerminalLaneView();
    const bridgedStreamId = await page.locator('.chat.chat-terminal-open .chat-terminal .lane-stream').getAttribute('id');
    if (bridgedStreamId !== `lane-stream-${terminalLaneId}`) fail('chat-to-terminal bridge selected the wrong lane', bridgedStreamId);
    await page.click(`.chat-terminal-head[data-lane-id="${terminalLaneId}"] [data-action="showLaneChat"]`);
    await page.waitForSelector(`.chat:not(.chat-terminal-open) .msg-assistant[data-lane-id="${terminalLaneId}"]`, { timeout: 10000 });
    for (let i = 0; i < 3; i += 1) {
      await page.click(`.msg-assistant[data-lane-id="${terminalLaneId}"] [data-action="showLaneTerminal"]`);
      await waitForTerminalLaneView();
      await page.waitForFunction(() => {
        const text = document.querySelector('.chat.chat-terminal-open .chat-terminal .lane-stream')?.textContent || '';
        return text.includes('turn_complete') || text.includes('I can help with that.');
      }, { timeout: 10000 });
      const liveText = await page.locator('.chat.chat-terminal-open .chat-terminal .lane-stream').innerText();
      if (!liveText.includes('turn_complete') && !liveText.includes('I can help with that.')) {
        fail('agent terminal switch lost terminal transcript', liveText);
      }
      await page.click(`.chat-terminal-head[data-lane-id="${terminalLaneId}"] [data-action="showLaneChat"]`);
      await page.waitForSelector(`.chat:not(.chat-terminal-open) .msg-assistant[data-lane-id="${terminalLaneId}"]`, { timeout: 10000 });
      const switchedChatText = await page.locator('.chat-thread').innerText();
      if (switchedChatText.includes('Thinking...')) fail('terminal/chat switch left stale thinking state', switchedChatText);
      if (!switchedChatText.includes('Terminal ran for') && !switchedChatText.includes('Terminal active')) {
        fail('terminal/chat switch lost terminal receipt', switchedChatText);
      }
    }

    await page.fill('#orchestrator-message-form textarea[name="message"]', 'Create a follow-up turn from chat after the terminal run.');
    const followupResponsePromise = page.waitForResponse((response) => response.url().includes('/orchestrator/messages'), { timeout: 15000 });
    await page.click('#orchestrator-message-form button[type="submit"]');
    const followupResponse = await followupResponsePromise;
    if (followupResponse.status() !== 201) {
      fail('follow-up chat message response', `${followupResponse.status()} ${await followupResponse.text()}`);
    }
    const followupTurn = await followupResponse.json();
    const followupLaneId = followupTurn?.lane?.id;
    if (!followupLaneId || followupLaneId === terminalLaneId) fail('follow-up lane id', JSON.stringify(followupTurn || null));
    await page.waitForFunction(() =>
      (document.querySelector('.chat-thread')?.textContent || '').includes('I can help with that.'),
    null, { timeout: 10000 });
    const followupLane = await req('GET', `/api/lanes/${followupLaneId}`);
    if (followupLane.status !== 200) fail('follow-up lane fetch', JSON.stringify(followupLane.body));
    if (followupLane.body.presentationMode !== 'terminal') fail('follow-up CLI chat lane should use terminal presentation', JSON.stringify(followupLane.body));
    if ((followupLane.body.processMeta?.args || []).includes('--json')) fail('follow-up CLI chat lane should not use codex --json', JSON.stringify(followupLane.body.processMeta?.args || []));

    await page.click('[data-action="toggleChatTerminal"]');
    await page.waitForSelector('.chat.chat-terminal-open .chat-terminal .lane-stream', { timeout: 10000 });
    const pinnedStreamId = await page.locator('.chat.chat-terminal-open .chat-terminal .lane-stream').getAttribute('id');
    if (pinnedStreamId !== `lane-stream-${followupLaneId}`) {
      fail('terminal view did not follow the latest chat-created terminal lane', `${pinnedStreamId} expected lane-stream-${followupLaneId}`);
    }

    await page.click('[data-action="toggleChatTerminal"]');
    await page.waitForSelector(`.chat:not(.chat-terminal-open) .msg-assistant[data-lane-id="${terminalLaneId}"]`, { timeout: 10000 });
    await page.click(`.msg-assistant[data-lane-id="${terminalLaneId}"] [data-action="showLaneTerminal"]`);
    await page.waitForSelector(`#lane-stream-${terminalLaneId}`, { timeout: 10000 });
    const switchedStreamId = await page.locator('.chat.chat-terminal-open .chat-terminal .lane-stream').getAttribute('id');
    if (switchedStreamId !== `lane-stream-${terminalLaneId}`) fail('agent terminal lane selector did not switch lanes', switchedStreamId);
    await page.click(`.chat-terminal-head[data-lane-id="${terminalLaneId}"] [data-action="showLaneChat"]`);
    await page.waitForSelector(`.chat:not(.chat-terminal-open) .msg-assistant[data-lane-id="${followupLaneId}"]`, { timeout: 10000 });
    await page.click(`.msg-assistant[data-lane-id="${followupLaneId}"] [data-action="showLaneTerminal"]`);
    await page.waitForSelector(`#lane-stream-${followupLaneId}`, { timeout: 10000 });
    const repinnedStreamId = await page.locator('.chat.chat-terminal-open .chat-terminal .lane-stream').getAttribute('id');
    if (repinnedStreamId !== `lane-stream-${followupLaneId}`) fail('agent terminal lane selector did not switch back', repinnedStreamId);
    log('terminal lane', `${terminalLaneId} presentation=${terminalLane.body.presentationMode}`);
    await context.close();
  } finally {
    await browser.close();
  }
  log('done', 'ok');
} finally {
  await cleanup();
}
