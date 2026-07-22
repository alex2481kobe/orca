const MAX_EVENT_CONTENT = 12000;
// Ceiling for the un-flushed partial (newline-free) line buffer. An executor that
// emits megabytes without a newline would otherwise grow buffers[stream] unbounded;
// once the retained partial exceeds this we flush + reset it as a truncated event.
const MAX_PARTIAL_LINE = 64 * 1024;

function cleanText(value, max = MAX_EVENT_CONTENT) {
  return String(value ?? '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .slice(0, max);
}

function event(type, fields = {}) {
  return {
    type,
    ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && value !== null && value !== '')),
  };
}

function usageFrom(...candidates) {
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function contentText(content) {
  if (typeof content === 'string') return cleanText(content);
  if (!Array.isArray(content)) return '';
  return cleanText(content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object') return part.text || part.content || '';
      return '';
    })
    .filter(Boolean)
    .join(''));
}

function commandFromToolCall(toolCall) {
  if (!toolCall || typeof toolCall !== 'object') return '';
  const containers = [
    toolCall.terminalToolCall,
    toolCall.shellToolCall,
    toolCall.bashToolCall,
    toolCall.commandToolCall,
  ].filter(Boolean);
  for (const container of containers) {
    const args = container.args || {};
    const command = args.command || args.cmd || args.input;
    if (command) return cleanText(command, 1000);
  }
  return '';
}

function toolNameFromCall(toolCall) {
  if (!toolCall || typeof toolCall !== 'object') return '';
  const key = Object.keys(toolCall).find((name) => name.endsWith('ToolCall') || name.toLowerCase().includes('tool'));
  return key ? key.replace(/ToolCall$/, '') : '';
}

function normalizeCursorEvent(data, source) {
  const type = String(data.type || '').toLowerCase();
  const subtype = String(data.subtype || '').toLowerCase();
  if (type === 'system' && subtype === 'init') {
    return [event('agent.started', {
      source,
      title: 'Agent initialized',
      content: [data.model, data.cwd].filter(Boolean).join(' · '),
      externalSessionId: data.session_id,
    })];
  }
  if (type === 'user') {
    return [event('message.user', {
      source,
      content: contentText(data.message?.content || data.content),
      externalSessionId: data.session_id,
    })];
  }
  if (type === 'assistant') {
    return [event('message.assistant.delta', {
      source,
      content: contentText(data.message?.content || data.content),
      externalSessionId: data.session_id,
    })];
  }
  if (type === 'tool_call') {
    const toolName = toolNameFromCall(data.tool_call);
    const command = commandFromToolCall(data.tool_call);
    return [event(subtype === 'completed' ? 'tool.completed' : 'tool.started', {
      source,
      toolName,
      command,
      callId: data.call_id,
      externalSessionId: data.session_id,
      content: cleanText(JSON.stringify(data.tool_call || {}), 2000),
    })];
  }
  if (type === 'result') {
    return [
      event(data.is_error ? 'error' : 'message.assistant.final', {
        source,
        content: cleanText(data.result || data.error || ''),
        externalSessionId: data.session_id,
        durationMs: data.duration_ms,
        usage: usageFrom(data.usage, data.usage_metrics, data.usageMetadata, data.stats),
      }),
      event(data.is_error ? 'agent.failed' : 'agent.done', {
        source,
        title: data.is_error ? 'Agent failed' : 'Agent completed',
        externalSessionId: data.session_id,
      }),
    ];
  }
  return [];
}

function normalizeClaudeEvent(data, source) {
  if (data.type === 'stream_event') {
    const delta = data.event?.delta || {};
    if (delta.type === 'text_delta' && delta.text) {
      return [event('message.assistant.delta', { source, content: cleanText(delta.text) })];
    }
    const tool = data.event?.content_block || data.event?.delta;
    if (tool?.type === 'tool_use') {
      return [event('tool.started', {
        source,
        toolName: tool.name,
        callId: tool.id,
        content: cleanText(JSON.stringify(tool.input || {}), 2000),
      })];
    }
  }
  if (data.type === 'system') {
    return [event('agent.started', {
      source,
      title: 'Claude initialized',
      externalSessionId: data.session_id,
    })];
  }
  if (data.type === 'assistant') {
    return [event('message.assistant.delta', {
      source,
      content: contentText(data.message?.content || data.content),
      externalSessionId: data.session_id,
    })];
  }
  if (data.type === 'result') {
    return [
      event(data.is_error ? 'error' : 'message.assistant.final', {
        source,
        content: cleanText(data.result || data.error || ''),
        externalSessionId: data.session_id,
        durationMs: data.duration_ms,
        usage: usageFrom(data.usage, data.usage_metrics, data.usageMetadata, data.stats),
      }),
      event(data.is_error ? 'agent.failed' : 'agent.done', {
        source,
        title: data.is_error ? 'Claude failed' : 'Claude completed',
        externalSessionId: data.session_id,
      }),
    ];
  }
  return normalizeCursorEvent(data, source);
}

function normalizeCodexEvent(data, source) {
  const msg = data.msg && typeof data.msg === 'object' ? data.msg : data;
  const type = String(msg.type || data.type || '').toLowerCase();
  if (type === 'item.completed' && msg.item && typeof msg.item === 'object') {
    const itemType = String(msg.item.type || '').toLowerCase();
    if (itemType === 'agent_message' || itemType === 'assistant_message') {
      const content = cleanText(msg.item.text || msg.item.content || '');
      if (!content) return [];
      return [event('message.assistant.final', {
        source,
        content,
      })];
    }
    if (itemType === 'mcp_tool_call' || itemType === 'tool_call') {
      const result = typeof msg.item.result === 'string'
        ? msg.item.result
        : JSON.stringify(msg.item.result || {});
      return [event('tool.completed', {
        source,
        toolName: msg.item.tool || msg.item.name,
        callId: msg.item.id,
        content: cleanText(msg.item.error?.message || result || '', 2000),
      })];
    }
  }
  if ((type === 'item.started' || type === 'item.start') && msg.item && typeof msg.item === 'object') {
    const itemType = String(msg.item.type || '').toLowerCase();
    if (itemType === 'mcp_tool_call' || itemType === 'tool_call') {
      return [event('tool.started', {
        source,
        toolName: msg.item.tool || msg.item.name,
        callId: msg.item.id,
      })];
    }
  }
  if (type === 'text' || type === 'message') {
    return [event('message.assistant.delta', {
      source,
      content: cleanText(msg.content || msg.text || data.content || ''),
    })];
  }
  if (type === 'exec_approval_request' || type === 'commandexecution' || type === 'command_execution') {
    return [event('command.started', {
      source,
      command: cleanText(msg.command || msg.cmd || msg.content || '', 1000),
      content: cleanText(msg.content || msg.command || '', 2000),
    })];
  }
  if (type === 'apply_patch_approval_request') {
    return [event('file.changed', {
      source,
      title: 'Patch proposed',
      content: cleanText(msg.content || msg.patch || '', 4000),
    })];
  }
  if (type === 'turn_complete' || type === 'agent-turn-complete' || type === 'turn.completed') {
    const finalContent = cleanText(msg.content || data.result || '');
    const usage = usageFrom(msg.usage, msg.usage_metrics, msg.usageMetadata, msg.stats, data.usage, data.usage_metrics, data.usageMetadata, data.stats);
    const done = event('agent.done', {
      source,
      title: 'Codex completed',
      content: finalContent,
      usage,
    });
    return finalContent
      ? [event('message.assistant.final', { source, content: finalContent, usage }), done]
      : [done];
  }
  if (type === 'error') {
    return [event('error', {
      source,
      content: cleanText(msg.message || msg.content || data.error || 'Codex error'),
    })];
  }
  return [];
}

function normalizeGeminiEvent(data, source) {
  if (data.response || data.stats) {
    return [
      event('message.assistant.final', {
        source,
        content: cleanText(data.response || ''),
        usage: usageFrom(data.usage, data.usageMetadata, data.stats),
      }),
      event('agent.done', {
        source,
        title: 'Gemini completed',
      }),
    ];
  }
  return normalizeCursorEvent(data, source);
}

function normalizeParsedEvent(executorType, data, stream) {
  const source = executorType || 'cli';
  const normalizedType = String(executorType || '').toLowerCase();
  if (stream === 'stderr') {
    return [event('command.output', { source, stream, content: cleanText(JSON.stringify(data)) })];
  }
  if (normalizedType === 'codex') return normalizeCodexEvent(data, source);
  if (normalizedType === 'claude') return normalizeClaudeEvent(data, source);
  if (normalizedType === 'gemini-cli') return normalizeGeminiEvent(data, source);
  if (normalizedType === 'composer-cli') return normalizeCursorEvent(data, source);
  return normalizeCursorEvent(data, source);
}

function createAgentEventNormalizer(executorType) {
  const buffers = { stdout: '', stderr: '' };
  return {
    consume(stream, chunk) {
      const safeStream = stream === 'stderr' ? 'stderr' : 'stdout';
      const text = String(chunk || '');
      if (!text) return [];
      buffers[safeStream] += text;
      const lines = buffers[safeStream].split(/\r?\n/);
      buffers[safeStream] = lines.pop() || '';
      const events = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          const normalized = normalizeParsedEvent(executorType, parsed, safeStream);
          if (normalized.length) {
            events.push(...normalized);
          } else {
            events.push(event('command.output', { source: executorType, stream: safeStream, content: cleanText(trimmed) }));
          }
        } catch {
          events.push(event('command.output', { source: executorType, stream: safeStream, content: cleanText(trimmed) }));
        }
      }
      // The trailing partial (newline-free) line is retained for the next chunk. Cap it:
      // if it has grown past the ceiling, flush the buffered prefix as a truncated
      // command.output event (same shape as the newline path, capped downstream by
      // cleanText/MAX_EVENT_CONTENT) and reset so no line-buffer exceeds MAX_PARTIAL_LINE.
      if (buffers[safeStream].length > MAX_PARTIAL_LINE) {
        const truncated = buffers[safeStream].trim();
        buffers[safeStream] = '';
        if (truncated) {
          events.push(event('command.output', { source: executorType, stream: safeStream, content: cleanText(truncated) }));
        }
      }
      return events;
    },
    flush() {
      const events = [];
      for (const stream of ['stdout', 'stderr']) {
        const content = buffers[stream].trim();
        buffers[stream] = '';
        if (content) events.push(event('command.output', { source: executorType, stream, content: cleanText(content) }));
      }
      return events;
    },
  };
}

export {
  createAgentEventNormalizer,
};
