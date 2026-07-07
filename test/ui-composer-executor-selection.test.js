import test from 'node:test';
import assert from 'node:assert/strict';

function installBrowserGlobals() {
  globalThis.window = {
    location: {
      origin: 'http://127.0.0.1:3001',
      protocol: 'http:',
      hostname: '127.0.0.1',
      pathname: '/',
      search: '',
      hash: '',
    },
    history: { pushState() {} },
    dispatchEvent() {},
    addEventListener() {},
    navigator: { userAgent: '' },
  };
  globalThis.document = {
    getElementById() { return null; },
  };
  globalThis.PopStateEvent = class PopStateEvent extends Event {};
}

function installExecutorProfiles(shell) {
  const controls = {
    model: { supported: true, values: ['default'], defaultValue: 'default' },
    permissions: { supported: true, values: ['auto-edit', 'plan'] },
    intelligence: { supported: true, values: ['high'] },
    speed: { supported: true, values: ['standard'] },
  };
  shell.executorProfiles = {
    codex: { capabilities: { binaryExists: true, controls } },
    claude: { capabilities: { binaryExists: true, controls } },
  };
  shell.providerCatalog = { profiles: [] };
  shell.projects = [{ id: 'project-1', defaultModel: '' }];
  shell.lanes = [];
}

test('locked composer keeps the thread executor after refresh, not the draft session leader', async () => {
  installBrowserGlobals();
  const [{ shell }, { renderOrchestratorConsole }] = await Promise.all([
    import('../public/ui/state.js'),
    import('../public/ui/render-session-parts.js'),
  ]);
  installExecutorProfiles(shell);

  const html = renderOrchestratorConsole({
    id: 'session-1',
    projectId: 'project-1',
    leader: 'codex',
    orchestratorThread: {
      executorType: 'claude',
      messages: [{ role: 'user', content: 'hello' }],
      laneIds: [],
      activeLaneId: null,
    },
  });

  assert.match(html, /<select name="executorType"[^>]*disabled/);
  assert.match(html, /<option value="claude" selected>claude<\/option>/);
});

test('send handler resolves disabled composer executor controls before falling back to Codex', async () => {
  installBrowserGlobals();
  const [{ shell }, { resolveOrchestratorExecutorType }] = await Promise.all([
    import('../public/ui/state.js'),
    import('../public/ui/handlers-lane.js'),
  ]);
  installExecutorProfiles(shell);
  shell.sessions = [{
    id: 'session-1',
    leader: 'codex',
    orchestratorThread: { executorType: 'claude' },
  }];

  const form = {
    querySelector(selector) {
      return selector === 'select[name="executorType"]' ? { value: 'claude' } : null;
    },
  };

  assert.equal(resolveOrchestratorExecutorType({ payload: {}, form, sessionId: 'session-1' }), 'claude');
  assert.equal(resolveOrchestratorExecutorType({ payload: {}, form: { querySelector: () => null }, sessionId: 'session-1' }), 'claude');
});

test('chat transcript recovers Codex agent_message text stored as raw command output', async () => {
  installBrowserGlobals();
  const { assistantEventTranscriptText } = await import('../public/ui/render-fragments.js');
  const text = assistantEventTranscriptText({
    executorType: 'codex',
    state: 'done',
    agentEvents: [{
      type: 'command.output',
      stream: 'stdout',
      content: JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_2',
          type: 'agent_message',
          text: 'Recovered answer from raw Codex JSON.',
        },
      }),
    }],
  });

  assert.equal(text, 'Recovered answer from raw Codex JSON.');
});

test('terminal view shows only real terminal tabs before an agent lane exists', async () => {
  installBrowserGlobals();
  const [{ shell }, { renderChatTerminalInner }] = await Promise.all([
    import('../public/ui/state.js'),
    import('../public/ui/render-session-parts.js'),
  ]);
  installExecutorProfiles(shell);
  shell.chatTerminalTabBySession = { 'session-terminal-tabs': 'command' };
  shell.chatTerminalAgentLaneBySession = {};
  shell.operatorTerminalsBySession = {
    'session-terminal-tabs': {
      terminals: [{ id: 'terminal-1', title: 'command-deck', state: 'running', shell: 'zsh', cwd: '/repo' }],
    },
  };
  shell.operatorTerminalActiveBySession = { 'session-terminal-tabs': 'terminal-1' };

  const html = renderChatTerminalInner({
    id: 'session-terminal-tabs',
    projectId: 'project-1',
    leader: 'codex',
    orchestratorThread: { messages: [], laneIds: [], activeLaneId: null },
  });

  assert.doesNotMatch(html, /data-tab="agent"/);
  assert.doesNotMatch(html, /data-tab="command"/);
  assert.doesNotMatch(html, /chat-terminal-tabs/);
  assert.doesNotMatch(html, />orca<\/span>/);
  assert.match(html, /<strong>command-deck<\/strong>/);
  assert.match(html, /operator-terminal-current/);
  assert.doesNotMatch(html, /chat-terminal-head compact/);
  assert.doesNotMatch(html, /Command tab/);
});

test('terminal view prefers an attached native agent lane over the raw shell', async () => {
  installBrowserGlobals();
  const [{ shell }, { renderChatTerminalInner }] = await Promise.all([
    import('../public/ui/state.js'),
    import('../public/ui/render-session-parts.js'),
  ]);
  installExecutorProfiles(shell);
  shell.chatTerminalTabBySession = { 'session-attached-lane': 'command' };
  shell.operatorTerminalsBySession = {
    'session-attached-lane': {
      terminals: [{
        id: 'terminal-attached',
        title: 'command-deck',
        state: 'running',
        shell: 'zsh',
        cwd: '/repo',
        agentBridge: { state: 'active', executorType: 'codex', activeLaneId: 'lane-attached' },
      }],
    },
  };
  shell.operatorTerminalActiveBySession = { 'session-attached-lane': 'terminal-attached' };
  shell.lanes = [{
    id: 'lane-attached',
    sessionId: 'session-attached-lane',
    projectId: 'project-1',
    owner: 'orchestrator',
    executorType: 'codex',
    title: 'command-deck',
    state: 'running',
    presentationMode: 'terminal',
    processMeta: {
      terminalWrapper: 'pty',
      attachedOperatorTerminalId: 'terminal-attached',
    },
  }];

  const html = renderChatTerminalInner({
    id: 'session-attached-lane',
    projectId: 'project-1',
    leader: 'codex',
    orchestratorThread: { messages: [], laneIds: ['lane-attached'], activeLaneId: 'lane-attached' },
  });

  assert.match(html, /codex terminal agent/);
  assert.match(html, /lane-stream-lane-attached/);
  assert.doesNotMatch(html, /operator-terminal-stream-terminal-attached/);
  assert.doesNotMatch(html, /data-tab="command"/);
});

test('operator terminal title uses human project context instead of internal worktree ids', async () => {
  installBrowserGlobals();
  const { defaultOperatorTerminalTitle } = await import('../public/ui/operator-terminal.js');

  assert.equal(
    defaultOperatorTerminalTitle({
      repoRoot: '/Users/alexrodriguez/Documents/Projects/web/command-deck/command-deck-client/',
      worktreeRoot: '/Users/alexrodriguez/Documents/Projects/web/command-deck/artifacts/session-uuid',
      name: 'Orca UI',
    }),
    'command-deck-client',
  );
  assert.equal(
    defaultOperatorTerminalTitle({
      worktreeRoot: '/Users/alexrodriguez/Documents/Projects/web/command-deck/artifacts/019f3e86-d157-7bb2-86d6-ea38cb885995',
      name: 'Terminal Message Session',
    }),
    'Terminal Message Session',
  );
  assert.equal(defaultOperatorTerminalTitle({}), 'Shell');
});

test('operator terminal tabs disambiguate duplicate shell names without repeating active state metadata', async () => {
  installBrowserGlobals();
  const [{ shell }, { renderChatTerminalInner }] = await Promise.all([
    import('../public/ui/state.js'),
    import('../public/ui/render-session-parts.js'),
  ]);
  installExecutorProfiles(shell);
  shell.chatTerminalTabBySession = { 'session-duplicate-shells': 'command' };
  shell.chatTerminalAgentLaneBySession = {};
  shell.operatorTerminalsBySession = {
    'session-duplicate-shells': {
      terminals: [
        { id: 'terminal-1', title: 'command-deck', state: 'running', shell: 'zsh', cwd: '/repo' },
        { id: 'terminal-2', title: 'command-deck', state: 'stopped', shell: 'zsh', cwd: '/repo' },
      ],
    },
  };
  shell.operatorTerminalActiveBySession = { 'session-duplicate-shells': 'terminal-1' };

  const html = renderChatTerminalInner({
    id: 'session-duplicate-shells',
    projectId: 'project-1',
    leader: 'codex',
    orchestratorThread: { messages: [], laneIds: [], activeLaneId: null },
  });

  assert.match(html, />1\. command-deck<\/span>/);
  assert.match(html, />2\. command-deck<\/span>/);
  assert.equal((html.match(/Running/g) || []).length, 1);
  assert.equal((html.match(/Stopped/g) || []).length, 1);
});
