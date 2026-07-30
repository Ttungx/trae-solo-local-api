const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const PACKAGE_VERSION = require('../package.json').version;

const { getAuthInfo, getDeviceIds, isTokenExpired, getApiHost, refreshTokenIfNeeded, detectEdition } = require('./auth');
const { llmUtilsChat, chatCompletion, createAgentTask, getModelDetailParam, getChatModes, resolveModelId, MODEL_MAP, REVERSE_MODEL_MAP, FUNCTION_MAP, getFallbackConfig, saveFallbackConfig, getFallbackChain, getRaceModels, isRaceFallbackEnabled, getTiers, getModelsInTier, getTierOfModel, isTieredFallbackEnabled, isRaceWithinTierEnabled, getFallbackModel, getSameTierModels, getNextTierModels, findMultimodalModel, getModelConfig, saveModelConfig, rebuildDerivedMaps } = require('./trae-client');
const { createOpenAIChatCompletion, createOpenAIStreamChunk, createOpenAIModels, parseLlmUtilsChatStream, llmUtilsChunkToOpenAI, parseAgentTaskStream, parseTraeStreamChunk, traeChunkToOpenAI, extractToolcallsFromText, createOpenAIToolcallStreamFilter, buildOpenAIToolCallStreamDeltas } = require('./openai-format');
const {
  createAnthropicMessage,
  createAnthropicMessageStart,
  createAnthropicContentBlockStart,
  createAnthropicContentBlockDelta,
  createAnthropicContentBlockStop,
  createAnthropicMessageDelta,
  createAnthropicMessageStop,
  createAnthropicError,
  anthropicToOpenAIMessages,
  llmUtilsChunkToAnthropic,
  parseToolcallContent
} = require('./anthropic-format');
const { encrypt, decrypt, hashContent } = require('./crypto');
const { v4: uuidv4 } = require('./uuid');
const trafficLogger = require('./traffic-logger');
const sessionsRepo = require('./sessions');
const configSchema = require('./config-schema');
const {
  applyThinkEffort,
  extractThinkEffortFromBody,
  getThinkEffortSupport,
} = require('./think-effort');
const {
  getContinueLimits,
  shouldAutoContinue,
  appendContinueTurn,
} = require('./auto-continue');
const { getCatalog, getOpenApiDocument } = require('./api-catalog');
const { sendOpenAIError } = require('./errors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const API_KEY = process.env.API_KEY || 'trae-solo-local-api-key';
const PORT = process.env.PORT || 19900;
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || '';
const OUTPUT_SYNC_DIR = process.env.OUTPUT_SYNC_DIR || '';
// Defaults live in auto-continue.js (MAX_CONTINUES default 10). Env still wins.
const _continueLimitsBoot = getContinueLimits();
const AUTO_CONTINUE = _continueLimitsBoot.enabled;
const MAX_CONTINUES = _continueLimitsBoot.maxContinues;

const pendingSyncFiles = [];

// Global defaults for new sessions (overridable via PUT /v1/config/defaults)
let globalDefaults = configSchema.getDefaults();
sessionsRepo.setGlobalDefaults(globalDefaults);

// 服务启动时间 (moved here to be available for /health and /v1/dashboard/status routes)
const serverStartTime = Date.now();

function syncFileToOutput(srcPath) {
  if (!OUTPUT_SYNC_DIR) return;
  try {
    const relPath = path.relative(WORKSPACE_DIR, srcPath);
    if (relPath.startsWith('..')) return;
    const destPath = path.join(OUTPUT_SYNC_DIR, relPath);
    const destDir = path.dirname(destPath);
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(srcPath, destPath);
    console.log(`[sync] ${srcPath} -> ${destPath}`);
  } catch (e) {
    console.log(`[sync] Queued for external sync: ${srcPath}`);
    pendingSyncFiles.push(srcPath);
  }
}

function authenticate(req, res, next) {
  let token = null;

  if (req.headers['authorization']) {
    token = req.headers['authorization'].replace('Bearer ', '');
  } else if (req.headers['x-api-key']) {
    token = req.headers['x-api-key'];
  } else if (req.query?.key) {
    token = req.query.key;
  }

  if (!token) {
    return sendOpenAIError(
      res,
      401,
      'Missing API key (Authorization header, x-api-key, or ?key= query param)',
      'auth_error'
    );
  }

  if (token !== API_KEY) {
    return sendOpenAIError(res, 401, 'Invalid API key', 'auth_error');
  }
  next();
}

// API catalog / OpenAPI (no auth — discovery for MCP & clients)
app.get('/v1', (req, res) => {
  const catalog = getCatalog();
  const host = req.get('host');
  const proto = req.protocol || 'http';
  catalog.base_url = host ? `${proto}://${host}` : `http://localhost:${PORT}`;
  catalog.features.auto_continue = AUTO_CONTINUE;
  catalog.features.max_continues = MAX_CONTINUES;
  res.json(catalog);
});

app.get('/v1/openapi.json', (req, res) => {
  const host = req.get('host');
  const proto = req.protocol || 'http';
  const base = host ? `${proto}://${host}` : `http://localhost:${PORT}`;
  res.json(getOpenApiDocument(base));
});

app.get('/v1/models', authenticate, (req, res) => {
  const models = Object.keys(MODEL_MAP);
  const functions = Object.keys(FUNCTION_MAP);
  res.json(createOpenAIModels([...models, ...functions]));
});

function handleLlmUtilsStream(responseBody, res, completionId, modelName, saveToPath, logId, onComplete, streamControl) {
  let buffer = '';
  let currentEventName = '';
  let fullContent = '';
  let fullReasoning = '';
  let tokenUsage = null;
  let llmFinalized = false;
  let persisted = false;
  let abortedForFallback = false;
  let lastQueuePosition = 0;
  let streamEnded = false;
  const collectedToolCalls = [];
  const toolFilter = createOpenAIToolcallStreamFilter(parseToolcallContent);
  const control = streamControl || null;

  const finalizeLlmLog = () => {
    if (llmFinalized) return;
    llmFinalized = true;
    if (logId) trafficLogger.finalizeLog(logId, { fullContent, fullReasoning, tokenUsage, toolCalls: collectedToolCalls });
  };

  const persistOnce = () => {
    if (persisted || !onComplete) return;
    persisted = true;
    try { onComplete(fullContent, fullReasoning, tokenUsage, collectedToolCalls); }
    catch (e) { console.error('[persist] onComplete error:', e); }
  };

  const destroyBody = () => {
    try { if (responseBody && responseBody.destroy) responseBody.destroy(); } catch (e) {}
  };

  const writeToolCallChunks = (toolCalls) => {
    if (!toolCalls || !toolCalls.length || res.writableEnded) return;
    const mapped = applyToolMapToToolCalls(toolCalls, control?.toolMap);
    for (const tc of mapped) {
      if (tc.index == null) tc.index = collectedToolCalls.length;
      // Two-phase OpenAI tool_call deltas for stricter clients (OpenCode etc.)
      const phases = buildOpenAIToolCallStreamDeltas(tc);
      for (const delta of phases) {
        const chunk = createOpenAIStreamChunk(completionId, modelName, delta, null);
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      collectedToolCalls.push(tc);
    }
    // Flush SSE promptly so clients don't stall waiting for end-of-buffer
    if (typeof res.flush === 'function') {
      try { res.flush(); } catch (e) {}
    }
  };

  const writeTextDelta = (text) => {
    if (!text || res.writableEnded) return;
    const tChunk = createOpenAIStreamChunk(completionId, modelName, { content: text }, null);
    res.write(`data: ${JSON.stringify(tChunk)}\n\n`);
    if (typeof res.flush === 'function') {
      try { res.flush(); } catch (e) {}
    }
  };

  const writeReasoningDelta = (text) => {
    if (!text || res.writableEnded) return;
    const rChunk = createOpenAIStreamChunk(completionId, modelName, { reasoning_content: text }, null);
    res.write(`data: ${JSON.stringify(rChunk)}\n\n`);
    if (typeof res.flush === 'function') {
      try { res.flush(); } catch (e) {}
    }
  };

  const holdFinish = !!(control && control.holdFinish);

  const flushToolFilter = () => {
    try {
      const flushed = toolFilter.flush();
      if (flushed.emitText) {
        fullContent += flushed.emitText;
        writeTextDelta(flushed.emitText);
      }
      if (flushed.finishedToolCalls && flushed.finishedToolCalls.length) {
        writeToolCallChunks(flushed.finishedToolCalls);
      }
    } catch (e) {}
  };

  const buildTurnResult = (finishReason) => {
    let reason = finishReason || 'stop';
    if (collectedToolCalls.length > 0) reason = 'tool_calls';
    return {
      fullContent,
      fullReasoning,
      tokenUsage,
      finishReason: reason,
      toolCalls: collectedToolCalls.slice(),
      messageStarted: !!(fullContent || fullReasoning || collectedToolCalls.length),
      hasToolUse: collectedToolCalls.length > 0,
      textContent: fullContent,
      reasoningContent: fullReasoning,
      stopReason: reason === 'tool_calls' ? 'tool_use' : (reason === 'length' ? 'max_tokens' : reason),
    };
  };

  const finishStream = (finishReason) => {
    if (streamEnded || res.writableEnded) return;
    streamEnded = true;
    flushToolFilter();

    // holdFinish: outer auto-continue loop owns DONE / res.end
    if (holdFinish) {
      finalizeLlmLog();
      if (control && typeof control.onTurnEnd === 'function') {
        try { control.onTurnEnd(buildTurnResult(finishReason)); } catch (e) {
          console.error('[stream] onTurnEnd error:', e);
        }
      }
      return;
    }

    if (saveToPath && fullContent) {
      try {
        const dir = path.dirname(saveToPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(saveToPath, fullContent, 'utf-8');
        console.log(`[file] Saved to: ${saveToPath}`);
        syncFileToOutput(saveToPath);
        const savedChunk = createOpenAIStreamChunk(completionId, modelName, {
          content: `\n\n[File saved: ${saveToPath}]`
        }, null);
        res.write(`data: ${JSON.stringify(savedChunk)}\n\n`);
      } catch (fileErr) {
        console.error(`[file] Save failed: ${fileErr.message}`);
      }
    }

    persistOnce();

    let reason = finishReason || 'stop';
    // First-principles: if tools were emitted, clients must see tool_calls stop reason
    if (collectedToolCalls.length > 0) {
      reason = 'tool_calls';
    }
    const usage = tokenUsage ? {
      prompt_tokens: tokenUsage.prompt_tokens || 0,
      completion_tokens: tokenUsage.completion_tokens || 0,
      total_tokens: tokenUsage.total_tokens || (tokenUsage.prompt_tokens || 0) + (tokenUsage.completion_tokens || 0),
    } : undefined;
    const doneChunk = createOpenAIStreamChunk(completionId, modelName, {}, reason, usage);
    res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
    finalizeLlmLog();
    if (control && typeof control.onComplete === 'function') control.onComplete({ toolCalls: collectedToolCalls });
  };

  const canFallback = () => {
    if (!control || control.fallbackResolved) return false;
    // Don't fallback mid-content if we already emitted tool calls / text
    if (fullContent || fullReasoning || collectedToolCalls.length) return false;
    const fbConfig = getFallbackConfig() || {};
    return fbConfig.autoFallback !== false;
  };

  const pickNextFallback = (reason) => {
    if (!canFallback()) return null;
    const attempted = control.fallbackAttempted || {};
    let currentConfig = control.currentConfig;
    if (!currentConfig || currentConfig === 'auto') {
      currentConfig = resolveModelId(control.originalModel || modelName);
    }
    // Mark the failing model so we never re-pick it in this request.
    if (currentConfig && currentConfig !== 'auto') attempted[currentConfig] = true;

    if (isTieredFallbackEnabled()) {
      if (isRaceWithinTierEnabled()) {
        const sameTier = getSameTierModels(currentConfig).filter(m => !attempted[m]);
        if (sameTier.length > 0) {
          for (const m of sameTier) attempted[m] = true;
          console.log(`[openai-fallback] ${reason}, RACE within tier: ${sameTier.join(', ')}`);
          return { raceModels: sameTier };
        }
      }
      const nextModels = getNextTierModels(currentConfig, Object.keys(attempted));
      if (nextModels.length > 0) {
        const nextModel = nextModels[0];
        attempted[nextModel] = true;
        console.log(`[openai-fallback] ${reason}, next tier: ${nextModel}`);
        return { nextModel };
      }
      const fbModel = getFallbackModel();
      if (fbModel && !attempted[fbModel]) {
        attempted[fbModel] = true;
        console.log(`[openai-fallback] ${reason}, fallback model: ${fbModel}`);
        return { nextModel: fbModel };
      }
    } else {
      const fallbackChain = getFallbackChain(control.originalModel || modelName);
      const nextModel = fallbackChain.find(m => !attempted[m]);
      if (nextModel) {
        attempted[nextModel] = true;
        console.log(`[openai-fallback] ${reason}, chain: ${nextModel}`);
        return { nextModel };
      }
      const fbModel = getFallbackModel();
      if (fbModel && !attempted[fbModel]) {
        attempted[fbModel] = true;
        console.log(`[openai-fallback] ${reason}, fallback model: ${fbModel}`);
        return { nextModel: fbModel };
      }
    }
    return null;
  };

  const decideFallback = (position) => {
    const fbConfig = getFallbackConfig() || {};
    if (!(position > (fbConfig.queueThreshold || 300))) return null;
    return pickNextFallback(`Queue #${position} > threshold`);
  };

  const isHardModelError = (parsed) => {
    if (!parsed || parsed.type !== 'error') return false;
    const code = Number(parsed.code);
    if (code === 4001 || code === 4023) return true;
    const msg = String(parsed.message || '');
    return /param is invalid|model is unknown|invalid model/i.test(msg);
  };

  const triggerFallback = (decision) => {
    if (!control || control.fallbackResolved || !decision) return;
    control.fallbackResolved = true;
    abortedForFallback = true;
    destroyBody();
    finalizeLlmLog();
    if (typeof control.onFallback === 'function') {
      control.onFallback(decision);
    }
  };

  responseBody.on('data', (chunk) => {
    if (abortedForFallback || (control && control.fallbackResolved) || streamEnded) return;
    try {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (abortedForFallback || streamEnded) return;
        const trimmed = line.trim();
        if (!trimmed) continue;

        const parsed = parseLlmUtilsChatStream(trimmed, currentEventName);
        if (!parsed) continue;

        if (parsed._type === 'event_name') {
          currentEventName = parsed.value;
          if (logId) trafficLogger.logResponseChunk(logId, currentEventName, null);
          continue;
        }

        if (logId) trafficLogger.logResponseChunk(logId, currentEventName, parsed);

        if (parsed.type === 'queue_wait' && parsed.position > 0) {
          if (parsed.position !== lastQueuePosition) {
            lastQueuePosition = parsed.position;
            const decision = decideFallback(parsed.position);
            if (decision) {
              triggerFallback(decision);
              return;
            }
          }
          continue;
        }

        if (parsed.type === 'queue_begin' || parsed.type === 'queue_end') {
          continue;
        }

        if (parsed.type === 'token_usage') {
          tokenUsage = parsed.data;
          if (logId) trafficLogger.logTokenUsage(logId, tokenUsage);
          continue;
        }

        if (parsed.type === 'done') {
          finishStream(parsed.finish_reason || 'stop');
          return;
        }

        // Native tool_calls from Trae output event
        if (parsed.type === 'text' && parsed.tool_calls && Array.isArray(parsed.tool_calls)) {
          const mapped = parsed.tool_calls.map((tc, i) => {
            const name = tc.name || tc.function?.name || tc.tool_name || '';
            const args = tc.params != null ? tc.params
              : (tc.arguments != null ? tc.arguments
                : (tc.input != null ? tc.input
                  : (tc.function?.arguments != null ? tc.function.arguments : {})));
            return {
              index: collectedToolCalls.length + i,
              id: tc.id || `call_${uuidv4().replace(/-/g, '').slice(0, 24)}`,
              type: 'function',
              function: {
                name: String(name),
                arguments: typeof args === 'string' ? args : JSON.stringify(args || {})
              }
            };
          }).filter(tc => tc.function.name);
          writeToolCallChunks(mapped);
        }

        // Stream text through toolcall filter so <toolcall> becomes tool_calls
        if (parsed.type === 'text' && (parsed.content || parsed.reasoning)) {
          if (parsed.reasoning) {
            fullReasoning += parsed.reasoning;
            if (logId) trafficLogger.logResponseContent(logId, null, parsed.reasoning);
            writeReasoningDelta(parsed.reasoning);
          }
          if (parsed.content) {
            if (logId) trafficLogger.logResponseContent(logId, parsed.content, null);
            const { emitText, finishedToolCalls } = toolFilter.feed(parsed.content);
            if (emitText) {
              fullContent += emitText;
              writeTextDelta(emitText);
            }
            if (finishedToolCalls.length) {
              console.log(`[openai ${control?.reqId || ''}] extracted ${finishedToolCalls.length} toolcall(s) from stream: ${finishedToolCalls.map(t => t.function.name).join(', ')}`);
              writeToolCallChunks(finishedToolCalls);
            }
          }
          continue;
        }

        // Hard model/param errors (e.g. 4001 invalid config_name) → switch model, don't surface yet
        if (parsed.type === 'error') {
          if (isHardModelError(parsed)) {
            const decision = pickNextFallback(`error ${parsed.code || ''} ${parsed.message || ''}`.trim());
            if (decision) {
              triggerFallback(decision);
              return;
            }
          }
          const openaiChunk = llmUtilsChunkToOpenAI(parsed, completionId, modelName, true);
          if (openaiChunk && !res.writableEnded) res.write(`data: ${JSON.stringify(openaiChunk)}\n\n`);
        }
      }
    } catch (err) {
      if (abortedForFallback || streamEnded) return;
      console.error('[stream] Error in data callback:', err);
      if (logId) trafficLogger.logError(logId, err);
      try { responseBody.destroy(); } catch (e) {}
      // holdFinish: never DONE here — outer auto-continue owns the SSE end
      if (holdFinish) {
        finishStream('stop');
        return;
      }
      if (!res.writableEnded) {
        try {
          const errChunk = createOpenAIStreamChunk(completionId, modelName, { content: `\n\n[Stream error: ${err.message}]` }, 'stop');
          res.write(`data: ${JSON.stringify(errChunk)}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        } catch (e) {}
      }
    }
  });

  responseBody.on('end', () => {
    if (abortedForFallback) return;
    finishStream('stop');
  });

  responseBody.on('close', () => {
    if (abortedForFallback) return;
    finalizeLlmLog();
  });

  responseBody.on('error', (err) => {
    if (abortedForFallback || streamEnded) return;
    console.error('[stream] error:', err);
    if (logId) trafficLogger.logError(logId, err);
    // holdFinish: hand partial turn to outer loop (must call onTurnEnd or request hangs)
    if (holdFinish) {
      finishStream('stop');
      return;
    }
    finalizeLlmLog();
    if (!res.writableEnded) {
      const errChunk = createOpenAIStreamChunk(completionId, modelName, { content: `\n\n[Error: ${err.message}]` }, 'stop');
      res.write(`data: ${JSON.stringify(errChunk)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  });
}

// OpenAI path queue-aware runner (mirrors Anthropic fallback behavior).
async function runOpenAIChatWithFallback({
  messages, modelName, options, res, completionId, saveToPath, persistAssistant, reqId, isStream, toolMap, thinkEffort
}) {
  const fallbackAttempted = {};
  let activeModel = modelName;
  let activeConfig = (modelName && modelName !== 'auto') ? resolveModelId(modelName) : 'auto';
  const effortRaw = thinkEffort != null ? thinkEffort : options?.think_effort;

  /** Re-bind system prefix for current SOLO config (strip old marker first). */
  const bindThinkEffort = (configForEffort, label) => {
    const cfg = configForEffort && configForEffort !== 'auto' ? configForEffort : modelName;
    const { meta } = applyThinkEffort(messages, cfg, effortRaw);
    if (reqId && meta) {
      console.log(
        `[think_effort ${reqId}] ${label || 'bind'} model=${cfg} family=${meta.family || '-'} ` +
        `effort=${meta.effort} injected=${meta.injected ? 'yes' : 'no'} reason=${meta.reason}`
      );
    }
    return meta;
  };

  const collectNonStream = async (targetModel, configNameOverride) => {
    const callOpts = { ...options };
    if (configNameOverride) callOpts.config_name = configNameOverride;
    bindThinkEffort(configNameOverride || resolveModelId(targetModel) || targetModel, 'nonstream');
    const result = await llmUtilsChat(messages, targetModel, true, callOpts);
    let fullContent = '';
    let fullReasoning = '';
    let tokenUsage = null;
    let finishReason = 'stop';
    let lastQueuePosition = 0;
    let fallbackDecision = null;
    const nativeToolCalls = [];
    const upstreamLogId = result.logId;

    if (!result.body) {
      return { fullContent, fullReasoning, tokenUsage, finishReason, toolCalls: [], fallbackDecision: null };
    }

    await new Promise((resolve, reject) => {
      let buffer = '';
      let currentEventName = '';
      let settled = false;

      const settle = (fn) => {
        if (settled) return;
        settled = true;
        fn();
      };

      const pickNext = (reason) => {
        // Don't switch model after content started
        if (fullContent || fullReasoning || nativeToolCalls.length) return null;
        const fbConfig = getFallbackConfig() || {};
        if (fbConfig.autoFallback === false) return null;
        if (activeConfig && activeConfig !== 'auto') fallbackAttempted[activeConfig] = true;
        if (isTieredFallbackEnabled()) {
          if (isRaceWithinTierEnabled()) {
            const sameTier = getSameTierModels(activeConfig).filter(m => !fallbackAttempted[m]);
            if (sameTier.length > 0) {
              for (const m of sameTier) fallbackAttempted[m] = true;
              console.log(`[openai-fallback] ${reason}, RACE within tier: ${sameTier.join(', ')}`);
              return { raceModels: sameTier };
            }
          }
          const nextModels = getNextTierModels(activeConfig, Object.keys(fallbackAttempted));
          if (nextModels.length > 0) {
            const nextModel = nextModels[0];
            fallbackAttempted[nextModel] = true;
            console.log(`[openai-fallback] ${reason}, next tier: ${nextModel}`);
            return { nextModel };
          }
          const fbModel = getFallbackModel();
          if (fbModel && !fallbackAttempted[fbModel]) {
            fallbackAttempted[fbModel] = true;
            console.log(`[openai-fallback] ${reason}, fallback model: ${fbModel}`);
            return { nextModel: fbModel };
          }
        } else {
          const chain = getFallbackChain(modelName);
          const nextModel = chain.find(m => !fallbackAttempted[m]);
          if (nextModel) {
            fallbackAttempted[nextModel] = true;
            console.log(`[openai-fallback] ${reason}, chain: ${nextModel}`);
            return { nextModel };
          }
          const fbModel = getFallbackModel();
          if (fbModel && !fallbackAttempted[fbModel]) {
            fallbackAttempted[fbModel] = true;
            console.log(`[openai-fallback] ${reason}, fallback model: ${fbModel}`);
            return { nextModel: fbModel };
          }
        }
        return null;
      };

      const maybeFallback = (position) => {
        const fbConfig = getFallbackConfig() || {};
        if (!(position > (fbConfig.queueThreshold || 300))) return null;
        return pickNext(`Queue #${position} > threshold`);
      };

      const isHardModelError = (parsed) => {
        if (!parsed || parsed.type !== 'error') return false;
        const code = Number(parsed.code);
        if (code === 4001 || code === 4023) return true;
        const msg = String(parsed.message || '');
        return /param is invalid|model is unknown|invalid model/i.test(msg);
      };

      result.body.on('data', (chunk) => {
        if (settled) return;
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const parsed = parseLlmUtilsChatStream(trimmed, currentEventName);
          if (!parsed) continue;
          if (parsed._type === 'event_name') {
            currentEventName = parsed.value;
            if (upstreamLogId) trafficLogger.logResponseChunk(upstreamLogId, currentEventName, null);
            continue;
          }
          if (upstreamLogId) trafficLogger.logResponseChunk(upstreamLogId, currentEventName, parsed);

          if (parsed.type === 'queue_wait' && parsed.position > 0) {
            if (parsed.position !== lastQueuePosition) {
              lastQueuePosition = parsed.position;
              const decision = maybeFallback(parsed.position);
              if (decision) {
                fallbackDecision = decision;
                try { result.body.destroy(); } catch (e) {}
                settle(resolve);
                return;
              }
            }
            continue;
          }
          if (parsed.type === 'error' && isHardModelError(parsed) && !fullContent && !fullReasoning) {
            const decision = pickNext(`error ${parsed.code || ''} ${parsed.message || ''}`.trim());
            if (decision) {
              fallbackDecision = decision;
              try { result.body.destroy(); } catch (e) {}
              settle(resolve);
              return;
            }
            fullContent += `\n[Error ${parsed.code || ''}: ${parsed.message || 'unknown'}]`;
            continue;
          }
          if (parsed.type === 'token_usage') {
            tokenUsage = parsed.data;
            if (upstreamLogId) trafficLogger.logTokenUsage(upstreamLogId, tokenUsage);
            continue;
          }
          if (parsed.type === 'done') {
            finishReason = parsed.finish_reason || 'stop';
            continue;
          }
          if (parsed.type === 'text' && parsed.content) {
            fullContent += parsed.content;
            if (upstreamLogId) trafficLogger.logResponseContent(upstreamLogId, parsed.content, null);
          }
          if (parsed.type === 'text' && parsed.reasoning) {
            fullReasoning += parsed.reasoning;
            if (upstreamLogId) trafficLogger.logResponseContent(upstreamLogId, null, parsed.reasoning);
          }
          if (parsed.type === 'text' && parsed.tool_calls && Array.isArray(parsed.tool_calls)) {
            for (const tc of parsed.tool_calls) {
              const name = tc.name || tc.function?.name || tc.tool_name || '';
              const args = tc.params != null ? tc.params
                : (tc.arguments != null ? tc.arguments
                  : (tc.input != null ? tc.input
                    : (tc.function?.arguments != null ? tc.function.arguments : {})));
              if (!name) continue;
              nativeToolCalls.push({
                id: tc.id || `call_${uuidv4().replace(/-/g, '').slice(0, 24)}`,
                type: 'function',
                function: {
                  name: String(name),
                  arguments: typeof args === 'string' ? args : JSON.stringify(args || {})
                }
              });
            }
          }
        }
      });
      result.body.on('end', () => settle(resolve));
      result.body.on('error', (err) => {
        if (fallbackDecision) settle(resolve);
        else settle(() => reject(err));
      });
    });

    // Extract <toolcall> tags from text content
    const extracted = extractToolcallsFromText(fullContent, parseToolcallContent);
    fullContent = extracted.text;
    const toolCalls = [...nativeToolCalls, ...extracted.toolCalls];
    if (toolCalls.length > 0 && (!finishReason || finishReason === 'stop')) {
      finishReason = 'tool_calls';
    }

    if (upstreamLogId) trafficLogger.finalizeLog(upstreamLogId, { fullContent, fullReasoning, tokenUsage, toolCalls });
    return { fullContent, fullReasoning, tokenUsage, finishReason, toolCalls, fallbackDecision };
  };

  const continueSettings = (() => {
    try {
      return (getModelConfig() && getModelConfig().settings) || {};
    } catch (e) {
      return {};
    }
  })();
  const continueOptsBase = {
    enabled: AUTO_CONTINUE,
    maxContinues: MAX_CONTINUES,
    settings: continueSettings,
  };

  // Non-stream: fallback loop, then auto-continue until real answer or cap.
  if (!isStream) {
    const runOneNonStream = async () => {
      for (let attempt = 0; attempt < 8; attempt++) {
        const collected = await collectNonStream(activeModel, activeConfig === 'auto' ? null : activeConfig);
        if (collected.fallbackDecision) {
          if (collected.fallbackDecision.raceModels && collected.fallbackDecision.raceModels.length) {
            let raceHit = false;
            for (const raceModel of collected.fallbackDecision.raceModels) {
              activeModel = raceModel;
              activeConfig = raceModel;
              const raceCollected = await collectNonStream(raceModel, raceModel);
              if (!raceCollected.fallbackDecision && (raceCollected.fullContent || raceCollected.fullReasoning)) {
                return { ...raceCollected, modelUsed: raceModel };
              }
              if (!raceCollected.fallbackDecision) {
                return { ...raceCollected, modelUsed: raceModel };
              }
              raceHit = true;
            }
            if (raceHit) {
              const nextModels = getNextTierModels(resolveModelId(modelName), Object.keys(fallbackAttempted));
              if (nextModels.length) {
                activeModel = nextModels[0];
                activeConfig = nextModels[0];
                fallbackAttempted[activeModel] = true;
                continue;
              }
              const fbModel = getFallbackModel();
              if (fbModel && !fallbackAttempted[fbModel]) {
                activeModel = fbModel;
                activeConfig = fbModel;
                fallbackAttempted[fbModel] = true;
                continue;
              }
            }
            return { ...collected, modelUsed: activeModel };
          }
          if (collected.fallbackDecision.nextModel) {
            activeModel = collected.fallbackDecision.nextModel;
            activeConfig = collected.fallbackDecision.nextModel;
            console.log(`[openai ${reqId}] Retrying non-stream with fallback model: ${activeModel}`);
            continue;
          }
        }
        return { ...collected, modelUsed: activeModel };
      }
      return { fullContent: '', fullReasoning: '', tokenUsage: null, finishReason: 'stop', toolCalls: [], modelUsed: activeModel };
    };

    let aggregated = {
      fullContent: '',
      fullReasoning: '',
      tokenUsage: null,
      finishReason: 'stop',
      toolCalls: [],
      modelUsed: activeModel,
    };
    let continueCount = 0;
    let lastShortText = null;

    for (;;) {
      const turn = await runOneNonStream();
      if (turn.fullContent) aggregated.fullContent += turn.fullContent;
      if (turn.fullReasoning) {
        aggregated.fullReasoning = aggregated.fullReasoning
          ? `${aggregated.fullReasoning}\n${turn.fullReasoning}`
          : turn.fullReasoning;
      }
      if (turn.tokenUsage) aggregated.tokenUsage = turn.tokenUsage;
      if (turn.toolCalls && turn.toolCalls.length) {
        aggregated.toolCalls = [...(aggregated.toolCalls || []), ...turn.toolCalls];
      }
      aggregated.finishReason = turn.finishReason || 'stop';
      aggregated.modelUsed = turn.modelUsed || activeModel;

      const decision = shouldAutoContinue(
        {
          fullContent: turn.fullContent,
          fullReasoning: turn.fullReasoning,
          finishReason: turn.finishReason,
          toolCalls: turn.toolCalls,
          messageStarted: !!(turn.fullContent || turn.fullReasoning || (turn.toolCalls && turn.toolCalls.length)),
        },
        { ...continueOptsBase, continueCount, lastShortText }
      );

      if (!decision.shouldContinue) {
        if (decision.finishReason === 'length') aggregated.finishReason = 'length';
        if (decision.reason === 'cap_reached') {
          console.log(`[openai ${reqId}] auto_continue cap (${continueCount}/${MAX_CONTINUES}) reason=${decision.reason}`);
        }
        break;
      }

      console.log(
        `[openai ${reqId}] auto_continue nonstream reason=${decision.reason} ` +
        `(${continueCount + 1}/${MAX_CONTINUES})`
      );
      appendContinueTurn(messages, turn, decision.continueMessage);
      if (decision.isShortResponse) {
        lastShortText = (turn.fullContent || '').trim();
      }
      continueCount++;
    }

    if (aggregated.toolCalls && aggregated.toolCalls.length &&
        (!aggregated.finishReason || aggregated.finishReason === 'stop')) {
      aggregated.finishReason = 'tool_calls';
    }
    return aggregated;
  }

  // Stream path: fallback + auto-continue. holdFinish defers DONE until real answer or cap.
  return await new Promise(async (resolveOuter, rejectOuter) => {
    let settled = false;
    const settle = (v) => {
      if (settled) return;
      settled = true;
      resolveOuter(v);
    };

    let continueCount = 0;
    let lastShortText = null;
    let aggregateContent = '';
    let aggregateReasoning = '';
    let lastTokenUsage = null;
    let lastToolCalls = [];
    let activeStreamModel = activeModel;

    const endStreamFinally = (finishReason, modelUsed) => {
      if (res.writableEnded) return settle({ modelUsed });
      let reason = finishReason || 'stop';
      if (lastToolCalls.length > 0) reason = 'tool_calls';

      if (saveToPath && aggregateContent) {
        try {
          const dir = path.dirname(saveToPath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(saveToPath, aggregateContent, 'utf-8');
          console.log(`[file] Saved to: ${saveToPath}`);
          syncFileToOutput(saveToPath);
          const savedChunk = createOpenAIStreamChunk(completionId, modelUsed, {
            content: `\n\n[File saved: ${saveToPath}]`,
          }, null);
          res.write(`data: ${JSON.stringify(savedChunk)}\n\n`);
        } catch (fileErr) {
          console.error(`[file] Save failed: ${fileErr.message}`);
        }
      }

      if (typeof persistAssistant === 'function') {
        try { persistAssistant(aggregateContent, aggregateReasoning, lastTokenUsage, lastToolCalls); }
        catch (e) { console.error('[persist] stream final failed:', e); }
      }

      const usage = lastTokenUsage ? {
        prompt_tokens: lastTokenUsage.prompt_tokens || 0,
        completion_tokens: lastTokenUsage.completion_tokens || 0,
        total_tokens: lastTokenUsage.total_tokens || (lastTokenUsage.prompt_tokens || 0) + (lastTokenUsage.completion_tokens || 0),
      } : undefined;
      const doneChunk = createOpenAIStreamChunk(completionId, modelUsed, {}, reason, usage);
      res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      settle({ modelUsed, toolCalls: lastToolCalls });
    };

    const runStreamTurn = (targetModel, configNameOverride) => new Promise(async (resolveTurn, rejectTurn) => {
      if (res.writableEnded) return resolveTurn({ aborted: true, modelUsed: targetModel });
      const callOpts = { ...options };
      if (configNameOverride) callOpts.config_name = configNameOverride;
      bindThinkEffort(configNameOverride || resolveModelId(targetModel) || targetModel, 'stream');
      let result;
      try {
        result = await llmUtilsChat(messages, targetModel, true, callOpts);
      } catch (err) {
        return rejectTurn(err);
      }
      if (!result.body) {
        return resolveTurn({
          emptyBody: true,
          modelUsed: targetModel,
          fullContent: '',
          fullReasoning: '',
          finishReason: 'stop',
          toolCalls: [],
        });
      }

      let turnResolved = false;
      const resolveOnce = (payload) => {
        if (turnResolved) return;
        turnResolved = true;
        resolveTurn(payload);
      };

      const control = {
        originalModel: modelName,
        currentConfig: configNameOverride || resolveModelId(targetModel),
        fallbackAttempted,
        fallbackResolved: false,
        reqId,
        toolMap,
        holdFinish: true,
        onTurnEnd: (turn) => {
          resolveOnce({ ...turn, modelUsed: targetModel, fallback: false });
        },
        onFallback: async (decision) => {
          // Queue/model switch: do not auto-continue this body; outer handles fallback
          resolveOnce({ fallback: true, decision, modelUsed: targetModel });
        },
      };

      // When not holding (legacy), onComplete settles; with holdFinish onTurnEnd fires
      control.onComplete = () => {
        if (!control.holdFinish) resolveOnce({ modelUsed: targetModel, fullContent: '', fullReasoning: '', finishReason: 'stop', toolCalls: [] });
      };

      handleLlmUtilsStream(result.body, res, completionId, targetModel, null, result.logId, null, control);
    });

    const runStreamWithFallback = async () => {
      for (let attempt = 0; attempt < 8; attempt++) {
        const turn = await runStreamTurn(activeModel, activeConfig === 'auto' ? null : activeConfig);
        if (turn.aborted) return turn;
        if (turn.fallback && turn.decision) {
          const decision = turn.decision;
          if (decision.raceModels && decision.raceModels.length) {
            console.log(`[openai ${reqId}] Launching TIER RACE: ${decision.raceModels.join(', ')}`);
            for (const raceModel of decision.raceModels) {
              activeModel = raceModel;
              activeConfig = raceModel;
              const raceTurn = await runStreamTurn(raceModel, raceModel);
              if (raceTurn.aborted) return raceTurn;
              if (!raceTurn.fallback) return raceTurn;
            }
            const nextModels = getNextTierModels(resolveModelId(modelName), Object.keys(fallbackAttempted));
            if (nextModels.length) {
              activeModel = nextModels[0];
              activeConfig = nextModels[0];
              fallbackAttempted[activeModel] = true;
              console.log(`[openai ${reqId}] Race exhausted, next tier: ${activeModel}`);
              continue;
            }
            const fbModel = getFallbackModel();
            if (fbModel && !fallbackAttempted[fbModel]) {
              fallbackAttempted[fbModel] = true;
              activeModel = fbModel;
              activeConfig = fbModel;
              console.log(`[openai ${reqId}] Race exhausted, fallback model: ${activeModel}`);
              continue;
            }
            return turn;
          }
          if (decision.nextModel) {
            activeModel = decision.nextModel;
            activeConfig = decision.nextModel;
            console.log(`[openai ${reqId}] Retrying stream with fallback model: ${activeModel}`);
            continue;
          }
        }
        return turn;
      }
      return {
        fullContent: '',
        fullReasoning: '',
        finishReason: 'stop',
        toolCalls: [],
        modelUsed: activeModel,
      };
    };

    try {
      for (;;) {
        const turn = await runStreamWithFallback();
        if (turn.aborted) return settle({ modelUsed: activeStreamModel });

        activeStreamModel = turn.modelUsed || activeModel;
        if (turn.fullContent) aggregateContent += turn.fullContent;
        if (turn.fullReasoning) {
          aggregateReasoning = aggregateReasoning
            ? `${aggregateReasoning}\n${turn.fullReasoning}`
            : turn.fullReasoning;
        }
        if (turn.tokenUsage) lastTokenUsage = turn.tokenUsage;
        if (turn.toolCalls && turn.toolCalls.length) {
          lastToolCalls = [...lastToolCalls, ...turn.toolCalls];
        }

        const decision = shouldAutoContinue(turn, {
          ...continueOptsBase,
          continueCount,
          lastShortText,
        });

        if (!decision.shouldContinue) {
          let finalReason = turn.finishReason || 'stop';
          if (decision.finishReason === 'length') finalReason = 'length';
          if (decision.reason === 'cap_reached') {
            console.log(`[openai ${reqId}] auto_continue cap (${continueCount}/${MAX_CONTINUES})`);
            finalReason = 'length';
          }
          endStreamFinally(finalReason, activeStreamModel);
          return;
        }

        console.log(
          `[openai ${reqId}] auto_continue stream reason=${decision.reason} ` +
          `(${continueCount + 1}/${MAX_CONTINUES})`
        );
        appendContinueTurn(messages, turn, decision.continueMessage);
        if (decision.isShortResponse) {
          lastShortText = (turn.fullContent || turn.textContent || '').trim();
        }
        continueCount++;
      }
    } catch (e) {
      rejectOuter(e);
    }
  });
}

/**
 * Normalize OpenAI chat messages for Trae:
 * - convert tool role messages to <tool_result> text
 * - convert assistant.tool_calls to <toolcall> text
 * - inject tools schema into system prompt when present
 * - preserve multimodal image parts
 */
function prepareOpenAIMessagesForTrae(messages, tools, reqId) {
  const prepared = [];
  let hasToolResult = false;
  let hasToolUse = false;

  for (const msg of messages || []) {
    if (!msg || !msg.role) continue;

    if (msg.role === 'tool') {
      hasToolResult = true;
      const toolCallId = msg.tool_call_id || msg.id || 'unknown';
      const content = typeof msg.content === 'string' ? msg.content
        : (msg.content != null ? JSON.stringify(msg.content) : '');
      prepared.push({
        role: 'user',
        content: `<tool_result for="${toolCallId}">\n${content}\n</tool_result>`
      });
      continue;
    }

    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      hasToolUse = true;
      let text = typeof msg.content === 'string' ? msg.content : (msg.content == null ? '' : String(msg.content));
      for (const tc of msg.tool_calls) {
        const name = tc.function?.name || tc.name || '';
        let args = {};
        const rawArgs = tc.function?.arguments != null ? tc.function.arguments : tc.arguments;
        if (typeof rawArgs === 'string') {
          try { args = JSON.parse(rawArgs); } catch (e) { args = { _raw: rawArgs }; }
        } else if (rawArgs && typeof rawArgs === 'object') {
          args = rawArgs;
        }
        text += `${text ? '\n' : ''}<toolcall>${JSON.stringify({ name, params: args })}</toolcall>`;
      }
      prepared.push({ role: 'assistant', content: text });
      continue;
    }

    // Normal message
    if (Array.isArray(msg.content)) {
      const textParts = [];
      const richParts = []; // keep image_url / structured parts if present
      let hasRich = false;

      for (const c of msg.content) {
        if (typeof c === 'string') {
          textParts.push(c);
          continue;
        }
        if (!c || typeof c !== 'object') continue;

        if (c.type === 'text') {
          textParts.push(c.text || '');
        } else if (c.type === 'image_url' || c.type === 'image') {
          hasRich = true;
          richParts.push(c);
        } else if (c.type === 'tool_result') {
          hasToolResult = true;
          const cid = c.tool_call_id || c.tool_use_id || 'unknown';
          const rc = typeof c.content === 'string' ? c.content : JSON.stringify(c.content || '');
          textParts.push(`<tool_result for="${cid}">\n${rc}\n</tool_result>`);
        } else if (c.type === 'tool_use' || c.type === 'function') {
          hasToolUse = true;
          const name = c.name || c.function?.name || '';
          const input = c.input || c.params || {};
          textParts.push(`<toolcall>${JSON.stringify({ name, params: input })}</toolcall>`);
        } else if (c.type === 'input_text' && c.text) {
          textParts.push(c.text);
        } else if (c.type === 'input_image') {
          hasRich = true;
          richParts.push(c);
        }
      }

      if (hasRich) {
        // Preserve multimodal structure Trae understands (text + image_url)
        const contentArr = [];
        const joined = textParts.join('');
        if (joined) contentArr.push({ type: 'text', text: joined });
        contentArr.push(...richParts);
        prepared.push({ role: msg.role, content: contentArr });
      } else {
        prepared.push({ role: msg.role, content: textParts.join('') });
      }
    } else {
      prepared.push({ role: msg.role, content: msg.content });
    }
  }

  // First principles: any tool result means we are in a continuation, even if
  // the prior assistant tool_calls were already flattened by the client.
  const isToolContinuation = hasToolResult;

  let toolMap = null;

  if (tools && Array.isArray(tools) && tools.length > 0) {
    toolMap = {};
    const compactLines = [];
    for (const t of tools) {
      // OpenAI tools: { type:'function', function:{ name, description, parameters } }
      // Anthropic-style also seen: { name, description, input_schema }
      const fn = t.function || t;
      const name = fn.name || t.name || 'unknown';
      const nameLower = name.toLowerCase();
      toolMap[nameLower] = name;
      if (nameLower === 'read' || nameLower === 'read_file') {
        toolMap['read_file'] = name; toolMap['read'] = name;
      }
      if (nameLower === 'write' || nameLower === 'write_file') {
        toolMap['write_file'] = name; toolMap['write'] = name;
      }
      if (nameLower === 'edit' || nameLower === 'edit_file' || nameLower === 'str_replace') {
        toolMap['edit_file'] = name; toolMap['edit'] = name; toolMap['str_replace'] = name;
      }
      if (nameLower === 'bash' || nameLower === 'execute_command' || nameLower === 'run_command' || nameLower === 'shell') {
        toolMap['execute_command'] = name; toolMap['bash'] = name; toolMap['run_command'] = name; toolMap['shell'] = name;
      }
      if (nameLower === 'glob' || nameLower === 'list_files' || nameLower === 'listdir') {
        toolMap['glob'] = name; toolMap['list_files'] = name; toolMap['listdir'] = name;
      }
      if (nameLower === 'grep' || nameLower === 'search_files') {
        toolMap['grep'] = name; toolMap['search_files'] = name;
      }
      if (nameLower === 'webfetch' || nameLower === 'web_fetch' || nameLower === 'fetch_url') {
        toolMap['webfetch'] = name; toolMap['web_fetch'] = name; toolMap['fetch_url'] = name;
      }
      if (nameLower === 'websearch' || nameLower === 'web_search' || nameLower === 'search_internet') {
        toolMap['websearch'] = name; toolMap['web_search'] = name; toolMap['search_internet'] = name;
      }
      const schema = fn.parameters || fn.input_schema || t.parameters || t.input_schema || {};
      const params = schema.properties ? Object.keys(schema.properties).slice(0, 8).join(',') : '';
      // Compact one-liner: name(params) — no long descriptions (OpenCode already ships tool docs)
      compactLines.push(params ? `${name}(${params})` : name);
    }

    // Compact inject: protocol + name list only. Full per-tool essays double the system prompt
    // (~20k tokens for 89 tools) and add ~2-4s TTFT with almost no benefit for OpenCode.
    let toolSystemMsg =
      `\n\n<toolcall_protocol>\n` +
      `When you need a tool, output ONLY this XML block (valid JSON inside):\n` +
      `<toolcall>{"name":"ToolName","params":{"arg":"value"}}</toolcall>\n` +
      `Rules:\n` +
      `- JSON must have "name" and "params"\n` +
      `- Use EXACT tool names from the list (case-sensitive)\n` +
      `- Do not wrap toolcall in markdown fences\n` +
      `- After <tool_result>, continue until the user question is answered\n` +
      `Tools (${compactLines.length}): ${compactLines.join(', ')}\n` +
      `</toolcall_protocol>\n`;

    if (isToolContinuation) {
      toolSystemMsg +=
        `\n<tool_continuation>\n` +
        `User returned tool results in <tool_result> blocks. Read them, call more tools if needed, ` +
        `or answer fully in plain text. Do not stop after one tool without answering.\n` +
        `</tool_continuation>\n`;
    }

    const systemMsg = prepared.find(m => m.role === 'system');
    if (systemMsg) {
      // system content may be array for multimodal; normalize to string+append
      if (typeof systemMsg.content === 'string') {
        systemMsg.content = (systemMsg.content || '') + toolSystemMsg;
      } else if (Array.isArray(systemMsg.content)) {
        systemMsg.content.push({ type: 'text', text: toolSystemMsg });
      } else {
        systemMsg.content = toolSystemMsg.trim();
      }
    } else {
      prepared.unshift({ role: 'system', content: toolSystemMsg.trim() });
    }
    if (reqId) {
      console.log(`[openai ${reqId}] Injected ${tools.length} tools (compact list, ~${toolSystemMsg.length} chars), isToolContinuation=${isToolContinuation}`);
    }
  } else if (isToolContinuation) {
    const cont = `\n\nIMPORTANT: Multi-turn tool use. Analyze <tool_result> blocks and continue. Call more tools if needed, otherwise give a complete answer. Do NOT stop prematurely.`;
    const systemMsg = prepared.find(m => m.role === 'system');
    if (systemMsg) {
      if (typeof systemMsg.content === 'string') systemMsg.content = (systemMsg.content || '') + cont;
      else if (Array.isArray(systemMsg.content)) systemMsg.content.push({ type: 'text', text: cont });
      else systemMsg.content = cont.trim();
    } else {
      prepared.unshift({ role: 'system', content: cont.trim() });
    }
    if (reqId) console.log(`[openai ${reqId}] Tool continuation detected (no tools in request)`);
  }

  return { messages: prepared, toolMap, isToolContinuation, hasToolResult, hasToolUse };
}

function applyToolMapToToolCalls(toolCalls, toolMap) {
  if (!toolCalls || !toolCalls.length || !toolMap) return toolCalls || [];
  return toolCalls.map(tc => {
    const name = tc.function?.name || '';
    const mapped = toolMap[name.toLowerCase()] || name;
    return {
      ...tc,
      function: {
        ...tc.function,
        name: mapped
      }
    };
  });
}

function handleLegacyStream(responseBody, res, completionId, modelName) {
  let buffer = '';

  responseBody.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const parsed = parseAgentTaskStream(trimmed) || parseTraeStreamChunk(trimmed);
      if (!parsed) continue;

      if (parsed.done) {
        const doneChunk = createOpenAIStreamChunk(completionId, modelName, {}, 'stop');
        res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      const openaiChunk = traeChunkToOpenAI(parsed, completionId, modelName);
      if (openaiChunk) {
        res.write(`data: ${JSON.stringify(openaiChunk)}\n\n`);
      }
    }
  });

  responseBody.on('end', () => {
    if (!res.writableEnded) {
      const doneChunk = createOpenAIStreamChunk(completionId, modelName, {}, 'stop');
      res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    }
  });

  responseBody.on('error', (err) => {
    console.error('[stream] error:', err);
    if (!res.writableEnded) {
      const errChunk = createOpenAIStreamChunk(completionId, modelName, { content: `\n\n[Error: ${err.message}]` }, 'stop');
      res.write(`data: ${JSON.stringify(errChunk)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    }
  });
}

app.post('/v1/chat/completions', authenticate, async (req, res) => {
  const reqId = uuidv4().substring(0, 8);
  const startTime = Date.now();

  try {
    const { messages: rawMessages, model, stream, temperature, max_tokens, function: funcName, config_name, workspace_dir, save_to, tools, tool_choice } = req.body;
    const thinkEffort = extractThinkEffortFromBody(req.body);

    if (!rawMessages || !Array.isArray(rawMessages) || rawMessages.length === 0) {
      return sendOpenAIError(res, 400, 'messages is required and must be a non-empty array');
    }

    const modelName = model || 'auto';
    const isStream = stream !== false;

    // OpenCode / OpenAI clients send tools + tool role messages — normalize for Trae
    const { messages, toolMap, isToolContinuation } = prepareOpenAIMessagesForTrae(rawMessages, tools, reqId);

    console.log(`[openai ${reqId}] POST /v1/chat/completions model=${modelName} stream=${isStream} messages=${messages.length} function=${funcName || 'auto'} has_tools=${!!(tools && tools.length)} toolContinuation=${isToolContinuation} think_effort=${thinkEffort ?? '(pending)'}`);
    const completionId = `chatcmpl-${uuidv4()}`;

    let saveToPath = null;
    if (save_to) {
      const wsDir = workspace_dir || WORKSPACE_DIR;
      if (path.isAbsolute(save_to)) {
        saveToPath = save_to;
      } else if (wsDir) {
        saveToPath = path.join(wsDir, save_to);
      } else {
        return res.status(400).json({ error: { message: 'save_to requires workspace_dir or WORKSPACE_DIR env', type: 'invalid_request_error' } });
      }
    }

    // ===== Phase 2: Session persistence via X-Session-Id header =====
    // Best-effort: if the header points to a valid session, persist the last
    // user message now (before the model call) and register an assistant
    // persistence callback to fire on natural stream completion.
    // On abort/error the assistant row is NOT created (grill-me G2).
    const sessionId = req.headers['x-session-id'];
    let persistAssistant = null;
    if (sessionId && typeof sessionId === 'string') {
      try {
        const lastUser = [...messages].reverse().find(m => m && m.role === 'user');
        if (lastUser && lastUser.content != null) {
          const userContent = typeof lastUser.content === 'string'
            ? lastUser.content
            : JSON.stringify(lastUser.content);
          const userMsg = sessionsRepo.addMessage(sessionId, { role: 'user', content: userContent });
          if (userMsg) {
            persistAssistant = (content, reasoning, tokenUsage) => {
              const fullContent = reasoning
                ? `[Thinking...]\n${reasoning}\n\n${content}`
                : content;
              sessionsRepo.addMessage(sessionId, {
                role: 'assistant',
                content: fullContent,
                tokensIn: (tokenUsage && tokenUsage.prompt_tokens) || 0,
                tokensOut: (tokenUsage && tokenUsage.completion_tokens) || 0,
              });
            };
          }
        }
      } catch (persistErr) {
        console.error('[persist] user message failed:', persistErr);
        // Persistence is best-effort; do not fail the chat request.
      }
    }

    const authInfo = await refreshTokenIfNeeded();
    if (isTokenExpired(authInfo)) {
      return res.status(401).json({ error: { message: 'Trae token expired. Please restart Trae IDE to refresh.', type: 'auth_error' } });
    }

    const options = {};
    if (funcName) options.function = funcName;
    if (config_name) options.config_name = config_name;
    if (workspace_dir) options.workspace_dir = workspace_dir;
    options.workspace = extractWorkspace(req);
    // think_effort is applied to messages in-process; keep raw value for fallback re-bind
    if (thinkEffort != null) options.think_effort = thinkEffort;
    else if (sessionId) {
      try {
        const sess = sessionsRepo.getSession(sessionId);
        if (sess?.config?.think_effort != null && sess.config.think_effort !== '' && sess.config.think_effort !== 'auto') {
          options.think_effort = sess.config.think_effort;
        }
      } catch (e) { /* ignore */ }
    }

    // Phase 4: Forward sampling params from request body (explicit) or session config
    const samplingKeys = ['temperature', 'top_p', 'max_tokens', 'presence_penalty', 'frequency_penalty', 'stop', 'seed', 'n'];
    for (const key of samplingKeys) {
      // Request body takes precedence over session config
      if (req.body[key] !== undefined) {
        options[key] = req.body[key];
      } else if (sessionId && persistAssistant) {
        // Session config was loaded via X-Session-Id; check if session has sampling overrides
        try {
          const sess = sessionsRepo.getSession(sessionId);
          if (sess && sess.config && sess.config[key] !== undefined && sess.config[key] !== null) {
            const schemaDefault = configSchema.getDefaults()[key];
            // Only forward if the value differs from schema default
            if (sess.config[key] !== schemaDefault) {
              // Special handling: stop is stored as comma-separated string in config
              if (key === 'stop' && typeof sess.config[key] === 'string' && sess.config[key]) {
                options[key] = sess.config[key].split(',').map(s => s.trim()).filter(Boolean);
              } else if (key === 'seed' && sess.config[key] === 0) {
                // seed=0 means not set, skip
              } else {
                options[key] = sess.config[key];
              }
            }
          }
        } catch (e) { /* best-effort */ }
      }
    }

    // Initial think_effort bind after options/session defaults resolved.
    // Fallback path re-applies with the active config_name each attempt.
    {
      const effort = options.think_effort != null ? options.think_effort : thinkEffort;
      const cfg = options.config_name || resolveModelId(modelName) || modelName;
      const { meta } = applyThinkEffort(messages, cfg, effort);
      console.log(
        `[think_effort ${reqId}] init model=${cfg} family=${meta.family || '-'} ` +
        `effort=${meta.effort} injected=${meta.injected ? 'yes' : 'no'} reason=${meta.reason}`
      );
    }

    if (isStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      // Disable Nagle-ish buffering at HTTP layer when possible
      if (res.socket && typeof res.socket.setNoDelay === 'function') {
        try { res.socket.setNoDelay(true); } catch (e) {}
      }

      const roleChunk = createOpenAIStreamChunk(completionId, modelName, { role: 'assistant' }, null);
      res.write(`data: ${JSON.stringify(roleChunk)}\n\n`);

      try {
        await runOpenAIChatWithFallback({
          messages,
          modelName,
          options,
          res,
          completionId,
          saveToPath,
          persistAssistant,
          reqId,
          isStream: true,
          toolMap,
          thinkEffort: options.think_effort != null ? options.think_effort : thinkEffort,
        });
        req.on('close', () => {
          // Best-effort: nothing else to destroy here; individual bodies are destroyed on fallback.
        });
      } catch (llmErr) {
        console.log(`[llmUtilsChat] failed: ${llmErr.message}, falling back to chatCompletion`);

        try {
          const responseBody = await chatCompletion(messages, modelName, true, options);
          handleLegacyStream(responseBody, res, completionId, modelName);
          req.on('close', () => {
            if (responseBody && responseBody.destroy) responseBody.destroy();
          });
        } catch (chatErr) {
          console.log(`[chatCompletion] failed: ${chatErr.message}, falling back to createAgentTask`);

          try {
            const agentResult = await createAgentTask(messages, modelName, true, options);
            if (agentResult.body) {
              handleLegacyStream(agentResult.body, res, completionId, modelName);
              req.on('close', () => {
                if (agentResult.body && agentResult.body.destroy) agentResult.body.destroy();
              });
            } else {
              const doneChunk = createOpenAIStreamChunk(completionId, modelName, {}, 'stop');
              res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
              res.write('data: [DONE]\n\n');
              res.end();
            }
          } catch (agentErr) {
            console.error('All endpoints failed:', agentErr);
            if (!res.writableEnded) {
              const errChunk = createOpenAIStreamChunk(completionId, modelName, { content: `[Error: ${agentErr.message}]` }, 'stop');
              res.write(`data: ${JSON.stringify(errChunk)}\n\n`);
              res.write('data: [DONE]\n\n');
              res.end();
            }
          }
        }
      }
    } else {
      try {
        const collected = await runOpenAIChatWithFallback({
          messages,
          modelName,
          options,
          res,
          completionId,
          saveToPath,
          persistAssistant,
          reqId,
          isStream: false,
          toolMap,
          thinkEffort: options.think_effort != null ? options.think_effort : thinkEffort,
        });

        let fullContent = collected.fullContent || '';
        const fullReasoning = collected.fullReasoning || '';
        const tokenUsage = collected.tokenUsage || null;
        let finishReason = collected.finishReason || 'stop';
        const modelUsed = collected.modelUsed || modelName;
        let toolCalls = applyToolMapToToolCalls(collected.toolCalls || [], toolMap);
        if (toolCalls.length > 0 && (!finishReason || finishReason === 'stop')) {
          finishReason = 'tool_calls';
        }

        const usage = tokenUsage ? {
          prompt_tokens: tokenUsage.prompt_tokens || 0,
          completion_tokens: tokenUsage.completion_tokens || 0,
          total_tokens: tokenUsage.total_tokens || (tokenUsage.prompt_tokens || 0) + (tokenUsage.completion_tokens || 0),
        } : undefined;

        const response = createOpenAIChatCompletion(completionId, modelUsed, fullContent, finishReason, fullReasoning, usage, toolCalls);

        if (saveToPath && fullContent) {
          try {
            const dir = path.dirname(saveToPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(saveToPath, fullContent, 'utf-8');
            console.log(`[file] Saved to: ${saveToPath}`);
            syncFileToOutput(saveToPath);
            response.saved_to = saveToPath;
          } catch (fileErr) {
            console.error(`[file] Save failed: ${fileErr.message}`);
            response.save_error = fileErr.message;
          }
        }

        if (persistAssistant) {
          try { persistAssistant(fullContent, fullReasoning, tokenUsage, toolCalls); }
          catch (e) { console.error('[persist] assistant (non-stream) failed:', e); }
        }

        if (toolCalls.length) {
          console.log(`[openai ${reqId}] non-stream finish_reason=${finishReason} tools=${toolCalls.map(t => t.function.name).join(',')}`);
        }

        res.json(response);
      } catch (llmErr) {
        console.log(`[llmUtilsChat] non-stream failed: ${llmErr.message}, falling back`);

        let content = '';
        try {
          const responseBody = await chatCompletion(messages, modelName, true, options);
          await new Promise((resolve, reject) => {
            let buffer = '';

            responseBody.on('data', (chunk) => {
              buffer += chunk.toString();
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';

              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;

                const parsed = parseAgentTaskStream(trimmed) || parseTraeStreamChunk(trimmed);
                if (!parsed) continue;

                if (parsed.done) {
                  return;
                }

                if (parsed.content) {
                  content += parsed.content;
                }
              }
            });

            responseBody.on('end', resolve);
            responseBody.on('error', reject);
          });
        } catch (chatErr) {
          try {
            const agentResult = await createAgentTask(messages, modelName, true, options);
            if (agentResult.body) {
              await new Promise((resolve, reject) => {
                let buffer = '';

                agentResult.body.on('data', (chunk) => {
                  buffer += chunk.toString();
                  const lines = buffer.split('\n');
                  buffer = lines.pop() || '';

                  for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;

                    const parsed = parseAgentTaskStream(trimmed) || parseTraeStreamChunk(trimmed);
                    if (!parsed) continue;

                    if (parsed.content) {
                      content += parsed.content;
                    }
                  }
                });

                agentResult.body.on('end', resolve);
                agentResult.body.on('error', reject);
              });
            }
          } catch (agentErr) {
            throw new Error(`All endpoints failed: [llm] ${llmErr.message} [chat] ${chatErr.message} [agent] ${agentErr.message}`);
          }
        }

        if (persistAssistant) {
          try { persistAssistant(content, '', null); }
          catch (e) { console.error('[persist] assistant (fallback) failed:', e); }
        }

        const response = createOpenAIChatCompletion(completionId, modelName, content, 'stop');
        res.json(response);
      }
    }
  } catch (err) {
    console.error('Chat completion error:', err);
    res.status(500).json({
      error: {
        message: err.message,
        type: 'internal_error'
      }
    });
  }
});

app.get('/v1/status', authenticate, async (req, res) => {
  try {
    const authInfo = await refreshTokenIfNeeded();
    const deviceIds = getDeviceIds();
    const apiHost = getApiHost();
    const edition = detectEdition();
    res.json({
      status: 'ok',
      edition: edition,
      token_expired: isTokenExpired(authInfo),
      token_expires_at: authInfo.expiredAt,
      user_id: authInfo.userId,
      user_region: authInfo.userRegion,
      api_host: apiHost,
      account: authInfo.account?.username,
      workspace_dir: WORKSPACE_DIR,
      auto_continue: AUTO_CONTINUE,
      max_continues: MAX_CONTINUES,
      device_ids: {
        machine_id: deviceIds.machineId ? deviceIds.machineId.substring(0, 8) + '...' : 'N/A'
      }
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/v1/encrypt', authenticate, (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return sendOpenAIError(res, 400, 'text is required');
    const encrypted = encrypt(text);
    res.json({ encrypted, hash: hashContent(text) });
  } catch (err) {
    sendOpenAIError(res, 500, err.message, 'internal_error');
  }
});

app.post('/v1/decrypt', authenticate, (req, res) => {
  try {
    const { encrypted } = req.body;
    if (!encrypted) return sendOpenAIError(res, 400, 'encrypted is required');
    const decrypted = decrypt(encrypted);
    res.json({ decrypted });
  } catch (err) {
    sendOpenAIError(res, 500, err.message, 'internal_error');
  }
});

app.get('/v1/models/detail', authenticate, async (req, res) => {
  try {
    const funcName = req.query.function || 'chat_v3';
    const result = await getModelDetailParam(funcName);
    res.json(result);
  } catch (err) {
    sendOpenAIError(res, 500, err.message, 'internal_error');
  }
});

app.get('/v1/chat/modes', authenticate, async (req, res) => {
  try {
    const result = await getChatModes();
    res.json(result);
  } catch (err) {
    sendOpenAIError(res, 500, err.message, 'internal_error');
  }
});

app.post('/v1/chat/file', authenticate, async (req, res) => {
  try {
    const { messages, model, function: funcName, filename, workspace_dir, overwrite } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: { message: 'messages is required', type: 'invalid_request_error' } });
    }
    if (!filename) {
      return res.status(400).json({ error: { message: 'filename is required (e.g. "output.md" or "report.html")', type: 'invalid_request_error' } });
    }

    const wsDir = workspace_dir || WORKSPACE_DIR;
    if (!wsDir) {
      return res.status(400).json({ error: { message: 'workspace_dir or WORKSPACE_DIR env is required', type: 'invalid_request_error' } });
    }

    const saveToPath = path.isAbsolute(filename) ? filename : path.join(wsDir, filename);

    if (fs.existsSync(saveToPath) && !overwrite) {
      return res.status(409).json({ error: { message: `File already exists: ${saveToPath}. Set overwrite=true to replace.`, type: 'file_exists', path: saveToPath } });
    }

    const modelName = model || 'auto';
    const options = {};
    if (funcName) options.function = funcName;
    options.workspace = extractWorkspace(req);

    const completionId = `chatcmpl-${uuidv4()}`;

    const authInfo = await refreshTokenIfNeeded();
    if (isTokenExpired(authInfo)) {
      return res.status(401).json({ error: { message: 'Trae token expired', type: 'auth_error' } });
    }

    console.log(`[chat/file] Generating file: ${saveToPath}`);

    const result = await llmUtilsChat(messages, modelName, true, options);
    let fullContent = '';
    let fullReasoning = '';
    let tokenUsage = null;
    let finishReason = 'stop';

    if (result.body) {
      await new Promise((resolve, reject) => {
        let buffer = '';
        let currentEventName = '';

        result.body.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            const parsed = parseLlmUtilsChatStream(trimmed, currentEventName);
            if (!parsed) continue;

            if (parsed._type === 'event_name') {
              currentEventName = parsed.value;
              continue;
            }
            if (parsed.type === 'token_usage') {
              tokenUsage = parsed.data;
              continue;
            }
            if (parsed.type === 'done') {
              finishReason = parsed.finish_reason || 'stop';
              continue;
            }
            if (parsed.type === 'text' && parsed.content) {
              fullContent += parsed.content;
            }
            if (parsed.type === 'text' && parsed.reasoning) {
              fullReasoning += parsed.reasoning;
            }
          }
        });

        result.body.on('end', resolve);
        result.body.on('error', reject);
      });
    }

    const dir = path.dirname(saveToPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(saveToPath, fullContent, 'utf-8');
    console.log(`[file] Saved to: ${saveToPath} (${fullContent.length} chars)`);
    syncFileToOutput(saveToPath);

    const usage = tokenUsage ? {
      prompt_tokens: tokenUsage.prompt_tokens || 0,
      completion_tokens: tokenUsage.completion_tokens || 0,
      total_tokens: tokenUsage.total_tokens || (tokenUsage.prompt_tokens || 0) + (tokenUsage.completion_tokens || 0),
    } : undefined;

    res.json({
      id: completionId,
      object: 'chat.completion.file',
      created: Math.floor(Date.now() / 1000),
      model: modelName,
      filename: filename,
      saved_to: saveToPath,
      file_size: fullContent.length,
      content_preview: fullContent.substring(0, 500),
      finish_reason: finishReason,
      usage: usage,
    });
  } catch (err) {
    console.error('[chat/file] error:', err);
    res.status(500).json({ error: { message: err.message, type: 'internal_error' } });
  }
});

app.get('/v1/files', authenticate, (req, res) => {
  try {
    const wsDir = req.query.workspace_dir || WORKSPACE_DIR;
    if (!wsDir) {
      return res.status(400).json({ error: 'workspace_dir or WORKSPACE_DIR env is required' });
    }

    const pattern = req.query.pattern || '';
    const files = [];

    function walkDir(dir, base) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relPath = base ? `${base}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walkDir(fullPath, relPath);
        } else {
          if (!pattern || relPath.includes(pattern)) {
            const stat = fs.statSync(fullPath);
            files.push({
              name: entry.name,
              path: relPath,
              size: stat.size,
              modified: stat.mtime.toISOString(),
            });
          }
        }
      }
    }

    if (fs.existsSync(wsDir)) {
      walkDir(wsDir, '');
    }

    res.json({ workspace: wsDir, files: files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/v1/files/read', authenticate, (req, res) => {
  try {
    const wsDir = req.query.workspace_dir || WORKSPACE_DIR;
    const filePath = req.query.path;
    if (!wsDir || !filePath) {
      return res.status(400).json({ error: 'workspace_dir and path are required' });
    }

    const fullPath = path.isAbsolute(filePath) ? filePath : path.join(wsDir, filePath);

    if (!fullPath.startsWith(wsDir) && !path.isAbsolute(filePath)) {
      return res.status(403).json({ error: 'Path must be within workspace' });
    }

    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: `File not found: ${filePath}` });
    }

    const stat = fs.statSync(fullPath);
    if (stat.size > 1024 * 1024) {
      return res.status(400).json({ error: 'File too large (max 1MB)' });
    }

    const content = fs.readFileSync(fullPath, 'utf-8');
    res.json({ path: filePath, size: stat.size, content: content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Root route: serve Dashboard HTML page (no auth required)
app.get('/', (req, res) => {
  const filePath = path.join(__dirname, '..', 'web', 'dashboard.html');
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send('Dashboard page not found. Ensure web/dashboard.html exists.');
  }
});

// Studio route: serve the chat portal (no auth required; API calls use API_KEY)
app.get('/studio', (req, res) => {
  const filePath = path.join(__dirname, '..', 'web', 'index.html');
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send('Studio page not found. Ensure web/index.html exists.');
  }
});

// API info endpoint (requires auth) - moved from root
app.get('/v1/info', authenticate, (req, res) => {
  res.json({
    name: 'trae-solo-local-api',
    version: PACKAGE_VERSION,
    description: 'OpenAI/Anthropic-compatible local API for TRAE SOLO',
    catalog: 'GET /v1',
    openapi: 'GET /v1/openapi.json',
    endpoints: {
      catalog: 'GET /v1',
      openapi: 'GET /v1/openapi.json',
      chat: 'POST /v1/chat/completions',
      chat_file: 'POST /v1/chat/file',
      models: 'GET /v1/models',
      models_detail: 'GET /v1/models/detail?function=chat_v3',
      chat_modes: 'GET /v1/chat/modes',
      anthropic: 'POST /v1/messages',
      think_effort: 'GET /v1/think-effort',
      files: 'GET /v1/files',
      files_read: 'GET /v1/files/read?path=xxx',
      status: 'GET /v1/status',
      encrypt: 'POST /v1/encrypt',
      decrypt: 'POST /v1/decrypt',
      sessions: 'GET|POST /v1/sessions',
      config_schema: 'GET /v1/config/schema',
      dashboard: 'GET / (HTML page)',
      dashboard_api: 'GET /v1/dashboard/status|sessions|requests|stats',
      info: 'GET /v1/info',
      health: 'GET /health',
    },
    features: {
      think_effort: true,
      auto_continue: AUTO_CONTINUE,
      max_continues: MAX_CONTINUES,
      queue_fallback: true,
    },
    primary_endpoint: '/api/agent/v3/llm_utils_chat',
    functions: Object.keys(FUNCTION_MAP),
  });
});

// Health check endpoint (no auth required) - for uptime monitoring
app.get('/health', (req, res) => {
  const uptime = Date.now() - serverStartTime;
  const uptimeStr = `${Math.floor(uptime / 3600000)}h ${Math.floor((uptime % 3600000) / 60000)}m ${Math.floor((uptime % 60000) / 1000)}s`;
  res.json({
    status: 'ok',
    version: PACKAGE_VERSION,
    uptime: uptimeStr,
    uptime_ms: uptime,
    startedAt: new Date(serverStartTime).toISOString(),
  });
});

app.get('/v1/sync/pending', authenticate, (req, res) => {
  res.json({
    workspace: WORKSPACE_DIR,
    sync_dir: OUTPUT_SYNC_DIR || null,
    pending_files: pendingSyncFiles.map(f => ({
      src: f,
      dest: OUTPUT_SYNC_DIR ? path.join(OUTPUT_SYNC_DIR, path.relative(WORKSPACE_DIR, f)) : null,
      rel: path.relative(WORKSPACE_DIR, f),
    })),
    count: pendingSyncFiles.length,
  });
});

app.post('/v1/sync/clear', authenticate, (req, res) => {
  const cleared = pendingSyncFiles.length;
  pendingSyncFiles.length = 0;
  res.json({ cleared });
});

// ==================== Dashboard API ====================

/**
 * 从请求中提取 workspace 标识
 * 优先级: X-Workspace header > workspace query param > body.workspace > 'default'
 */
function extractWorkspace(req) {
  // 1. X-Workspace header
  const headerWs = req.headers['x-workspace'];
  if (headerWs) return sanitizeWorkspace(headerWs);
  // 2. Query parameter
  const queryWs = req.query?.workspace;
  if (queryWs) return sanitizeWorkspace(queryWs);
  // 3. Body parameter
  const bodyWs = req.body?.workspace;
  if (bodyWs) return sanitizeWorkspace(bodyWs);
  return 'default';
}

function sanitizeWorkspace(ws) {
  return String(ws).replace(/[<>:"/\\|?*]/g, '_').replace(/[^a-zA-Z0-9_\-\.\u4e00-\u9fff]/g, '-').substring(0, 64) || 'default';
}

app.get('/v1/dashboard/status', authenticate, (req, res) => {
  const uptime = Date.now() - serverStartTime;
  const uptimeStr = `${Math.floor(uptime / 3600000)}h ${Math.floor((uptime % 3600000) / 60000)}m ${Math.floor((uptime % 60000) / 1000)}s`;
  res.json({
    name: 'Trae Local API',
    version: PACKAGE_VERSION,
    port: PORT,
    uptime: uptimeStr,
    uptime_ms: uptime,
    startedAt: new Date(serverStartTime).toISOString(),
    activeRequests: trafficLogger.getActiveCount(),
    autoContinue: AUTO_CONTINUE,
    maxContinues: MAX_CONTINUES,
    workspaceDir: WORKSPACE_DIR,
    outputSyncDir: OUTPUT_SYNC_DIR
  });
});

app.get('/v1/dashboard/sessions', authenticate, (req, res) => {
  const active = trafficLogger.getActiveRequests();
  const dirs = trafficLogger.getLogDirectories();
  const workspaces = new Map();
  for (const d of dirs) {
    const ws = workspaces.get(d.workspace) || { workspace: d.workspace, totalRequests: 0, dates: [] };
    ws.totalRequests += d.fileCount;
    ws.dates.push({ date: d.date, requests: d.fileCount });
    workspaces.set(d.workspace, ws);
  }
  res.json({
    activeRequests: active,
    workspaces: Array.from(workspaces.values()),
    activeCount: active.length
  });
});

app.get('/v1/dashboard/requests', authenticate, (req, res) => {
  const workspace = req.query.workspace || '';
  const limit = parseInt(req.query.limit) || 50;
  const offset = parseInt(req.query.offset) || 0;
  const entries = trafficLogger.readRecentLogs(workspace, limit, offset);
  res.json({ requests: entries, total: entries.length, limit, offset, workspace: workspace || 'all' });
});

app.get('/v1/dashboard/stats', authenticate, (req, res) => {
  const workspace = req.query.workspace || '';
  const entries = trafficLogger.readRecentLogs(workspace, 500, 0);
  
  // Aggregate stats
  let totalTokens = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalDuration = 0;
  let totalContentLength = 0;
  const modelStats = {};
  const timelineStats = {}; // hour -> { tokens, count }
  
  for (const e of entries) {
    totalTokens += e.tokens || 0;
    totalPromptTokens += e.promptTokens || 0;
    totalCompletionTokens += e.completionTokens || 0;
    totalDuration += e.duration_ms || 0;
    totalContentLength += e.contentLength || 0;
    
    const model = e.model || 'unknown';
    if (!modelStats[model]) modelStats[model] = { requests: 0, tokens: 0, duration: 0 };
    modelStats[model].requests++;
    modelStats[model].tokens += e.tokens || 0;
    modelStats[model].duration += e.duration_ms || 0;
    
    if (e.timestamp) {
      const hour = e.timestamp.substring(0, 13); // "2026-05-25T15"
      if (!timelineStats[hour]) timelineStats[hour] = { tokens: 0, count: 0 };
      timelineStats[hour].tokens += e.tokens || 0;
      timelineStats[hour].count++;
    }
  }
  
  res.json({
    workspace: workspace || 'all',
    totalRequests: entries.length,
    totalTokens,
    totalPromptTokens,
    totalCompletionTokens,
    totalDurationMs: totalDuration,
    avgDurationMs: entries.length ? Math.round(totalDuration / entries.length) : 0,
    totalContentLength,
    modelStats,
    timelineStats: Object.entries(timelineStats).sort().map(([hour, data]) => ({ hour: hour.substring(11), ...data }))
  });
});

app.get('/v1/dashboard/log/:date/:workspace/:logId', authenticate, (req, res) => {
  const { date, workspace, logId } = req.params;
  const entry = trafficLogger.readLogEntry(date, workspace, logId);
  if (!entry) return res.status(404).json({ error: 'Log not found' });
  res.json(entry);
});

app.get('/v1/dashboard/active/:logId', authenticate, (req, res) => {
  const { logId } = req.params;
  const detail = trafficLogger.getActiveRequestDetail(logId);
  if (!detail) return res.status(404).json({ error: 'Active request not found', isActive: false });
  res.json(detail);
});

// Think-effort support matrix (system-prompt injection for reasoning depth)
app.get('/v1/think-effort', authenticate, (req, res) => {
  res.json(getThinkEffortSupport());
});

// Fallback config API
app.get('/v1/dashboard/fallback-config', authenticate, (req, res) => {
  res.json(getFallbackConfig());
});

app.post('/v1/dashboard/fallback-config', authenticate, (req, res) => {
  try {
    const config = req.body;
    if (typeof config.autoFallback !== 'boolean') {
      return res.status(400).json({ error: 'autoFallback must be boolean' });
    }
    if (typeof config.queueThreshold !== 'number' || config.queueThreshold < 0) {
      return res.status(400).json({ error: 'queueThreshold must be non-negative number' });
    }
    if (typeof config.mappings !== 'object') {
      return res.status(400).json({ error: 'mappings must be object' });
    }
    saveFallbackConfig(config);
    console.log('[fallback] Config updated via dashboard');
    res.json({ ok: true, config: getFallbackConfig() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/v1/dashboard/model-config', authenticate, (req, res) => {
  res.json(getModelConfig());
});

app.post('/v1/dashboard/model-config', authenticate, (req, res) => {
  try {
    const config = req.body;
    if (typeof config !== 'object' || config === null) {
      return res.status(400).json({ error: 'Config must be an object' });
    }
    if (config.models && typeof config.models !== 'object') {
      return res.status(400).json({ error: 'models must be an object' });
    }
    saveModelConfig(config);
    rebuildDerivedMaps();
    console.log('[model-config] Updated via dashboard');
    res.json({ ok: true, config: getModelConfig() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/v1/dashboard/model-config/models', authenticate, (req, res) => {
  try {
    const { key, function: fn, config_name, category, toolcall_compatible } = req.body;
    if (!key || !config_name) {
      return res.status(400).json({ error: 'key and config_name are required' });
    }
    const config = getModelConfig();
    if (!config.models) config.models = {};
    config.models[key] = {
      function: fn || 'chat_v3',
      config_name,
      category: category || 'custom',
      toolcall_compatible: toolcall_compatible !== undefined ? toolcall_compatible : null,
    };
    saveModelConfig(config);
    rebuildDerivedMaps();
    console.log(`[model-config] Added/updated model: ${key} → ${config_name}`);
    res.json({ ok: true, config: getModelConfig() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/v1/dashboard/model-config/models/:key', authenticate, (req, res) => {
  try {
    const config = getModelConfig();
    if (config.models && config.models[req.params.key]) {
      delete config.models[req.params.key];
      saveModelConfig(config);
      rebuildDerivedMaps();
      console.log(`[model-config] Deleted model: ${req.params.key}`);
      res.json({ ok: true, config: getModelConfig() });
    } else {
      res.status(404).json({ error: 'Model not found' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// /v1/dashboard: backward-compatible route (returns same Dashboard HTML as root /)
app.get('/v1/dashboard', (req, res) => {
  const filePath = path.join(__dirname, '..', 'web', 'dashboard.html');
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send('Dashboard page not found');
  }
});

// ==================== Anthropic Endpoint ====================

app.post('/v1/messages', authenticate, async (req, res) => {
  const reqId = uuidv4().substring(0, 8);
  const startTime = Date.now();

  try {
    const { model, messages, max_tokens, system, stream, temperature, tools, tool_choice, thinking } = req.body;
    const thinkEffort = extractThinkEffortFromBody(req.body);

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json(createAnthropicError({
        type: 'invalid_request_error',
        message: 'messages is required and must be a non-empty array'
      }));
    }

    const modelName = model || 'auto';
    const isStream = stream === true;
    const messageId = `msg_${uuidv4().replace(/-/g, '').substring(0, 24)}`;

    console.log(`[anthropic ${reqId}] POST /v1/messages model=${modelName} stream=${isStream} messages=${messages.length} max_tokens=${max_tokens || 'default'} has_tools=${!!tools} has_system=${!!system} thinking=${JSON.stringify(thinking) || 'none'} think_effort=${thinkEffort ?? 'auto'}`);

    const openaiMessages = anthropicToOpenAIMessages(messages, system);

    // Detect if this is a multi-turn tool call conversation (has tool_result in messages)
    let hasToolResult = false;
    let hasToolUse = false;
    for (const msg of messages) {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'tool_result') hasToolResult = true;
          if (block.type === 'tool_use') hasToolUse = true;
        }
      }
    }
    const isToolContinuation = hasToolResult && hasToolUse;

    // Compact tool inject for Anthropic clients (same protocol as OpenAI path).
    // Avoid dumping full descriptions for 80+ tools — that bloats TTFT badly.
    let toolMap = null;  // maps lowercase tool name -> original tool name
    if (tools && Array.isArray(tools) && tools.length > 0) {
      toolMap = {};
      const compactLines = [];
      for (const t of tools) {
        const name = t.name || t.function?.name || 'unknown';
        const nameLower = name.toLowerCase();
        toolMap[nameLower] = name;
        if (nameLower === 'read' || nameLower === 'read_file') {
          toolMap['read_file'] = name; toolMap['read'] = name;
        }
        if (nameLower === 'write' || nameLower === 'write_file') {
          toolMap['write_file'] = name; toolMap['write'] = name;
        }
        if (nameLower === 'edit' || nameLower === 'edit_file') {
          toolMap['edit_file'] = name; toolMap['edit'] = name;
        }
        if (nameLower === 'multiedit' || nameLower === 'multi_edit') {
          toolMap['multiedit'] = name; toolMap['multi_edit'] = name;
        }
        if (nameLower === 'glob' || nameLower === 'listdir' || nameLower === 'list_files') {
          toolMap['listdir'] = name; toolMap['glob'] = name; toolMap['list_files'] = name;
        }
        if (nameLower === 'grep' || nameLower === 'search_files') {
          toolMap['grep'] = name; toolMap['search_files'] = name;
        }
        if (nameLower === 'bash' || nameLower === 'execute_command' || nameLower === 'run_command') {
          toolMap['execute_command'] = name; toolMap['bash'] = name; toolMap['run_command'] = name;
        }
        if (nameLower === 'webfetch' || nameLower === 'fetch_url' || nameLower === 'web_fetch') {
          toolMap['webfetch'] = name; toolMap['fetch_url'] = name; toolMap['web_fetch'] = name;
        }
        if (nameLower === 'websearch' || nameLower === 'search_internet' || nameLower === 'web_search') {
          toolMap['websearch'] = name; toolMap['search_internet'] = name; toolMap['web_search'] = name;
        }
        const schema = t.input_schema || t.function?.parameters || {};
        const params = schema.properties ? Object.keys(schema.properties).slice(0, 8).join(',') : '';
        compactLines.push(params ? `${name}(${params})` : name);
      }

      let toolSystemMsg =
        `\n\n<toolcall_protocol>\n` +
        `When you need a tool, output ONLY this XML block (valid JSON inside):\n` +
        `<toolcall>{"name":"ToolName","params":{"arg":"value"}}</toolcall>\n` +
        `Rules:\n` +
        `- JSON must have "name" and "params"\n` +
        `- Use EXACT tool names from the list (case-sensitive)\n` +
        `- Do not wrap toolcall in markdown fences\n` +
        `- After tool results, continue until the user question is answered\n` +
        `Tools (${compactLines.length}): ${compactLines.join(', ')}\n` +
        `</toolcall_protocol>\n`;

      if (isToolContinuation) {
        toolSystemMsg +=
          `\n<tool_continuation>\n` +
          `User returned tool results. Read them, call more tools if needed, or answer fully in plain text.\n` +
          `Do not stop after one tool without answering.\n` +
          `</tool_continuation>\n`;
      }

      const systemMsg = openaiMessages.find(m => m.role === 'system');
      if (systemMsg) {
        systemMsg.content += toolSystemMsg;
      } else {
        openaiMessages.unshift({ role: 'system', content: toolSystemMsg });
      }

      console.log(`[anthropic ${reqId}] Injected ${tools.length} tools (compact, ~${toolSystemMsg.length} chars), isToolContinuation=${isToolContinuation}`);
    } else if (isToolContinuation) {
      // Tool continuation but no tools sent in this request - still need to instruct the model
      const systemMsg = openaiMessages.find(m => m.role === 'system');
      const continuationMsg = `\n\nIMPORTANT: Multi-turn tool use. Analyze tool results and continue. Call more tools if needed, otherwise give a complete answer. Do NOT stop prematurely.`;
      if (systemMsg) {
        systemMsg.content += continuationMsg;
      } else {
        openaiMessages.unshift({ role: 'system', content: continuationMsg });
      }
      console.log(`[anthropic ${reqId}] Tool continuation detected (no tools in request), added continuation instruction`);
    }

    // Log first user message for context
    const firstUserMsg = openaiMessages.find(m => m.role === 'user');
    if (firstUserMsg) {
      const preview = typeof firstUserMsg.content === 'string' ? firstUserMsg.content.substring(0, 100) : '(array)';
      console.log(`[anthropic ${reqId}] first user msg: "${preview}..."`);
    }

    const authInfo = await refreshTokenIfNeeded();
    if (isTokenExpired(authInfo)) {
      return res.status(401).json(createAnthropicError({
        type: 'authentication_error',
        message: 'Trae token expired. Please restart Trae IDE to refresh.'
      }));
    }

    const options = {};
    if (max_tokens) options.max_tokens = max_tokens;
    if (temperature !== undefined) options.temperature = temperature;
    options.workspace = extractWorkspace(req);
    if (thinkEffort != null) options.think_effort = thinkEffort;

    // Multimodal detection: if messages contain image content, switch to a multimodal model
    const hasImageContent = openaiMessages.some(m => {
      if (Array.isArray(m.content)) {
        return m.content.some(c => c.type === 'image' || c.type === 'image_url');
      }
      return false;
    });

    if (hasImageContent) {
      const currentConfig = resolveModelId(modelName);
      const modelEntry = MODEL_MAP[Object.keys(MODEL_MAP).find(k => MODEL_MAP[k].config_name === currentConfig)];
      if (!modelEntry?.multimodal) {
        const mmModel = findMultimodalModel(currentConfig);
        if (mmModel) {
          console.log(`[anthropic ${reqId}] Image content detected, switching to multimodal model: ${mmModel}`);
          options.config_name = mmModel;
        }
      }
    }

    // Initial think_effort bind (re-applied on each fallback / processStream with that config)
    {
      const cfg = options.config_name || resolveModelId(modelName) || modelName;
      const { meta } = applyThinkEffort(openaiMessages, cfg, options.think_effort);
      console.log(
        `[think_effort ${reqId}] init model=${cfg} family=${meta.family || '-'} ` +
        `effort=${meta.effort} injected=${meta.injected ? 'yes' : 'no'} reason=${meta.reason}`
      );
    }

    if (isStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      // Disable Nagle-ish buffering at HTTP layer when possible
      if (res.socket && typeof res.socket.setNoDelay === 'function') {
        try { res.socket.setNoDelay(true); } catch (e) {}
      }

      const sendEvent = (eventType, data) => {
        if (res.writableEnded) return;
        if (eventType === 'message_stop') {
          const elapsed = Date.now() - startTime;
          const textLen = streamState ? streamState.textContent.length : 0;
          console.log(`[anthropic ${reqId}] message_stop sent: ${elapsed}ms, text=${textLen} chars, output_tokens=${streamState?.outputTokenCount || 0}`);
        }
        res.write(`event: ${eventType}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      let streamState = null;
      let continueCount = 0;
      let lastShortText = '';
      let lastQueuePosition = 0;
      let currentMessages = [...openaiMessages];
      let fallbackAttempted = {};  // 记录已尝试的降级模型
      let raceTriggered = false;   // 是否已触发并发竞速
      let currentConfigName = null;  // 当前使用的 config_name

      // Helper: process a single llmUtilsChat stream
      const processStream = async (messages, configNameOverride = null) => {
        if (configNameOverride) {
          currentConfigName = configNameOverride;
        }
        const cfg = configNameOverride || options?.config_name || resolveModelId(modelName) || modelName;
        const { meta } = applyThinkEffort(messages, cfg, options.think_effort);
        console.log(
          `[think_effort ${reqId}] stream model=${cfg} family=${meta.family || '-'} ` +
          `effort=${meta.effort} injected=${meta.injected ? 'yes' : 'no'} reason=${meta.reason}`
        );
        const result = await llmUtilsChat(messages, modelName, true, { ...options, config_name: configNameOverride || options?.config_name });
        const logId = result.logId;

        if (!result.body) {
          throw new Error('No stream body from llmUtilsChat');
        }

        return new Promise((resolve, reject) => {
          let streamBuffer = '';
          let streamEventName = '';

          // Send message_start immediately so CC doesn't time out during queue wait
          // CC expects message_start as the first event; without it, CC aborts after ~60s
          if (!streamState || !streamState.messageStarted) {
            if (!streamState) {
              streamState = {
                messageStarted: false, messageStopped: false,
                contentBlockIndex: -1, currentContentType: null,
                textContent: '', toolCalls: [], outputTokenCount: 0,
                reasoningContent: '', stopReason: null,
                suppressStopEvents: false, pendingToolCalls: [],
                toolCallBuffer: '', inToolCall: false, hasToolUse: false,
                toolCallIndex: {}
              };
            }
            sendEvent('message_start', createAnthropicMessageStart(messageId, modelName, { input_tokens: 0 }));
            streamState.messageStarted = true;
            console.log(`[anthropic ${reqId}] Sent message_start early (before queue/content)`);
          }

          result.body.on('data', (chunk) => {
            try {
              streamBuffer += chunk.toString();
              const lines = streamBuffer.split('\n');
              streamBuffer = lines.pop() || '';

              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;

                const parsed = parseLlmUtilsChatStream(trimmed, streamEventName);
                if (!parsed) continue;

                if (parsed._type === 'event_name') {
                  streamEventName = parsed.value;
                  if (logId) trafficLogger.logResponseChunk(logId, streamEventName, null);
                  continue;
                }

                if (logId) trafficLogger.logResponseChunk(logId, streamEventName, parsed);
                if (logId && parsed.type === 'text' && parsed.content) {
                  trafficLogger.logResponseContent(logId, parsed.content, parsed.reasoning);
                }
                if (logId && parsed.type === 'token_usage') {
                  trafficLogger.logTokenUsage(logId, parsed.data);
                }

                // Send keep-alive ping for progress events
                if (parsed.type === 'progress') {
                  sendEvent('ping', { type: 'ping' });
                  continue;
                }

                // Queue position handling - send as ping only, NOT as text content
                // Text content would pollute Claude Code's conversation history
                if (parsed.type === 'queue_wait' && parsed.position > 0) {
                  if (parsed.position !== lastQueuePosition) {
                    lastQueuePosition = parsed.position;

                    // Show waiting hint for popular models with long queues
                    if (parsed.position > 50) {
                      console.log(`[anthropic ${reqId}] ⚠️  Model is busy - queue position #${parsed.position}. This may take a few minutes. Consider using fallback models.`);
                    } else if (parsed.position > 20) {
                      console.log(`[anthropic ${reqId}] ⏳  Waiting in queue - position #${parsed.position}. Estimated wait: ~${Math.ceil(parsed.position * 30 / 60)} minutes.`);
                    }

                    // 检查是否需要降级
                    const fbConfig = getFallbackConfig();
                    if (fbConfig.autoFallback && parsed.position > fbConfig.queueThreshold) {
                      // Tier-based fallback: try same-tier race first, then next tier
                      if (isTieredFallbackEnabled()) {
                        const currentConfig = currentConfigName || modelName;
                        const sameTier = getSameTierModels(currentConfig).filter(m => !fallbackAttempted[m]);

                        if (sameTier.length > 0 && isRaceWithinTierEnabled()) {
                          // Race within same tier: all untried same-tier models concurrently
                          for (const m of sameTier) fallbackAttempted[m] = true;
                          console.log(`[fallback] Queue #${parsed.position} > threshold, RACE within tier: ${sameTier.join(', ')}`);

                          result.body.destroy();
                          finalizeStreamLog();
                          sendEvent('ping', { type: 'ping' });
                          lastQueuePosition = 0;

                          resolve({ fallback: true, raceModels: sameTier });
                          return;
                        }

                        // No same-tier models left, try next tier
                        const attemptedList = Object.keys(fallbackAttempted);
                        const nextTierModels = getNextTierModels(currentConfig, attemptedList);
                        if (nextTierModels.length > 0) {
                          const nextModel = nextTierModels[0];
                          fallbackAttempted[nextModel] = true;
                          console.log(`[fallback] Queue #${parsed.position} > threshold, falling back to next tier: ${nextModel}`);

                          result.body.destroy();
                          finalizeStreamLog();
                          sendEvent('ping', { type: 'ping' });
                          lastQueuePosition = 0;

                          resolve({ fallback: true, nextModel });
                          return;
                        }

                        // All tiers exhausted - use fallbackModel as last resort
                        const fbModel = getFallbackModel();
                        if (!fallbackAttempted[fbModel]) {
                          fallbackAttempted[fbModel] = true;
                          console.log(`[fallback] All tiers exhausted, using fallback model: ${fbModel}`);

                          result.body.destroy();
                          finalizeStreamLog();
                          sendEvent('ping', { type: 'ping' });
                          lastQueuePosition = 0;

                          resolve({ fallback: true, nextModel: fbModel });
                          return;
                        }
                      }

                      // Legacy fallback chain (for backward compatibility)
                      const fallbackChain = getFallbackChain(modelName);
                      const nextModel = fallbackChain.find(m => !fallbackAttempted[m]);
                      if (nextModel) {
                        fallbackAttempted[nextModel] = true;
                        console.log(`[fallback] Queue #${parsed.position} > threshold ${fbConfig.queueThreshold}, falling back to ${nextModel}`);

                        result.body.destroy();
                        finalizeStreamLog();
                        sendEvent('ping', { type: 'ping' });
                        lastQueuePosition = 0;

                        resolve({ fallback: true, nextModel });
                        return;
                      }
                    }

                    // Send ping to keep connection alive during queue wait
                    // Do NOT send queue position as text - it pollutes Claude Code's context
                    sendEvent('ping', { type: 'ping' });
                  }
                  continue;
                }

                if (parsed.type === 'queue_begin') {
                  sendEvent('ping', { type: 'ping' });
                  continue;
                }

                if (parsed.type === 'queue_end') {
                  lastQueuePosition = 0;
                  continue;
                }

                const { events, state } = llmUtilsChunkToAnthropic(parsed, messageId, modelName, streamState, toolMap);
                streamState = state;

                for (const ev of events) {
                  sendEvent(ev.event, ev.data);
                }
              }
            } catch (err) {
              console.error(`[anthropic ${reqId}] Error processing chunk:`, err);
              if (!res.writableEnded && streamState && streamState.messageStarted && !streamState.messageStopped) {
                try {
                  if (streamState.contentBlockIndex >= 0 && streamState.currentContentType !== null) {
                    sendEvent('content_block_stop', { type: 'content_block_stop', index: streamState.contentBlockIndex });
                  }
                  sendEvent('message_delta', createAnthropicMessageDelta('end_turn', { output_tokens: streamState.outputTokenCount || 0 }));
                  sendEvent('message_stop', { type: 'message_stop' });
                } catch (closeErr) { /* ignore */ }
                res.end();
              }
              reject(err);
            }
          });

          let streamFinalized = false;
          const finalizeStreamLog = () => {
            if (streamFinalized) return;
            streamFinalized = true;
            if (logId) trafficLogger.finalizeLog(logId, {
              fullContent: streamState?.textContent || '',
              fullReasoning: streamState?.reasoningContent || '',
            });
          };

          result.body.on('end', () => {
            finalizeStreamLog();
            resolve({ fallback: false });
          });

          result.body.on('close', () => {
            finalizeStreamLog();
          });

          result.body.on('error', (err) => {
            console.error(`[anthropic ${reqId}] stream error:`, err);
            finalizeStreamLog();
            reject(err);
          });

          req.on('close', () => {
            const elapsed = Date.now() - startTime;
            console.log(`[anthropic ${reqId}] client disconnected after ${elapsed}ms`);
            if (result.body && result.body.destroy) result.body.destroy();
            finalizeStreamLog();
            reject(new Error('Client disconnected'));
          });
        });
      };

      try {
        // Main loop: process stream, auto-continue if truncated
        while (continueCount <= MAX_CONTINUES) {
          // Always suppress stop events from llmUtilsChunkToAnthropic
          // We'll send them manually after checking if we need to continue
          // This must be set BEFORE processStream so the done event handler knows not to emit
          if (streamState) {
            streamState.suppressStopEvents = true;
          }

          const streamResult = await processStream(currentMessages, currentConfigName);

          // 处理降级重试
          if (streamResult && streamResult.fallback) {
            if (streamResult.raceModels) {
              // Tier-based race: concurrent requests to same-tier models
              // First to produce content wins, others are abandoned
              console.log(`[anthropic ${reqId}] Launching TIER RACE: concurrent requests to ${streamResult.raceModels.join(', ')}`);

              const raceModels = streamResult.raceModels;
              let raceWinner = null;
              const raceAborted = new Set();

              const racePromises = raceModels.map(raceModel => {
                return processStream(currentMessages, raceModel).then(r => {
                  if (!r.fallback && !raceWinner) {
                    raceWinner = raceModel;
                    console.log(`[anthropic ${reqId}] TIER RACE winner: ${raceModel}`);
                    // Abort other race participants
                    for (const m of raceModels) {
                      if (m !== raceModel) raceAborted.add(m);
                    }
                  }
                  return { ...r, _raceModel: raceModel };
                });
              });

              // Wait for first to produce content
              await Promise.race(racePromises);

              if (!raceWinner) {
                // All race models also queued - continue with original model
                console.log(`[anthropic ${reqId}] All tier race models also queued, continuing with original`);
              }
            } else if (streamResult.race) {
              // Legacy race fallback
              console.log(`[anthropic ${reqId}] Launching RACE mode: concurrent requests to ${getRaceModels().join(', ')}`);

              const raceModels = getRaceModels();
              let raceWinner = null;

              const racePromises = raceModels.map(raceModel => {
                return processStream(currentMessages, raceModel).then(r => {
                  if (!r.fallback && !raceWinner) {
                    raceWinner = raceModel;
                    console.log(`[anthropic ${reqId}] RACE winner: ${raceModel}`);
                  }
                  return { ...r, _raceModel: raceModel };
                });
              });

              await Promise.race(racePromises);

              if (!raceWinner) {
                console.log(`[anthropic ${reqId}] All race models also queued, continuing with original`);
              }
            } else {
              console.log(`[anthropic ${reqId}] Retrying with fallback model: ${streamResult.nextModel}`);
              continue;  // 重新进入循环，用降级模型重试
            }
          }

          const elapsed = Date.now() - startTime;
          console.log(`[anthropic ${reqId}] stream ended: ${elapsed}ms, stopReason=${streamState?.stopReason}, suppressStopEvents=${streamState?.suppressStopEvents}, continueCount=${continueCount}`);

          // Unified auto-continue (same rules as OpenAI path)
          if (streamState && streamState.messageStopped) {
            let continueSettingsAnthro = {};
            try {
              continueSettingsAnthro = (getModelConfig() && getModelConfig().settings) || {};
            } catch (e) { /* ignore */ }
            const decision = shouldAutoContinue(streamState, {
              enabled: AUTO_CONTINUE,
              maxContinues: MAX_CONTINUES,
              continueCount,
              lastShortText,
              settings: continueSettingsAnthro,
            });

            if (decision.similarityStop) {
              console.log(`[anthropic ${reqId}] Short response repeated, stopping auto-continue to avoid loop`);
              if (streamState.suppressStopEvents && !res.writableEnded) {
                const finalReason = streamState.hasToolUse ? 'tool_use' : (streamState.stopReason || 'end_turn');
                sendEvent('message_delta', createAnthropicMessageDelta(finalReason, { output_tokens: streamState.outputTokenCount || 0 }));
                sendEvent('message_stop', { type: 'message_stop' });
              }
              break;
            }

            if (decision.shouldContinue && decision.continueMessage) {
              continueCount++;
              console.log(
                `[anthropic ${reqId}] auto_continue reason=${decision.reason} ` +
                `(${continueCount}/${MAX_CONTINUES}) stopReason=${streamState.stopReason}`
              );
              appendContinueTurn(currentMessages, streamState, decision.continueMessage);
              if (decision.isShortResponse) {
                lastShortText = (streamState.textContent || '').trim();
              }

              // Reset streamState for the next iteration
              const savedContentBlockIndex = streamState.contentBlockIndex;
              const savedMessageStarted = streamState.messageStarted;
              const savedOutputTokenCount = streamState.outputTokenCount;

              streamState = {
                messageStarted: savedMessageStarted,
                messageStopped: false,
                contentBlockIndex: savedContentBlockIndex,
                currentContentType: null,
                textContent: '',
                reasoningContent: '',
                outputTokenCount: savedOutputTokenCount,
                hasToolUse: false,
                toolCallIndex: {},
                toolCallBuffer: '',
                inToolCall: false,
                pendingToolCalls: [],
                suppressStopEvents: true,
                stopReason: null
              };

              // Don't send message_start again - just continue with content blocks
              continue;
            }
          }

          // Response is complete or max continues reached
          // Only send final events if they were suppressed (not already sent by llmUtilsChunkToAnthropic)
          if (streamState && streamState.messageStopped && streamState.suppressStopEvents && !res.writableEnded) {
            const finalReason = streamState.hasToolUse ? 'tool_use' : (streamState.stopReason || 'end_turn');
            sendEvent('message_delta', createAnthropicMessageDelta(finalReason, { output_tokens: streamState.outputTokenCount || 0 }));
            sendEvent('message_stop', { type: 'message_stop' });
          }
          break;
        }

        // Finalize: if message_stop was already sent by llmUtilsChunkToAnthropic, just end
        if (streamState && streamState.messageStopped) {
          if (!res.writableEnded) res.end();
        } else if (streamState && streamState.messageStarted) {
          // Stream ended without proper done event - send closing events
          if (!res.writableEnded) {
            if (streamState.contentBlockIndex >= 0 && streamState.currentContentType !== null) {
              sendEvent('content_block_stop', { type: 'content_block_stop', index: streamState.contentBlockIndex });
            }
            const finalReason = streamState.hasToolUse ? 'tool_use' : 'end_turn';
            sendEvent('message_delta', createAnthropicMessageDelta(finalReason, { output_tokens: streamState.outputTokenCount || 0 }));
            sendEvent('message_stop', { type: 'message_stop' });
            res.end();
          }
        } else {
          // No content was received at all
          if (!res.writableEnded) {
            sendEvent('message_start', createAnthropicMessageStart(messageId, modelName, { input_tokens: 0 }));
            sendEvent('content_block_start', createAnthropicContentBlockStart(0, 'text', { text: '' }));
            sendEvent('content_block_stop', { type: 'content_block_stop', index: 0 });
            sendEvent('message_delta', createAnthropicMessageDelta('end_turn', { output_tokens: 0 }));
            sendEvent('message_stop', { type: 'message_stop' });
            res.end();
          }
        }
      } catch (err) {
        console.error('[anthropic stream] error:', err);
        if (!res.writableEnded) {
          sendEvent('error', createAnthropicError({
            type: 'api_error',
            message: err.message
          }));
          res.end();
        }
      }
    } else {
      try {
        {
          const cfg = options.config_name || resolveModelId(modelName) || modelName;
          const { meta } = applyThinkEffort(openaiMessages, cfg, options.think_effort);
          console.log(
            `[think_effort ${reqId}] nonstream model=${cfg} family=${meta.family || '-'} ` +
            `effort=${meta.effort} injected=${meta.injected ? 'yes' : 'no'} reason=${meta.reason}`
          );
        }
        const result = await llmUtilsChat(openaiMessages, modelName, true, options);
        let fullContent = '';
        let fullReasoning = '';
        let tokenUsage = null;
        let hasToolUse = false;
        const toolCalls = [];
        const upstreamLogId = result.logId;

        if (result.body) {
          await new Promise((resolve, reject) => {
            let buffer = '';
            let currentEventName = '';

            result.body.on('data', (chunk) => {
              buffer += chunk.toString();
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';

              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;

                const parsed = parseLlmUtilsChatStream(trimmed, currentEventName);
                if (!parsed) continue;

                if (parsed._type === 'event_name') {
                  currentEventName = parsed.value;
                  if (upstreamLogId) trafficLogger.logResponseChunk(upstreamLogId, currentEventName, null);
                  continue;
                }

                if (upstreamLogId) trafficLogger.logResponseChunk(upstreamLogId, currentEventName, parsed);

                if (parsed.type === 'token_usage') {
                  tokenUsage = parsed.data;
                  if (upstreamLogId) trafficLogger.logTokenUsage(upstreamLogId, tokenUsage);
                  continue;
                }

                if (parsed.type === 'text' && parsed.content) {
                  fullContent += parsed.content;
                  if (upstreamLogId) trafficLogger.logResponseContent(upstreamLogId, parsed.content, null);
                }
                if (parsed.type === 'text' && parsed.reasoning) {
                  fullReasoning += parsed.reasoning;
                  if (upstreamLogId) trafficLogger.logResponseContent(upstreamLogId, null, parsed.reasoning);
                }
                if (parsed.type === 'text' && parsed.tool_calls) {
                  hasToolUse = true;
                  toolCalls.push(...parsed.tool_calls);
                }
              }
            });

            result.body.on('end', resolve);
            result.body.on('error', reject);
          });
        }

        const usage = tokenUsage ? {
          input_tokens: tokenUsage.prompt_tokens || 0,
          output_tokens: tokenUsage.completion_tokens || 0
        } : undefined;

        if (upstreamLogId) trafficLogger.finalizeLog(upstreamLogId, { fullContent, fullReasoning, tokenUsage });

        // Build content blocks for non-streaming response
        const contentBlocks = [];
        if (fullReasoning) {
          contentBlocks.push({ type: 'thinking', thinking: fullReasoning });
        }

        // Extract <toolcall> tags from fullContent (non-streaming path)
        // This mirrors the streaming path's llmUtilsChunkToAnthropic behavior
        let textContent = fullContent;
        const extractedToolCalls = [];
        const toolcallRegex = /<tool_?call>\s*([\s\S]*?)\s*<\/tool_?call>/g;
        let tcMatch;
        while ((tcMatch = toolcallRegex.exec(fullContent)) !== null) {
          try {
            const parsed = parseToolcallContent(tcMatch[1]);
            if (parsed && parsed.name) {
              extractedToolCalls.push(parsed);
            }
          } catch(e) {
            console.log(`[anthropic] Non-stream toolcall parse failed: ${e.message}`);
          }
        }
        // Also try loose regex for unclosed toolcall tags (truncation recovery)
        const looseRegex = /<tool_?call>\s*([\s\S]*?)(?:<\/tool_?call>|$)/g;
        while ((tcMatch = looseRegex.exec(fullContent)) !== null) {
          const inner = tcMatch[1].trim();
          if (!inner) continue;
          try {
            const parsed = parseToolcallContent(inner);
            if (parsed && parsed.name) {
              // Dedup against already extracted
              const dup = extractedToolCalls.some(tc =>
                tc.name === parsed.name && JSON.stringify(tc.params) === JSON.stringify(parsed.params)
              );
              if (!dup) extractedToolCalls.push(parsed);
            }
          } catch(e) { /* ignore */ }
        }
        // Remove toolcall tags from text content
        if (extractedToolCalls.length > 0) {
          textContent = fullContent.replace(/<tool_?call>[\s\S]*?<\/tool_?call>/g, '').trim();
          // Also remove any unclosed toolcall tags
          textContent = textContent.replace(/<tool_?call>[\s\S]*$/g, '').trim();
          hasToolUse = true;
        }

        if (textContent) {
          contentBlocks.push({ type: 'text', text: textContent });
        }

        // Add Trae-native tool_calls
        for (const tc of toolCalls) {
          const toolId = tc.id || `toolu_${uuidv4().replace(/-/g, '').substring(0, 24)}`;
          const toolName = tc.function?.name || tc.name || '';
          const toolInput = typeof tc.function?.arguments === 'string'
            ? (function(){ try { return JSON.parse(tc.function.arguments); } catch(e) { return { _raw: tc.function.arguments }; } })() : (tc.input || {});
          contentBlocks.push({
            type: 'tool_use',
            id: toolId,
            name: toolName,
            input: toolInput
          });
        }

        // Add extracted toolcall tags as tool_use blocks
        // Apply toolMap if available (built earlier when tools were sent)
        for (const tc of extractedToolCalls) {
          let toolName = tc.name;
          if (toolMap) {
            const lower = tc.name.toLowerCase();
            if (toolMap[lower]) {
              toolName = toolMap[lower];
            } else if (toolMap[tc.name]) {
              toolName = toolMap[tc.name];
            }
          }
          const toolId = `toolu_${uuidv4().replace(/-/g, '').substring(0, 24)}`;
          contentBlocks.push({
            type: 'tool_use',
            id: toolId,
            name: toolName,
            input: tc.params || {}
          });
        }

        const stopReason = hasToolUse ? 'tool_use' : 'end_turn';
        const response = createAnthropicMessage(messageId, modelName, contentBlocks.length > 0 ? contentBlocks : '', stopReason, usage);
        res.json(response);
      } catch (err) {
        console.error('[anthropic] error:', err);
        res.status(500).json(createAnthropicError({
          type: 'api_error',
          message: err.message
        }));
      }
    }
  } catch (err) {
    console.error('[/v1/messages] error:', err);
    res.status(500).json(createAnthropicError({
      type: 'internal_error',
      message: err.message
    }));
  }
});

// ===== Sessions API (Phase 1: Web Portal v2) =====
// Source of truth: docs/PRD-web-portal-v2.md, plans/web-portal-v2.md

app.get('/v1/sessions', authenticate, (req, res) => {
  try {
    const sessions = sessionsRepo.listSessions({ q: req.query.q });
    res.json(sessions);
  } catch (err) {
    console.error('[/v1/sessions] list error:', err);
    res.status(500).json({ error: { message: err.message, type: 'internal_error' } });
  }
});

app.post('/v1/sessions', authenticate, (req, res) => {
  try {
    const session = sessionsRepo.createSession({ name: req.body?.name, config: req.body?.config });
    res.json(session);
  } catch (err) {
    console.error('[/v1/sessions] create error:', err);
    res.status(500).json({ error: { message: err.message, type: 'internal_error' } });
  }
});

app.get('/v1/sessions/:id', authenticate, (req, res) => {
  try {
    const session = sessionsRepo.getSession(req.params.id);
    if (!session) {
      return res.status(404).json({ error: { message: 'Session not found', type: 'not_found' } });
    }
    res.json(session);
  } catch (err) {
    console.error('[/v1/sessions/:id] get error:', err);
    res.status(500).json({ error: { message: err.message, type: 'internal_error' } });
  }
});

app.put('/v1/sessions/:id', authenticate, (req, res) => {
  try {
    const updated = sessionsRepo.updateSession(req.params.id, {
      name: req.body?.name,
      pinned: req.body?.pinned,
      config: req.body?.config,
    });
    if (!updated) {
      return res.status(404).json({ error: { message: 'Session not found', type: 'not_found' } });
    }
    res.json(updated);
  } catch (err) {
    console.error('[/v1/sessions/:id] put error:', err);
    res.status(500).json({ error: { message: err.message, type: 'internal_error' } });
  }
});

app.delete('/v1/sessions/:id', authenticate, (req, res) => {
  try {
    const deleted = sessionsRepo.deleteSession(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: { message: 'Session not found', type: 'not_found' } });
    }
    res.json({ deleted: true, id: req.params.id });
  } catch (err) {
    console.error('[/v1/sessions/:id] delete error:', err);
    res.status(500).json({ error: { message: err.message, type: 'internal_error' } });
  }
});

// Manual message append (any role). Used for testing, system messages, or edits.
// Chat persistence is handled by /v1/chat/completions with X-Session-Id header.
app.post('/v1/sessions/:id/messages', authenticate, (req, res) => {
  try {
    const msg = sessionsRepo.addMessage(req.params.id, {
      role: req.body?.role,
      content: req.body?.content,
      tokensIn: req.body?.tokensIn,
      tokensOut: req.body?.tokensOut,
    });
    if (!msg) {
      return res.status(404).json({ error: { message: 'Session not found', type: 'not_found' } });
    }
    res.json(msg);
  } catch (err) {
    console.error('[/v1/sessions/:id/messages] post error:', err);
    res.status(500).json({ error: { message: err.message, type: 'internal_error' } });
  }
});

// Phase 8: Truncate messages from a given message onward.
// Used for editing (truncate from old user message, then re-add edited version)
// and regenerating (truncate last assistant message, then re-send).
app.delete('/v1/sessions/:id/messages/:msgId', authenticate, (req, res) => {
  try {
    const count = sessionsRepo.truncateMessagesFrom(req.params.id, req.params.msgId);
    if (count < 0) {
      return res.status(404).json({ error: { message: 'Session or message not found', type: 'not_found' } });
    }
    res.json({ deleted: count, sessionId: req.params.id, messageId: req.params.msgId });
  } catch (err) {
    console.error('[/v1/sessions/:id/messages/:msgId] delete error:', err);
    res.status(500).json({ error: { message: err.message, type: 'internal_error' } });
  }
});

// Phase 10: Export session + messages as a single JSON download
app.get('/v1/sessions/:id/export', authenticate, (req, res) => {
  try {
    const session = sessionsRepo.getSession(req.params.id);
    if (!session) {
      return res.status(404).json({ error: { message: 'Session not found', type: 'not_found' } });
    }
    const exportData = {
      id: session.id,
      name: session.name,
      pinned: session.pinned,
      config: session.config,
      messages: session.messages || [],
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      exportedAt: Date.now(),
    };
    const filename = `session-${session.name || session.id}.json`.replace(/[^\w\-\.]/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.json(exportData);
  } catch (err) {
    console.error('[/v1/sessions/:id/export] error:', err);
    res.status(500).json({ error: { message: err.message, type: 'internal_error' } });
  }
});

// ===== Config schema (Phase 3) =====
// Source of truth for what the UI can configure.
app.get('/v1/config/schema', authenticate, (req, res) => {
  try {
    res.json(configSchema.getSchema());
  } catch (err) {
    console.error('[/v1/config/schema] error:', err);
    res.status(500).json({ error: { message: err.message, type: 'internal_error' } });
  }
});

// Global defaults — seed new sessions; user can edit via "Save as default".
app.get('/v1/config/defaults', authenticate, (req, res) => {
  try { res.json(globalDefaults); }
  catch (err) { res.status(500).json({ error: { message: err.message, type: 'internal_error' } }); }
});

app.put('/v1/config/defaults', authenticate, (req, res) => {
  try {
    globalDefaults = configSchema.validateConfig(req.body || {});
    // Also expose getDefaults/setDefaults so sessionsRepo can read them
    sessionsRepo.setGlobalDefaults(globalDefaults);
    res.json(globalDefaults);
  } catch (err) {
    console.error('[/v1/config/defaults] put error:', err);
    res.status(500).json({ error: { message: err.message, type: 'internal_error' } });
  }
});

app.listen(PORT, () => {
  console.log(`\n[Trae Local API] Server running on http://localhost:${PORT}`);
  console.log(`[Trae Local API] API Key: ${API_KEY.substring(0, 8)}${API_KEY.length > 8 ? '***' : ''}`);
  console.log(`[Trae Local API] OpenAI endpoint: http://localhost:${PORT}/v1/chat/completions`);
  console.log(`[Trae Local API] Anthropic endpoint: http://localhost:${PORT}/v1/messages`);
  console.log(`[Trae Local API] Agent tools: read_file, write_file, list_files, search_internet, fetch_url, execute_command`);
  console.log(`[Trae Local API] Workspace dir: ${WORKSPACE_DIR || 'not set'}`);
  console.log(`[Trae Local API] Auto-continue: ${AUTO_CONTINUE ? `enabled (max ${MAX_CONTINUES})` : 'disabled'}`);
  if (OUTPUT_SYNC_DIR) {
    console.log(`[Trae Local API] Output sync dir: ${OUTPUT_SYNC_DIR}`);
  }
  console.log('');
});
