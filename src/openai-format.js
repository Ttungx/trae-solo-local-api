const { v4: uuidv4 } = require('./uuid');

function createOpenAIChatCompletion(id, model, content, finishReason, reasoning, usage, toolCalls) {
  const message = {
    role: 'assistant',
    content: content
  };
  if (reasoning) {
    message.reasoning_content = reasoning;
  }
  if (toolCalls && toolCalls.length > 0) {
    message.tool_calls = toolCalls;
    // OpenAI often uses null content when only tool_calls are present
    if (!content) message.content = null;
  }
  return {
    id: id || `chatcmpl-${uuidv4()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{
      index: 0,
      message: message,
      finish_reason: finishReason || (toolCalls && toolCalls.length ? 'tool_calls' : 'stop')
    }],
    usage: usage || {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0
    }
  };
}

function createOpenAIStreamChunk(id, model, delta, finishReason, usage) {
  const chunk = {
    id: id || `chatcmpl-${uuidv4()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{
      index: 0,
      delta: delta,
      finish_reason: finishReason || null
    }]
  };
  if (usage) {
    chunk.usage = {
      prompt_tokens: usage.prompt_tokens || 0,
      completion_tokens: usage.completion_tokens || 0,
      total_tokens: usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0)
    };
  }
  return chunk;
}

function createOpenAIModels(models) {
  return {
    object: 'list',
    data: models.map(m => ({
      id: m,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'trae'
    }))
  };
}

function parseLlmUtilsChatSSE(rawBody) {
  const events = [];
  const lines = rawBody.split('\n');
  let currentEvent = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('event:')) {
      currentEvent = { event: trimmed.substring(6).trim(), data: '' };
      events.push(currentEvent);
    } else if (trimmed.startsWith('data:') && currentEvent) {
      currentEvent.data = trimmed.substring(5).trim();
    }
  }

  return events;
}

function parseLlmUtilsChatStream(rawLine, currentEventName) {
  if (!rawLine || rawLine.trim() === '') return null;

  if (rawLine.startsWith('event:')) {
    return { _type: 'event_name', value: rawLine.substring(6).trim() };
  }

  if (rawLine.startsWith('data:')) {
    const data = rawLine.substring(5).trim();
    if (data === '[DONE]') return { done: true };

    try {
      const parsed = JSON.parse(data);
      return normalizeLlmUtilsChunk(parsed, currentEventName);
    } catch (e) {
      return { raw: data };
    }
  }

  return null;
}

function normalizeLlmUtilsChunk(chunk, eventName) {
  if (!chunk || typeof chunk !== 'object') return chunk;

  if (eventName === 'output') {
    const result = { type: 'text' };

    // Old format: {"response": "..."}
    if (chunk.response) {
      const resp = chunk.response;
      if (resp.startsWith('Building prompt:') || resp.startsWith('Completed building prompt')) {
        return { type: 'progress', data: resp };
      }
      result.content = (result.content || '') + resp;
    }
    // New format (2026-05): {"type":"text","content":"..."}
    if (chunk.content) {
      result.content = (result.content || '') + chunk.content;
    }

    // Old format: {"reasoning_content": "..."}
    if (chunk.reasoning_content) {
      result.reasoning = (result.reasoning || '') + chunk.reasoning_content;
    }
    // New format (2026-05): {"reasoning": "..."}
    if (chunk.reasoning) {
      result.reasoning = (result.reasoning || '') + chunk.reasoning;
    }

    if (chunk.tool_calls) {
      result.tool_calls = chunk.tool_calls;
    }
    if (!result.content && !result.reasoning && !result.tool_calls) return null;
    return result;
  }

  if (eventName === 'done') {
    return { type: 'done', finish_reason: chunk.finish_reason || 'stop' };
  }

  if (eventName === 'error') {
    return {
      type: 'error',
      code: chunk.code,
      message: chunk.message,
      extra: chunk.extra
    };
  }

  if (eventName === 'token_usage') {
    return { type: 'token_usage', data: chunk };
  }

  if (eventName === 'extra_info') {
    return { type: 'extra_info', data: chunk };
  }

  if (eventName === 'metadata') {
    return { type: 'metadata', data: chunk };
  }

  if (eventName === 'timing_cost') {
    return { type: 'timing_cost', data: chunk };
  }

  if (eventName === 'progress_notice') {
    return { type: 'progress', data: chunk };
  }

  // Queue events - 排队相关事件
  if (eventName === 'queue_begin') {
    return { type: 'queue_begin', data: chunk };
  }

  if (eventName === 'request_wait_in_queue') {
    const position = chunk?.data?.position || chunk?.position || 0;
    if (position > 0) {
      // 只在位置是 10 的倍数或 < 20 时输出，减少刷屏
      if (position <= 20 || position % 50 === 0) {
        console.log(`[queue] Position: ${position} - waiting...`);
      }
    }
    return { type: 'queue_wait', position: position, data: chunk };
  }

  if (eventName === 'queue_end') {
    console.log(`[queue] Queue ended - request processing...`);
    return { type: 'queue_end', data: chunk };
  }

  return { type: eventName || 'unknown', data: chunk };
}

function llmUtilsChunkToOpenAI(chunk, id, model, includeReasoning) {
  if (!chunk) return null;

  if (chunk.type === 'done') {
    return createOpenAIStreamChunk(id, model, {}, chunk.finish_reason || 'stop');
  }

  if (chunk.type === 'text') {
    const delta = {};
    if (chunk.content) {
      delta.content = chunk.content;
    }
    if (includeReasoning && chunk.reasoning) {
      delta.reasoning_content = chunk.reasoning;
    }
    // Native Trae tool_calls on output events
    if (chunk.tool_calls && Array.isArray(chunk.tool_calls) && chunk.tool_calls.length > 0) {
      delta.tool_calls = chunk.tool_calls.map((tc, i) => {
        const name = tc.name || tc.function?.name || tc.tool_name || '';
        const args = tc.params != null ? tc.params
          : (tc.arguments != null ? tc.arguments
            : (tc.input != null ? tc.input
              : (tc.function?.arguments != null ? tc.function.arguments : {})));
        const argsStr = typeof args === 'string' ? args : JSON.stringify(args || {});
        return {
          index: tc.index != null ? tc.index : i,
          id: tc.id || `call_${uuidv4().replace(/-/g, '').slice(0, 24)}`,
          type: 'function',
          function: {
            name,
            arguments: argsStr
          }
        };
      });
    }
    if (Object.keys(delta).length === 0) return null;
    return createOpenAIStreamChunk(id, model, delta, null);
  }

  if (chunk.type === 'error') {
    return createOpenAIStreamChunk(id, model, {
      content: `\n[Error ${chunk.code || ''}: ${chunk.message || 'unknown'}]`
    }, null);
  }

  return null;
}

/**
 * Extract <toolcall>...</toolcall> / <tool_call>...</tool_call> blocks from assistant text.
 * Also supports fenced blocks: ```tool_call ... ``` / ```json tool ... ```
 * Returns { text, toolCalls } where text has toolcall tags removed.
 */
function extractToolcallsFromText(text, parseToolcallContent) {
  if (!text || typeof text !== 'string') {
    return { text: text || '', toolCalls: [] };
  }
  let cleaned = text;
  const toolCalls = [];

  const pushParsed = (inner) => {
    try {
      const parsed = typeof parseToolcallContent === 'function'
        ? parseToolcallContent(inner)
        : JSON.parse(String(inner).trim());
      const name = parsed.name || parsed.tool || parsed.tool_name || '';
      let finalParams = parsed.params != null ? parsed.params
        : (parsed.arguments != null ? parsed.arguments
          : (parsed.input != null ? parsed.input : parsed));
      if (finalParams && typeof finalParams === 'object' && finalParams.name && finalParams === parsed) {
        const { name: _n, tool: _t, tool_name: _tn, ...rest } = finalParams;
        finalParams = rest;
      }
      if (!name) return false;
      toolCalls.push({
        id: `call_${uuidv4().replace(/-/g, '').slice(0, 24)}`,
        type: 'function',
        function: {
          name: String(name),
          arguments: typeof finalParams === 'string' ? finalParams : JSON.stringify(finalParams || {})
        }
      });
      return true;
    } catch (e) {
      return false;
    }
  };

  // 1) XML-style toolcall / tool_call tags
  const re = /<(?:tool_call|toolcall)(?:\s[^>]*)?>([\s\S]*?)<\/(?:tool_call|toolcall)>/gi;
  const matches = [];
  let match;
  re.lastIndex = 0;
  while ((match = re.exec(text)) !== null) {
    matches.push({ full: match[0], inner: match[1] });
  }
  for (const m of matches) {
    cleaned = cleaned.replace(m.full, '');
    if (!pushParsed(m.inner)) {
      cleaned += '\n[unparsed toolcall]\n';
    }
  }

  // 2) Fenced blocks used by some models: ```tool_call\n{...}\n```
  const fenceRe = /```(?:tool_call|toolcall|json)\s*\n([\s\S]*?)```/gi;
  const fences = [];
  while ((match = fenceRe.exec(cleaned)) !== null) {
    const inner = match[1].trim();
    if (/["']name["']\s*:/.test(inner) || /["']tool["']\s*:/.test(inner)) {
      fences.push({ full: match[0], inner });
    }
  }
  for (const f of fences) {
    if (pushParsed(f.inner)) cleaned = cleaned.replace(f.full, '');
  }

  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
  return { text: cleaned, toolCalls };
}

/**
 * Streaming toolcall detector: feed text deltas, get { emitText, finishedToolCalls }.
 * Buffers partial <toolcall> tags so we don't leak incomplete tags to the client.
 */
function createOpenAIToolcallStreamFilter(parseToolcallContent) {
  const state = {
    buffer: '',
    inToolCall: false,
    finishedToolCalls: [],
    toolCallIndex: 0
  };

  function tryParseInner(inner) {
    try {
      const parsed = typeof parseToolcallContent === 'function'
        ? parseToolcallContent(inner)
        : JSON.parse(String(inner).trim());
      const name = parsed.name || parsed.tool || parsed.tool_name || '';
      let params = parsed.params != null ? parsed.params
        : (parsed.arguments != null ? parsed.arguments
          : (parsed.input != null ? parsed.input : parsed));
      if (params && typeof params === 'object' && params.name && params === parsed) {
        const { name: _n, tool: _t, tool_name: _tn, ...rest } = params;
        params = rest;
      }
      if (!name) return null;
      const tc = {
        index: state.toolCallIndex++,
        id: `call_${uuidv4().replace(/-/g, '').slice(0, 24)}`,
        type: 'function',
        function: {
          name: String(name),
          arguments: typeof params === 'string' ? params : JSON.stringify(params || {})
        }
      };
      state.finishedToolCalls.push(tc);
      return tc;
    } catch (e) {
      console.error(`[openai-format] toolcall parse fail: ${e.message}`);
      return null;
    }
  }

  function feed(textChunk) {
    if (!textChunk) return { emitText: '', finishedToolCalls: [] };
    state.buffer += textChunk;
    let emitText = '';
    const finished = [];

    while (state.buffer.length > 0) {
      if (state.inToolCall) {
        let closeIdx = state.buffer.toLowerCase().indexOf('</toolcall>');
        let closeLen = '</toolcall>'.length;
        let closeToken = '</toolcall>';
        const alt = state.buffer.toLowerCase().indexOf('</tool_call>');
        if (closeIdx < 0 || (alt >= 0 && alt < closeIdx)) {
          if (alt >= 0) {
            closeIdx = alt;
            closeLen = '</tool_call>'.length;
            closeToken = '</tool_call>';
          }
        }
        // find actual case-sensitive slice length from buffer
        if (closeIdx >= 0) {
          // re-find with original case using regex
          const cm = state.buffer.match(/<\/(?:tool_call|toolcall)>/i);
          if (cm && cm.index != null) {
            closeIdx = cm.index;
            closeLen = cm[0].length;
          }
        }
        if (closeIdx < 0) {
          // still open — wait for more, avoid unbounded buffer
          if (state.buffer.length > 200000) {
            emitText += state.buffer;
            state.buffer = '';
            state.inToolCall = false;
          }
          break;
        }
        const full = state.buffer.slice(0, closeIdx + closeLen);
        const openMatch = full.match(/<(?:tool_call|toolcall)(?:\s[^>]*)?>/i);
        const inner = openMatch
          ? full.slice(openMatch[0].length, full.length - closeLen)
          : full;
        state.buffer = state.buffer.slice(closeIdx + closeLen);
        state.inToolCall = false;
        const tc = tryParseInner(inner);
        if (tc) finished.push(tc);
      } else {
        // look for start tag
        const m = state.buffer.match(/<(?:tool_call|toolcall)(?:\s[^>]*)?>/i);
        if (m && m.index != null) {
          emitText += state.buffer.slice(0, m.index);
          state.buffer = state.buffer.slice(m.index);
          state.inToolCall = true;
          continue;
        }
        // partial tag at end?
        const lt = state.buffer.lastIndexOf('<');
        if (lt >= 0) {
          const tail = state.buffer.slice(lt).toLowerCase();
          const maybe = '<toolcall>'.startsWith(tail) || '<tool_call>'.startsWith(tail)
            || '<toolcall '.startsWith(tail) || '<tool_call '.startsWith(tail)
            || tail.startsWith('<toolcall') || tail.startsWith('<tool_call');
          if (maybe) {
            emitText += state.buffer.slice(0, lt);
            state.buffer = state.buffer.slice(lt);
            break;
          }
        }
        emitText += state.buffer;
        state.buffer = '';
        break;
      }
    }
    return { emitText, finishedToolCalls: finished };
  }

  function flush() {
    // If stream ends mid-toolcall, try hard to salvage complete JSON inside buffer
    if (state.inToolCall && state.buffer) {
      const openMatch = state.buffer.match(/<(?:tool_call|toolcall)(?:\s[^>]*)?>/i);
      const inner = openMatch ? state.buffer.slice(openMatch[0].length) : state.buffer;
      // try parse if looks like complete/near-complete JSON
      const jsonMatch = inner.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const tc = tryParseInner(jsonMatch[0]);
        state.buffer = '';
        state.inToolCall = false;
        return { emitText: '', finishedToolCalls: tc ? [tc] : [] };
      }
      // No parseable JSON found — the <toolcall> was likely a literal string
      // in the model's text (e.g. describing code), not a real tool call.
      // Emit the original buffer as plain text so content is not lost.
      console.warn('[openai-format] no JSON in toolcall buffer at stream end, emitting as text');
      const leftover = state.buffer;
      state.buffer = '';
      state.inToolCall = false;
      return { emitText: leftover, finishedToolCalls: [] };
    }
    const leftover = state.buffer;
    state.buffer = '';
    state.inToolCall = false;
    return { emitText: leftover, finishedToolCalls: [] };
  }

  return { feed, flush, state };
}

/**
 * Build OpenAI-compatible streaming deltas for a completed tool call.
 * Phase 1: id + type + name (arguments empty)
 * Phase 2: full arguments
 * Stricter clients (some agent SDKs) require the two-phase shape.
 */
function buildOpenAIToolCallStreamDeltas(tc) {
  const index = tc.index != null ? tc.index : 0;
  const id = tc.id || `call_${uuidv4().replace(/-/g, '').slice(0, 24)}`;
  const name = tc.function?.name || '';
  const args = tc.function?.arguments != null
    ? (typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments))
    : '{}';
  return [
    {
      tool_calls: [{
        index,
        id,
        type: 'function',
        function: { name, arguments: '' }
      }]
    },
    {
      tool_calls: [{
        index,
        function: { arguments: args }
      }]
    }
  ];
}

function parseTraeStreamChunk(rawLine) {
  if (!rawLine || rawLine.trim() === '') return null;
  if (rawLine.startsWith('data: ')) {
    const data = rawLine.substring(6).trim();
    if (data === '[DONE]') return { done: true };
    try {
      return JSON.parse(data);
    } catch (e) {
      return { raw: data };
    }
  }
  if (rawLine.startsWith('event:')) return null;
  if (rawLine.startsWith('id:')) return null;
  if (rawLine.startsWith('retry:')) return null;
  try {
    return JSON.parse(rawLine);
  } catch (e) {
    return null;
  }
}

function traeChunkToOpenAI(chunk, id, model) {
  if (!chunk) return null;

  if (chunk.done) {
    return createOpenAIStreamChunk(id, model, {}, 'stop');
  }

  if (chunk.type === 'message' || chunk.type === 'text') {
    const content = chunk.data?.text || chunk.data?.content || chunk.data || '';
    if (content) {
      return createOpenAIStreamChunk(id, model, { content: String(content) }, null);
    }
    return null;
  }

  if (chunk.type === 'message_start' || chunk.type === 'start') {
    return createOpenAIStreamChunk(id, model, { role: 'assistant', content: '' }, null);
  }

  if (chunk.type === 'message_end' || chunk.type === 'end' || chunk.type === 'finish') {
    return createOpenAIStreamChunk(id, model, {}, 'stop');
  }

  if (chunk.type === 'error') {
    return createOpenAIStreamChunk(id, model, {
      content: `\n[Error: ${chunk.data?.message || chunk.message || 'unknown error'}]`
    }, null);
  }

  if (chunk.choices && chunk.choices.length > 0) {
    const choice = chunk.choices[0];
    const delta = {};
    if (choice.delta) {
      if (choice.delta.content) delta.content = choice.delta.content;
      if (choice.delta.role) delta.role = choice.delta.role;
    } else if (choice.message) {
      delta.content = choice.message.content || '';
      delta.role = choice.message.role || 'assistant';
    }
    return createOpenAIStreamChunk(id, model, delta, choice.finish_reason || null);
  }

  if (chunk.content !== undefined) {
    return createOpenAIStreamChunk(id, model, { content: chunk.content }, null);
  }

  if (chunk.message !== undefined) {
    return createOpenAIStreamChunk(id, model, { content: chunk.message || '' }, null);
  }

  if (chunk.text !== undefined) {
    return createOpenAIStreamChunk(id, model, { content: chunk.text || '' }, null);
  }

  if (chunk.delta !== undefined) {
    return createOpenAIStreamChunk(id, model, { content: chunk.delta }, null);
  }

  if (chunk.finish_reason) {
    return createOpenAIStreamChunk(id, model, {}, 'stop');
  }

  return null;
}

function parseAgentTaskStream(rawLine) {
  if (!rawLine || rawLine.trim() === '') return null;
  if (rawLine.startsWith('data: ')) {
    const data = rawLine.substring(6).trim();
    if (data === '[DONE]') return { done: true };
    try {
      const parsed = JSON.parse(data);
      return normalizeAgentTaskChunk(parsed);
    } catch (e) {
      return { raw: data };
    }
  }
  if (rawLine.startsWith('event:')) return null;
  if (rawLine.startsWith('id:')) return null;
  try {
    const parsed = JSON.parse(rawLine);
    return normalizeAgentTaskChunk(parsed);
  } catch (e) {
    return null;
  }
}

function normalizeAgentTaskChunk(chunk) {
  if (!chunk || typeof chunk !== 'object') return chunk;

  if (chunk.event_type) {
    switch (chunk.event_type) {
      case 'message_start':
      case 'session_start':
      case 'task_start':
        return { type: 'message_start', data: chunk };
      case 'text_delta':
      case 'content_delta':
      case 'message_delta':
        return {
          type: 'text',
          data: chunk.data?.text || chunk.data?.content || chunk.text || chunk.content || ''
        };
      case 'tool_call':
      case 'function_call':
        return { type: 'tool_call', data: chunk.data || chunk };
      case 'tool_result':
      case 'function_result':
        return { type: 'tool_result', data: chunk.data || chunk };
      case 'message_end':
      case 'session_end':
      case 'task_end':
      case 'finish':
        return { type: 'message_end', data: chunk };
      case 'error':
        return { type: 'error', data: chunk.data || chunk };
      default:
        return chunk;
    }
  }

  if (chunk.type) return chunk;

  if (chunk.text || chunk.content || chunk.delta) {
    return {
      type: 'text',
      data: chunk.text || chunk.content || chunk.delta || ''
    };
  }

  return chunk;
}

module.exports = {
  createOpenAIChatCompletion,
  createOpenAIStreamChunk,
  createOpenAIModels,
  parseLlmUtilsChatSSE,
  parseLlmUtilsChatStream,
  normalizeLlmUtilsChunk,
  llmUtilsChunkToOpenAI,
  parseTraeStreamChunk,
  parseAgentTaskStream,
  normalizeAgentTaskChunk,
  traeChunkToOpenAI,
  extractToolcallsFromText,
  createOpenAIToolcallStreamFilter,
  buildOpenAIToolCallStreamDeltas
};
