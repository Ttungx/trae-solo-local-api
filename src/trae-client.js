const fetch = require('node-fetch');
const { v4: uuidv4 } = require('./uuid');
const {
  getAuthInfo, getDeviceIds, getApiHost, buildCommonHeaders,
  buildStreamHeaders, isTokenExpired, refreshTokenIfNeeded,
  detectEdition, getDeviceInfo, getIdeVersion, getIdeVersionCode
} = require('./auth');
const trafficLogger = require('./traffic-logger');
const fs = require('fs');
const path = require('path');

const FALLBACK_CONFIG_PATH = path.join(__dirname, '..', 'model-fallback.json');
const MODEL_CONFIG_PATH = path.join(__dirname, '..', 'model-config.json');

let modelConfig = { models: {}, fallback: { autoFallback: true, queueThreshold: 500, mappings: {} }, settings: {} };

function loadModelConfig() {
  try {
    if (fs.existsSync(MODEL_CONFIG_PATH)) {
      const raw = fs.readFileSync(MODEL_CONFIG_PATH, 'utf-8');
      modelConfig = JSON.parse(raw);
      console.log('[model-config] Loaded', Object.keys(modelConfig.models || {}).length, 'model mappings from model-config.json');
    } else {
      console.log('[model-config] model-config.json not found, using defaults');
    }
  } catch (e) {
    console.error('[model-config] Failed to load:', e.message);
  }
}

function saveModelConfig(config) {
  try {
    fs.writeFileSync(MODEL_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
    modelConfig = config;
  } catch (e) {
    console.error('[model-config] Failed to save:', e.message);
  }
}

function getModelConfig() {
  return JSON.parse(JSON.stringify(modelConfig));
}

const DEFAULT_FALLBACK_CONFIG = { autoFallback: true, queueThreshold: 500, mappings: {} };
let fallbackConfig = { ...DEFAULT_FALLBACK_CONFIG };

function resolveFallbackConfig(savedConfig, modelFallback) {
  // model-config.json provides defaults only. A dashboard update is persisted
  // separately in model-fallback.json and must win across restarts/reloads.
  return {
    ...DEFAULT_FALLBACK_CONFIG,
    ...(modelFallback || {}),
    ...(savedConfig || {})
  };
}

function loadFallbackConfig() {
  try {
    const savedConfig = fs.existsSync(FALLBACK_CONFIG_PATH)
      ? JSON.parse(fs.readFileSync(FALLBACK_CONFIG_PATH, 'utf-8'))
      : null;
    fallbackConfig = resolveFallbackConfig(savedConfig, modelConfig.fallback);
  } catch (e) {
    console.error('[fallback] Failed to load config:', e.message);
  }
}

function saveFallbackConfig(config) {
  try {
    fs.writeFileSync(FALLBACK_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
    fallbackConfig = config;
  } catch (e) {
    console.error('[fallback] Failed to save config:', e.message);
  }
}

function getFallbackConfig() {
  return { ...fallbackConfig };
}

loadModelConfig();
loadFallbackConfig();

let modelConfigWatcher = null;
function watchModelConfig() {
  if (modelConfigWatcher) return;
  try {
    modelConfigWatcher = fs.watch(MODEL_CONFIG_PATH, (eventType) => {
      if (eventType === 'change') {
        setTimeout(() => {
          loadModelConfig();
          loadFallbackConfig();
          rebuildDerivedMaps();
          console.log('[model-config] Reloaded (hot)');
        }, 100);
      }
    });
  } catch (e) {}
}
watchModelConfig();

let fallbackConfigWatcher = null;
function watchFallbackConfig() {
  if (fallbackConfigWatcher) return;
  try {
    fallbackConfigWatcher = fs.watch(FALLBACK_CONFIG_PATH, (eventType) => {
      if (eventType === 'change') {
        setTimeout(() => {
          loadFallbackConfig();
          console.log('[fallback] Config reloaded (hot)');
        }, 100);
      }
    });
  } catch (e) {}
}
watchFallbackConfig();

const HTTP_PROXY = process.env.HTTP_PROXY || process.env.http_proxy || '';
const HTTPS_PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || '';
const ALL_PROXY = process.env.ALL_PROXY || process.env.all_proxy || '';

const MAX_RETRIES = parseInt(process.env.TRAE_MAX_RETRIES || '3', 10);
const RETRY_BASE_DELAY = parseInt(process.env.TRAE_RETRY_DELAY || '2000', 10);
const MAX_TOKENS_LIMIT = parseInt(process.env.TRAE_MAX_TOKENS_LIMIT || '128000', 10);
const RATE_LIMIT_CODES = [4011, 429];

let _httpsAgent = null;
let _socksAgent = null;

function getProxyAgent() {
  if (_httpsAgent) return _httpsAgent;
  if (_socksAgent) return _socksAgent;

  const proxyUrl = HTTPS_PROXY || HTTP_PROXY || ALL_PROXY;
  if (!proxyUrl) return null;

  try {
    if (proxyUrl.startsWith('socks')) {
      const { SocksProxyAgent } = require('socks-proxy-agent');
      _socksAgent = new SocksProxyAgent(proxyUrl);
      console.log(`[proxy] Using SOCKS proxy: ${proxyUrl}`);
      return _socksAgent;
    } else {
      const { HttpsProxyAgent } = require('https-proxy-agent');
      _httpsAgent = new HttpsProxyAgent(proxyUrl);
      console.log(`[proxy] Using HTTP proxy: ${proxyUrl}`);
      return _httpsAgent;
    }
  } catch (err) {
    console.error(`[proxy] Failed to create proxy agent: ${err.message}`);
    return null;
  }
}

function applyProxy(options) {
  const agent = getProxyAgent();
  if (agent) {
    options.agent = agent;
  }
  return options;
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function retryWithBackoff(fn, maxRetries, baseDelay) {
  const retries = maxRetries || MAX_RETRIES;
  const delay = baseDelay || RETRY_BASE_DELAY;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isRateLimit = RATE_LIMIT_CODES.some(code => err.message.includes(String(code)));
      const isLastAttempt = attempt === retries;

      if (!isRateLimit || isLastAttempt) {
        throw err;
      }

      const waitTime = delay * Math.pow(2, attempt) + Math.random() * 1000;
      console.log(`[retry] Rate limited, waiting ${Math.round(waitTime / 1000)}s before retry ${attempt + 1}/${retries}...`);
      await sleep(waitTime);
    }
  }
}

const FUNCTION_MAP = {
  'inline_chat': 'inline_chat',
  'solo_coder': 'solo_coder',
  'chat_v3': 'chat_v3',
  'builder_v3': 'builder_v3',
  'system_diagnosis': 'system_diagnosis',
};

let MODEL_TO_FUNCTION = {};
let MODEL_MAP = {};
let REVERSE_MODEL_MAP = {};

function rebuildDerivedMaps() {
  MODEL_TO_FUNCTION = {};
  MODEL_MAP = {};
  REVERSE_MODEL_MAP = {};
  const models = modelConfig.models || {};
  for (const [key, val] of Object.entries(models)) {
    const entry = { function: val.function || 'chat_v3', config_name: val.config_name || key };
    // Index by original key, lowercase key, and config_name so mixed-case SOLO names resolve.
    const aliases = new Set([key, key.toLowerCase(), entry.config_name, String(entry.config_name).toLowerCase()]);
    for (const alias of aliases) {
      if (!alias) continue;
      MODEL_TO_FUNCTION[alias] = entry;
      MODEL_MAP[alias] = entry.config_name;
    }
  }
  MODEL_MAP['auto'] = 'auto';
  for (const [k, v] of Object.entries(MODEL_MAP)) {
    REVERSE_MODEL_MAP[v] = k;
  }
}

rebuildDerivedMaps();

function resolveModelId(modelName) {
  const lower = modelName.toLowerCase();
  if (MODEL_MAP[lower]) return MODEL_MAP[lower];
  for (const [key, val] of Object.entries(MODEL_MAP)) {
    if (lower.includes(key) || lower.includes(val)) return val;
  }
  return lower;
}

// SOLO product uses solo_* function pools (solo_work_lite / solo_agent_lite / solo_coder).
// chat_v3 is a crowded generic pool and queues heavily; SOLO real traffic uses solo_work_lite.
function getDefaultAgentFunction() {
  if (process.env.TRAE_AGENT_FUNCTION) return process.env.TRAE_AGENT_FUNCTION;
  try {
    const { isSoloProduct } = require('./auth');
    if (isSoloProduct()) return process.env.TRAE_SOLO_FUNCTION || 'solo_work_lite';
  } catch (e) {}
  return 'chat_v3';
}

function resolveModelOptions(modelName, configNameOverride) {
  const lower = (modelName || '').toLowerCase();
  const defaultFn = getDefaultAgentFunction();
  if (lower === 'auto' || !lower) {
    // Keep auto on lightweight inline_chat unless user forces SOLO function.
    if (process.env.TRAE_AUTO_FUNCTION) {
      return { function: process.env.TRAE_AUTO_FUNCTION, config_name: null };
    }
    return { function: 'inline_chat', config_name: null };
  }
  if (configNameOverride) {
    return { function: defaultFn, config_name: configNameOverride };
  }
  if (MODEL_TO_FUNCTION[lower]) {
    const mapped = { ...MODEL_TO_FUNCTION[lower] };
    // On SOLO, rewrite legacy chat_v3 mappings to solo_work_lite pool.
    if (defaultFn !== 'chat_v3' && (!mapped.function || mapped.function === 'chat_v3')) {
      mapped.function = defaultFn;
    }
    return mapped;
  }
  // Prefer longest key match so "glm-5-turbo" does not incorrectly hit "glm-5".
  let best = null;
  let bestLen = 0;
  for (const [key, val] of Object.entries(MODEL_TO_FUNCTION)) {
    if (lower === key || lower.includes(key) || key.includes(lower)) {
      if (key.length > bestLen) {
        best = { ...val };
        bestLen = key.length;
      }
    }
  }
  if (best) {
    if (defaultFn !== 'chat_v3' && (!best.function || best.function === 'chat_v3')) {
      best.function = defaultFn;
    }
    return best;
  }
  // Unknown model name: pass through as config_name (SOLO may support it directly).
  return { function: defaultFn, config_name: modelName };
}

function getFallbackChain(modelName) {
  const mappings = fallbackConfig.mappings || {};
  if (!modelName) return [];
  // Exact key first, then case-insensitive (mappings keep SOLO display names).
  if (Array.isArray(mappings[modelName])) return mappings[modelName];
  const lower = String(modelName).toLowerCase();
  if (Array.isArray(mappings[lower])) return mappings[lower];
  for (const [k, v] of Object.entries(mappings)) {
    if (String(k).toLowerCase() === lower && Array.isArray(v)) return v;
  }
  // Also try resolved config_name (e.g. claude-haiku → glm-5-turbo chain)
  try {
    const resolved = resolveModelId(modelName);
    if (resolved && resolved !== modelName) {
      if (Array.isArray(mappings[resolved])) return mappings[resolved];
      const rl = String(resolved).toLowerCase();
      for (const [k, v] of Object.entries(mappings)) {
        if (String(k).toLowerCase() === rl && Array.isArray(v)) return v;
      }
    }
  } catch (e) {}
  return [];
}

function getRaceModels() {
  return fallbackConfig.raceModels || [];
}

function isRaceFallbackEnabled() {
  return fallbackConfig.raceFallback === true && getRaceModels().length > 0;
}

// Tier-based model management
function getTiers() {
  return modelConfig.tiers || {};
}

function getModelsInTier(tierNum) {
  const tiers = getTiers();
  const tier = tiers[String(tierNum)] || tiers[tierNum];
  return tier ? (tier.models || []) : [];
}

function getTierOfModel(configName) {
  const tiers = getTiers();
  for (const [num, tier] of Object.entries(tiers)) {
    if ((tier.models || []).includes(configName)) {
      return parseInt(num, 10);
    }
  }
  // Also check model entries for tier field
  const modelEntry = modelConfig.models?.[configName];
  if (modelEntry?.tier) return modelEntry.tier;
  return null;
}

function isTieredFallbackEnabled() {
  return fallbackConfig.tieredFallback === true;
}

function isRaceWithinTierEnabled() {
  return fallbackConfig.raceWithinTier === true;
}

function getFallbackModel() {
  return fallbackConfig.fallbackModel || process.env.TRAE_FALLBACK_MODEL || 'glm-5';
}

// Get all models in the same tier as the given config_name (excluding itself)
function getSameTierModels(configName) {
  const tier = getTierOfModel(configName);
  if (!tier) return [];
  const tierModels = getModelsInTier(tier);
  return tierModels.filter(m => m !== configName);
}

// Get models from the next lower tier (higher number = lower priority)
function getNextTierModels(configName, attemptedModels) {
  const currentTier = getTierOfModel(configName);
  if (!currentTier) return [];
  const nextTier = currentTier + 1;
  const tierModels = getModelsInTier(nextTier);
  // Filter out already-attempted models and non-toolcall models if tools are needed
  return tierModels.filter(m => !attemptedModels.includes(m));
}

// Find a multimodal model in the same or nearest tier
function findMultimodalModel(configName) {
  const currentTier = getTierOfModel(configName) || 1;

  // First try same tier
  for (let t = currentTier; t <= 5; t++) {
    const tierModels = getModelsInTier(t);
    for (const m of tierModels) {
      if (m === configName) continue;
      const entry = modelConfig.models?.[m];
      if (entry?.multimodal === true) {
        return m;
      }
    }
  }

  // Fallback: search all models for any multimodal
  for (const [name, entry] of Object.entries(modelConfig.models || {})) {
    if (entry.multimodal === true && name !== configName) {
      return name;
    }
  }

  return null;
}

async function ensureAuth() {
  const authInfo = await refreshTokenIfNeeded();
  const deviceIds = getDeviceIds();
  const apiHost = getApiHost();
  const headers = buildCommonHeaders(authInfo, deviceIds);
  return { authInfo, deviceIds, apiHost, headers };
}

async function llmUtilsChat(messages, model, stream, options) {
  return retryWithBackoff(async () => {
    const { authInfo, deviceIds, apiHost } = await ensureAuth();

    const modelOpts = resolveModelOptions(model);
    const funcName = options?.function || modelOpts.function || 'inline_chat';

    const traeMessages = messages.map(m => ({
      role: m.role,
      content: Array.isArray(m.content)
        ? m.content.map(c => {
            if (typeof c === 'string') return { type: 'text', text: c };
            return c;
          })
        : [{ type: 'text', text: String(m.content || '') }]
    }));

    const body = {
      messages: traeMessages,
      function: funcName,
      stream: stream !== false,
    };

    const configName = options?.config_name || modelOpts?.config_name;
    if (configName && funcName !== 'inline_chat') {
      // SOLO-aligned pool: function=solo_work_lite + config_name/model display name.
      // Do NOT add agent_type/device_id/ide_version here — server returns 4023 "model is unknown".
      body.config_name = configName;
      body.model = configName;
    } else {
      const modelName = options?.model_name || (model && model !== 'auto' ? model : null);
      if (modelName) {
        body.model = modelName;
      }
    }

    const requestId = uuidv4();

    if (options?.max_tokens && typeof options.max_tokens === 'number') {
      body.max_tokens = Math.min(options.max_tokens, MAX_TOKENS_LIMIT);
    }

    // Phase 4: Forward OpenAI-standard sampling parameters to Trae backend.
    // Trae may not honor all of these, but we forward them best-effort.
    if (options?.temperature != null && typeof options.temperature === 'number') {
      body.temperature = options.temperature;
    }
    if (options?.top_p != null && typeof options.top_p === 'number') {
      body.top_p = options.top_p;
    }
    if (options?.presence_penalty != null && typeof options.presence_penalty === 'number') {
      body.presence_penalty = options.presence_penalty;
    }
    if (options?.frequency_penalty != null && typeof options.frequency_penalty === 'number') {
      body.frequency_penalty = options.frequency_penalty;
    }
    if (options?.stop) {
      body.stop = Array.isArray(options.stop) ? options.stop : [String(options.stop)];
    }
    if (options?.seed != null && typeof options.seed === 'number' && options.seed !== 0) {
      body.seed = options.seed;
    }
    if (options?.n != null && typeof options.n === 'number' && options.n > 1) {
      body.n = options.n;
    }

    const headers = buildStreamHeaders(authInfo, deviceIds, requestId);

    const endpoint = `${apiHost}/api/agent/v3/llm_utils_chat`;

    // 记录请求
    const logId = trafficLogger.logRequest('llmUtilsChat', {
      url: endpoint,
      method: 'POST',
      headers: headers,
      body: body
    }, options?.workspace);

    console.log(`[llmUtilsChat] POST ${endpoint}, function=${funcName}, config_name=${body.config_name || 'default'}, model=${body.model || 'default'}, stream=${stream}, logId=${logId}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 300000); // 5 min timeout

    let resp;
    try {
      resp = await fetch(endpoint, applyProxy({
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      }));
      clearTimeout(timeout);
    } catch (err) {
      clearTimeout(timeout);
      if (err.name === 'AbortError') {
        trafficLogger.logError(logId, 'llm_utils_chat request timed out after 300s');
        trafficLogger.finalizeLog(logId);
        throw new Error('llm_utils_chat request timed out after 300s');
      }
      throw err;
    }

    trafficLogger.logResponseStatus(logId, resp.status);

    if (!resp.ok) {
      const errText = await resp.text();
      trafficLogger.logError(logId, `llm_utils_chat failed: ${resp.status} ${errText}`);
      trafficLogger.finalizeLog(logId);
      throw new Error(`llm_utils_chat failed: ${resp.status} ${errText}`);
    }

    if (stream !== false) {
      return {
        body: resp.body,
        function: funcName,
        logId: logId,
      };
    }

    const data = await resp.json();
    trafficLogger.logResponseData(logId, data);
    trafficLogger.finalizeLog(logId);

    return {
      data: data,
      function: funcName,
      logId: logId,
    };
  });
}

async function getModelDetailParam(functionName) {
  const { headers, apiHost } = await ensureAuth();
  const body = {
    function: functionName || 'chat_v3',
    config_names: null,
    need_prompt: false,
    current_config_info: null,
    poly_prompt: true,
    mode_type: null,
    agent_type: null
  };
  const resp = await fetch(`${apiHost}/api/ide/v1/get_detail_param`, applyProxy({
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  }));
  if (!resp.ok) {
    throw new Error(`get_detail_param failed: ${resp.status} ${await resp.text()}`);
  }
  return resp.json();
}

async function getChatModes() {
  const { headers, apiHost } = await ensureAuth();
  const resp = await fetch(`${apiHost}/api/v1/commercial/chat_mode`, applyProxy({
    method: 'POST',
    headers,
    body: JSON.stringify({})
  }));
  if (!resp.ok) {
    throw new Error(`chat_mode failed: ${resp.status} ${await resp.text()}`);
  }
  return resp.json();
}

function generateId() {
  return uuidv4().replace(/-/g, '').substring(0, 24) +
    Date.now().toString(16).slice(-8);
}

// Cache SOLO model detail configs (encrypted_model_params etc.)
let _modelDetailCache = { at: 0, byFunction: {} };
async function getModelConfigForFunction(functionName, configName) {
  const fn = functionName || getDefaultAgentFunction();
  const now = Date.now();
  if (!_modelDetailCache.byFunction[fn] || now - _modelDetailCache.at > 10 * 60 * 1000) {
    try {
      const detail = await getModelDetailParam(fn);
      _modelDetailCache.byFunction[fn] = detail;
      _modelDetailCache.at = now;
    } catch (e) {
      console.error('[model-detail] fetch failed:', e.message);
    }
  }
  const detail = _modelDetailCache.byFunction[fn];
  const list = detail?.config_info_list || [];
  if (!configName) return list[0] || null;
  return list.find(x => x.config_name === configName || x.config_name === configName?.toLowerCase())
    || list.find(x => String(x.config_name).toLowerCase() === String(configName).toLowerCase())
    || null;
}

async function createAgentTask(messages, model, stream, options) {
  const { authInfo, deviceIds, apiHost } = await ensureAuth();
  const modelOpts = resolveModelOptions(model, options?.config_name);
  const configName = options?.config_name || modelOpts.config_name || resolveModelId(model);
  const agentFunction = options?.function || options?.agent_type || modelOpts.function || getDefaultAgentFunction();
  // SOLO real traffic: agent_type == function == solo_work_lite (or solo_agent_lite / solo_coder)
  const agentType = options?.agent_type || (agentFunction === 'chat_v3' ? 'builder_v3' : agentFunction);

  const sessionId = options?.session_id || generateId();
  const taskId = options?.task_id || generateId();
  const messageId = options?.message_id || generateId();

  const traeMessages = messages.map(m => ({
    role: m.role,
    content: Array.isArray(m.content)
      ? m.content.map(c => {
          if (typeof c === 'string') return { type: 'text', text: c };
          return c;
        })
      : [{ type: 'text', text: m.content || '' }]
  }));

  const workspaceDir = options?.workspace_dir || process.env.WORKSPACE_DIR || '';
  const workspaceId = options?.workspace_id || '';
  const lastUser = [...messages].reverse().find(m => m && m.role === 'user');
  const lastUserText = typeof lastUser?.content === 'string'
    ? lastUser.content
    : (Array.isArray(lastUser?.content)
      ? lastUser.content.map(c => c?.text || '').join('')
      : '');

  // Pull real model config so server can resolve encrypted params (still may need prompt templates).
  let modelCfg = null;
  let modelDetail = null;
  try {
    modelCfg = await getModelConfigForFunction(agentType, configName);
    modelDetail = modelCfg?.model_detail_list?.[0] || null;
  } catch (e) {}

  const deviceInfo = getDeviceInfo();
  const body = {
    session_id: sessionId,
    task_id: taskId,
    message_id: messageId,
    conversation_id: sessionId,
    chat_session_id: sessionId,
    user_id: authInfo.userId,
    messages: traeMessages,
    // Prefer internal model_name (e.g. glm-5.2__dev) when available — required by create_agent_task.
    model: modelDetail?.model_name || configName,
    model_name: modelDetail?.model_name || configName,
    config_name: configName,
    function: agentType,
    stream: stream !== false,
    mode_type: options?.mode_type != null ? options.mode_type : 1,
    agent_type: agentType,
    enable_chat_memory: options?.enable_chat_memory != null ? options.enable_chat_memory : true,
    enable_chat_memory_user_config: true,
    enable_core_memory: false,
    workspace_folder: workspaceDir,
    workspace_id: workspaceId,
    workspace_path: workspaceDir,
    work_mode: options?.work_mode || process.env.TRAE_WORK_MODE || 'work',
    user_input: {
      id: messageId,
      user_input: lastUserText,
      placeholder_map: '{}',
    },
    ide_version: getIdeVersion(),
    device_id: deviceInfo.device_id,
    available_tool_list: options?.available_tool_list || [],
    mcp_tool_list: options?.mcp_tool_list || [],
    skill_list_changed: false,
    available_plugins: options?.available_plugins || [],
    connector_list: options?.connector_list || [],
    extra_context: options?.extra_context || {},
    extra_info: JSON.stringify({
      workspace_folder: workspaceDir,
      workspace_id: workspaceId,
      workspace_path: workspaceDir,
      work_mode: options?.work_mode || process.env.TRAE_WORK_MODE || 'work'
    }),
  };

  if (modelCfg) {
    // ModelCustomConfig-shaped payload (best-effort SOLO parity)
    body.custom_model = {
      name: modelCfg.config_name,
      display_name: modelCfg.display_config?.display_name || modelCfg.config_name,
      config_name: modelCfg.config_name,
      model_name: modelDetail?.model_name || modelCfg.config_name,
      base_url: '',
      use_remote_service: true,
      multimodal: !!modelCfg.display_config?.multimodal,
      prompt_max_tokens: modelDetail?.prompt_max_tokens,
      toolcall_history_max_tokens: modelDetail?.tool_call_history_max_tokens || 0,
      encrypted_model_params: modelDetail?.encrypted_model_params,
      extra_config: modelCfg.extra_config,
      function_extra_config: modelDetail?.model_extra_config,
      max_turn: modelDetail?.max_turn,
      max_tokens: modelDetail?.max_tokens,
      is_custom_model: false,
      is_preset: true,
      status: true,
    };
    body.current_config_info = {
      config_name: modelCfg.config_name,
      is_custom_model: false,
    };
  }

  // Optional raw capture override for full SOLO body (HAR/mitm dump)
  if (options?.raw_body && typeof options.raw_body === 'object') {
    Object.assign(body, options.raw_body);
  }

  const requestId = uuidv4();
  const headers = buildStreamHeaders(authInfo, deviceIds, requestId);

  const endpoint = `${apiHost}/api/agent/v3/create_agent_task`;

  // 记录请求
  const logId = trafficLogger.logRequest('createAgentTask', {
    url: endpoint,
    method: 'POST',
    headers: headers,
    body: body
  }, options?.workspace);

  console.log(`[createAgentTask] POST ${endpoint}, agent_type=${agentType}, model=${body.model}, config=${configName}, stream=${stream}, session=${sessionId}, logId=${logId}`);

  const resp = await fetch(endpoint, applyProxy({
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  }));

  trafficLogger.logResponseStatus(logId, resp.status);

  if (!resp.ok) {
    const errText = await resp.text();
    trafficLogger.logError(logId, `create_agent_task failed: ${resp.status} ${errText}`);
    trafficLogger.finalizeLog(logId);
    throw new Error(`create_agent_task failed: ${resp.status} ${errText}`);
  }

  if (stream !== false) {
    return {
      body: resp.body,
      sessionId,
      taskId,
      messageId,
      logId: logId,
    };
  }

  const data = await resp.json();
  trafficLogger.logResponseData(logId, data);
  trafficLogger.finalizeLog(logId);

  return {
    data: data,
    sessionId,
    taskId,
    messageId,
    logId: logId,
  };
}

async function chatCompletion(messages, model, stream, options) {
  const { headers, apiHost } = await ensureAuth();
  const modelId = resolveModelId(model);

  const traeMessages = messages.map(m => ({
    role: m.role,
    content: Array.isArray(m.content)
      ? m.content.map(c => {
          if (typeof c === 'string') return { type: 'text', text: c };
          return c;
        })
      : [{ type: 'text', text: String(m.content || '') }]
  }));

  const body = {
    model: modelId,
    messages: traeMessages,
    stream: !!stream,
    function: 'chat_v3',
    ...options
  };

  const url = `${apiHost}/api/ide/v1/chat`;

  // 记录请求
  const logId = trafficLogger.logRequest('chatCompletion', {
    url: url,
    method: 'POST',
    headers: headers,
    body: body
  }, options?.workspace);

  console.log(`[chatCompletion] POST ${url}, model=${modelId}, stream=${stream}, logId=${logId}`);

  const resp = await fetch(url, applyProxy({
    method: 'POST',
    headers: {
      ...headers,
      'Accept': stream ? 'text/event-stream' : 'application/json'
    },
    body: JSON.stringify(body)
  }));

  trafficLogger.logResponseStatus(logId, resp.status);

  if (!resp.ok) {
    const errText = await resp.text();
    trafficLogger.logError(logId, `chat completion failed: ${resp.status} ${errText}`);
    trafficLogger.finalizeLog(logId);
    throw new Error(`chat completion failed: ${resp.status} ${errText}`);
  }

  if (stream) {
    return { body: resp.body, logId: logId };
  }

  const data = await resp.json();
  trafficLogger.logResponseData(logId, data);
  trafficLogger.finalizeLog(logId);

  return data;
}

module.exports = {
  MODEL_MAP,
  REVERSE_MODEL_MAP,
  MODEL_TO_FUNCTION,
  FUNCTION_MAP,
  resolveModelId,
  resolveModelOptions,
  getDefaultAgentFunction,
  getModelDetailParam,
  getModelConfigForFunction,
  getChatModes,
  llmUtilsChat,
  chatCompletion,
  createAgentTask,
  generateId,
  retryWithBackoff,
  sleep,
  getFallbackConfig,
  saveFallbackConfig,
  getFallbackChain,
  getRaceModels,
  isRaceFallbackEnabled,
  getTiers,
  getModelsInTier,
  getTierOfModel,
  isTieredFallbackEnabled,
  isRaceWithinTierEnabled,
  getFallbackModel,
  getSameTierModels,
  getNextTierModels,
  findMultimodalModel,
  loadFallbackConfig,
  resolveFallbackConfig,
  getModelConfig,
  saveModelConfig,
  loadModelConfig,
  rebuildDerivedMaps,
};
