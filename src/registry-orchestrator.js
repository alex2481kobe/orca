// Orchestrator chat thread + message-send methods, as a prototype mixin for
// OrcaRegistry. Extracted from registry.js.

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { nowIso, clonePayload, normalizeExecutorType } from './registry-utils.js';

const MAX_ORCHESTRATOR_THREAD_MESSAGES = 500;

function safeChatText(value, max = 12000) {
  return String(value || '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ').trim().slice(0, max);
}

function buildOrchestratorPrompt({
  project,
  session,
  message,
  messages = [],
  model = '',
  permissionsProfile = '',
  intelligenceProfile = '',
  baseUrl = '',
  nextActionUrl = '',
  discoveryUrl = '',
  executorCapabilities = null,
} = {}) {
  const transcript = messages
    .slice(-20)
    .map((entry) => `${String(entry.role || 'user').toUpperCase()}: ${safeChatText(entry.content, 3000)}`)
    .join('\n\n');
  const apiBase = String(baseUrl || '').replace(/\/+$/, '');
  return [
    'You are the Orca orchestration agent for this project/session.',
    'Own decomposition, planning, lane creation, executor assignment, and audit handoff.',
    'Do not ask the human to manually create executor lanes when you can create them through Orca tools.',
    'Use the scoped tool lease from ORCA_TOOL_LEASE_TOKEN, never the full API token.',
    apiBase ? `Orca base URL: ${apiBase}` : '',
    discoveryUrl ? `Tool discovery URL: ${discoveryUrl}` : '',
    nextActionUrl ? `Next-action URL: ${nextActionUrl}` : '',
    'For HTTP tool calls, send header x-orca-tool-lease: $ORCA_TOOL_LEASE_TOKEN.',
    executorCapabilities ? `Executor capability matrix available to you:\n${safeChatText(JSON.stringify(executorCapabilities, null, 2), 6000)}` : '',
    `Project: ${project?.name || project?.id || 'unknown'}`,
    `Session: ${session?.name || session?.id || 'unknown'}`,
    model ? `Requested model: ${safeChatText(model, 120)}` : '',
    permissionsProfile ? `Run mode / permissions: ${safeChatText(permissionsProfile, 120)}` : '',
    intelligenceProfile ? `Requested intelligence level: ${safeChatText(intelligenceProfile, 80)}` : '',
    session?.repoRoot ? `Repository root: ${session.repoRoot}` : `Session workspace: ${session?.worktreeRoot || ''}`,
    transcript ? `Recent conversation:\n${transcript}` : '',
    `Current user request:\n${safeChatText(message)}`,
  ].filter(Boolean).join('\n\n');
}

export const orchestratorMethods = {
  ensureOrchestratorThread(session) {
    if (!session.orchestratorThread || typeof session.orchestratorThread !== 'object') {
      session.orchestratorThread = {
        id: randomUUID(),
        messages: [],
        laneIds: [],
        activeLaneId: null,
        executorType: null,
        updatedAt: nowIso(),
      };
    }
    if (!Array.isArray(session.orchestratorThread.messages)) {
      session.orchestratorThread.messages = [];
    }
    if (session.orchestratorThread.messages.length > MAX_ORCHESTRATOR_THREAD_MESSAGES) {
      session.orchestratorThread.messages = session.orchestratorThread.messages.slice(-MAX_ORCHESTRATOR_THREAD_MESSAGES);
    }
    if (!Array.isArray(session.orchestratorThread.laneIds)) {
      session.orchestratorThread.laneIds = [];
    }
    return session.orchestratorThread;
  },

  appendOrchestratorThreadMessage(thread, message) {
    if (!thread || !message) return;
    if (!Array.isArray(thread.messages)) {
      thread.messages = [];
    }
    thread.messages.push(message);
    if (thread.messages.length > MAX_ORCHESTRATOR_THREAD_MESSAGES) {
      thread.messages = thread.messages.slice(-MAX_ORCHESTRATOR_THREAD_MESSAGES);
    }
  },

  getOrchestratorThread(sessionLocator) {
    const session = this.getSession(sessionLocator);
    if (!session) throw { status: 404, message: 'Session not found.' };
    const thread = this.ensureOrchestratorThread(session);
    return clonePayload({
      ...thread,
      sessionId: session.id,
      projectId: session.projectId,
      activeLane: thread.activeLaneId ? this.getLane(thread.activeLaneId) || null : null,
    });
  },

  notifyOrchestratorManualLaneStop(lane, actor = 'dashboard', reason = '') {
    if (!lane || lane.owner === 'orchestrator') return;
    if (!['dashboard', 'operator', 'user'].includes(String(actor || '').toLowerCase())) return;
    const session = this.getSession(lane.sessionId);
    if (!session) return;
    const thread = this.ensureOrchestratorThread(session);
    const activeLaneId = thread.activeLaneId || '';
    const hasOrchestrator = activeLaneId || (Array.isArray(thread.laneIds) && thread.laneIds.length);
    if (!hasOrchestrator) return;
    this.appendOrchestratorThreadMessage(thread, {
      id: randomUUID(),
      role: 'system',
      content: `Operator manually stopped executor lane "${lane.title}". Reason: ${reason || 'stopped by dashboard'}.`,
      laneId: lane.id,
      createdAt: nowIso(),
    });
    thread.updatedAt = nowIso();
  },

  resolveOrchestratorExecutorType(session, requestedType = '') {
    const supported = this.getSupportedExecutorTypes();
    const requested = normalizeExecutorType(requestedType);
    if (requested && supported.includes(requested)) return requested;
    const leader = normalizeExecutorType(session?.leader);
    if (leader && supported.includes(leader) && leader !== 'mock') return leader;
    return supported.includes('codex') ? 'codex' : 'mock';
  },

  async sendOrchestratorMessage(sessionLocator, {
    message,
    executorType,
    model,
    permissionsProfile,
    intelligenceProfile,
    targetUrl,
    attachments = [],
    baseUrl = '',
    discoveryUrl = '',
    nextActionUrl = '',
  } = {}, context = {}) {
    const session = this.getSession(sessionLocator);
    if (!session) throw { status: 404, message: 'Session not found.' };
    const text = safeChatText(message);
    const attachmentList = (Array.isArray(attachments) ? attachments : [])
      .filter((entry) => entry && (entry.path || entry.url))
      .slice(0, 20);
    if (!text && !attachmentList.length) throw { status: 422, message: 'Message or attachment is required.' };

    const project = this.getProject(session.projectId);
    const thread = this.ensureOrchestratorThread(session);
    const now = nowIso();
    const userMessage = {
      id: randomUUID(),
      role: 'user',
      content: text,
      attachments: attachmentList.map((entry) => ({
        name: String(entry.name || 'attachment').slice(0, 200),
        url: String(entry.url || '').slice(0, 500),
        contentType: String(entry.contentType || '').slice(0, 120),
      })),
      createdAt: now,
    };
    this.appendOrchestratorThreadMessage(thread, userMessage);
    // Resolve each attachment's server-side absolute path from its /artifacts URL
    // (never trust a client-supplied path), contained under artifacts/.
    const artifactsRoot = path.join(process.cwd(), 'artifacts');
    const resolveAttachmentPath = (entry) => {
      const url = String(entry.url || '');
      if (!url.startsWith('/artifacts/')) return null;
      const abs = path.join(process.cwd(), url.replace(/^\/+/, ''));
      return abs.startsWith(artifactsRoot + path.sep) ? abs : null;
    };
    const promptText = attachmentList.length
      ? `${text}\n\nAttached files (absolute paths you can read):\n${attachmentList.map(resolveAttachmentPath).filter(Boolean).map((p) => `- ${p}`).join('\n')}`
      : text;

    const resolvedExecutorType = this.resolveOrchestratorExecutorType(session, executorType);
    const executorCapabilities = this.getExecutorCapabilitiesMatrix();
    const turnNumber = thread.messages.filter((entry) => entry.role === 'user').length;
    const workdir = session.repoRoot || session.worktreeRoot;
    let lane;
    try {
      lane = await this.createLane(session.id, {
        title: `Orchestrator turn ${turnNumber}`,
        taskDescription: (text || '(attachment)').slice(0, 1000),
        executorType: resolvedExecutorType,
        owner: 'orchestrator',
        workdir,
        sharedWorktree: true,
        taskPrompt: buildOrchestratorPrompt({
          project,
          session,
          message: promptText,
          messages: thread.messages,
          model,
          permissionsProfile,
          intelligenceProfile,
          baseUrl,
          discoveryUrl,
          nextActionUrl,
          executorCapabilities,
        }),
        model,
        permissionsProfile,
        intelligenceProfile,
        targetUrl,
      }, {
        actor: context.actor || 'dashboard',
        approved: context.approved,
      });
    } catch (error) {
      thread.messages = thread.messages.filter((entry) => entry.id !== userMessage.id);
      throw error;
    }

    const nextAction = context.nextAction || null;
    let lease = null;
    if (nextAction && Array.isArray(nextAction.allowedTools) && nextAction.allowedTools.length) {
      lease = this.createToolLease({
        role: 'orchestrator',
        projectId: session.projectId,
        sessionId: session.id,
        laneId: lane.id,
        allowedTools: nextAction.allowedTools,
        ttlMs: 24 * 60 * 60 * 1000,
        actor: 'orchestrator-bootstrap',
      });
      this.laneRuntimeEnv.set(String(lane.id), {
        ORCA_TOOL_LEASE_TOKEN: lease.leaseToken,
        ORCA_AGENT_TOOLS_BASE_URL: String(baseUrl || ''),
        ORCA_AGENT_TOOLS_DISCOVERY_URL: String(discoveryUrl || ''),
        ORCA_AGENT_TOOLS_NEXT_ACTION_URL: String(nextActionUrl || ''),
      });
    }

    thread.laneIds = [...new Set([...thread.laneIds, lane.id])].slice(-100);
    thread.activeLaneId = lane.id;
    thread.executorType = resolvedExecutorType;
    thread.updatedAt = nowIso();
    this.appendOrchestratorThreadMessage(thread, {
      id: randomUUID(),
      role: 'assistant',
      content: `Started ${resolvedExecutorType} orchestrator lane "${lane.title}".`,
      laneId: lane.id,
      executorCapabilities: lane.executorCapabilities || null,
      createdAt: thread.updatedAt,
    });
    this.recordAudit({
      type: 'orchestrator_message_queued',
      actor: context.actor || 'dashboard',
      projectId: session.projectId,
      sessionId: session.id,
      laneId: lane.id,
      summary: `Queued orchestrator turn for session ${session.name}`,
      status: 'passed',
      evidence: {
        messageId: userMessage.id,
        executorType: resolvedExecutorType,
        executorCapabilities: lane.executorCapabilities || null,
        leaseId: lease?.lease?.id || null,
      },
    });
    this.persistState();
    return clonePayload({
      thread,
      message: userMessage,
      lane,
      lease: lease ? lease.lease : null,
    });
  },
};
