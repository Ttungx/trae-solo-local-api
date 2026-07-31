'use strict';

/**
 * System-prompt injection for reasoning / think effort.
 * SOLO llm_utils_chat has no native reasoning_effort field; we prepend
 * model-family-specific fixed strings to the system message (top of prompt).
 *
 * Supported SOLO config_names (validated 2026-07-23, see doc/think-effort.md):
 *   glm-5.2, DeepSeek-V4-Pro, kimi-k2.7-code
 *
 * API field: think_effort (alias: reasoning_effort)
 * Values: off | auto | high | max | low  (per-model matrix below)
 */

const MARKER_START = '<<think_effort>>\n';
const MARKER_END = '\n<</think_effort>>\n\n';

/**
 * Master switch for prompt injection.
 * Set THINK_EFFORT_INJECTION=false to completely disable our prepending logic.
 * This lets the model use its native behavior (e.g. GLM-5.2 template default Max).
 * Default: true (injection enabled).
 */
const THINK_EFFORT_INJECTION = process.env.THINK_EFFORT_INJECTION !== 'false';

/** Canonical Absolute-maximum prefix (DeepSeek encoding README + Kimi deepen). */
const PREFIX_MAX_ABS =
  'Reasoning Effort: Absolute maximum with no shortcuts permitted. ' +
  'You MUST be very thorough in your thinking and comprehensively decompose the problem ' +
  'to resolve the root cause, rigorously stress-testing your logic against all potential paths, ' +
  'edge cases, and adversarial scenarios. Explicitly write out your entire deliberation process, ' +
  'documenting every intermediate step, considered alternative, and rejected hypothesis to ensure ' +
  'absolutely no assumption is left unchecked.\n\n';

const PREFIX_MAX_SHORT = 'Reasoning Effort: Max\n\n';
const PREFIX_HIGH = 'Reasoning Effort: High\n\n';

const PREFIX_KIMI_LOW =
  '<critical_constraints>\n' +
  'Reasoning Mode: Token-efficient and concise.\n' +
  'Rush through reasoning, be as concise as possible. Full send; never draft.\n' +
  'Do NOT use progressive refinement or iterative self-criticism loops.\n' +
  'You are allowed a maximum of one draft before outputting the final response.\n' +
  'BAN all moralizing, conjecture, and assumption about actions or motives. Stick to the facts.\n' +
  '</critical_constraints>\n\n';

/**
 * Family support matrix (from local SOLO probes).
 * levels: allowed think_effort values besides off/auto
 * defaultMax: which level to use when client asks for max (or generic deep)
 */
const FAMILIES = {
  glm: {
    id: 'glm',
    match: (cfg) => {
      const s = String(cfg || '').toLowerCase();
      return s === 'glm-5.2' || s.startsWith('glm-5.2');
    },
    levels: {
      // High: shorter reasoning vs default (probe: -94% once; still useful budget control)
      high: PREFIX_HIGH,
      // Max: short Max label (probe deepen n=2 mean +49%; avoid Absolute-max on GLM — hurts)
      max: PREFIX_MAX_SHORT,
    },
  },
  deepseek: {
    id: 'deepseek',
    match: (cfg) => {
      const s = String(cfg || '');
      return /^deepseek-v4-pro$/i.test(s) || s === 'DeepSeek-V4-Pro';
    },
    levels: {
      // Only Absolute-maximum long prefix deepened DS (n=2 mean +40%)
      max: PREFIX_MAX_ABS,
    },
  },
  kimi: {
    id: 'kimi',
    match: (cfg) => {
      const s = String(cfg || '').toLowerCase();
      return s === 'kimi-k2.7-code' || s === 'kimi-k2-7-code';
    },
    levels: {
      // Low suppress overthink (probe: -87%)
      low: PREFIX_KIMI_LOW,
      // Max deepen with Absolute-maximum (probe n=2: +102%, very stable)
      max: PREFIX_MAX_ABS,
    },
  },
};

const LEVEL_ALIASES = {
  off: 'off',
  none: 'off',
  false: 'off',
  '0': 'off',
  auto: 'auto',
  default: 'auto',
  high: 'high',
  medium: 'high', // map medium → high where supported
  max: 'max',
  maximum: 'max',
  deep: 'max',
  ultra: 'max',
  low: 'low',
  budget: 'low',
  minimal: 'low',
};

function normalizeEffort(raw) {
  if (raw == null || raw === '') return 'auto';
  if (typeof raw === 'boolean') return raw ? 'max' : 'off';
  if (typeof raw === 'number') {
    if (raw <= 0) return 'off';
    if (raw >= 0.9) return 'max';
    if (raw >= 0.5) return 'high';
    return 'low';
  }
  const key = String(raw).trim().toLowerCase();
  return LEVEL_ALIASES[key] || null;
}

function resolveFamily(modelOrConfig) {
  if (!modelOrConfig || modelOrConfig === 'auto') return null;
  for (const fam of Object.values(FAMILIES)) {
    if (fam.match(modelOrConfig)) return fam;
  }
  return null;
}

/**
 * Resolve which prefix (if any) to inject.
 * @returns {{ effort: string, family: string|null, prefix: string, injected: boolean, reason: string }}
 */
function resolveThinkEffort(modelOrConfig, rawEffort) {
  const effort = normalizeEffort(rawEffort);
  if (effort == null) {
    return {
      effort: String(rawEffort),
      family: null,
      prefix: '',
      injected: false,
      reason: 'unknown_effort',
    };
  }
  if (effort === 'off' || effort === 'auto') {
    return {
      effort,
      family: resolveFamily(modelOrConfig)?.id || null,
      prefix: '',
      injected: false,
      reason: effort === 'off' ? 'explicit_off' : 'auto_no_inject',
    };
  }

  const family = resolveFamily(modelOrConfig);
  if (!family) {
    return {
      effort,
      family: null,
      prefix: '',
      injected: false,
      reason: 'unsupported_model',
    };
  }

  const prefix = family.levels[effort];
  if (!prefix) {
    return {
      effort,
      family: family.id,
      prefix: '',
      injected: false,
      reason: 'unsupported_level_for_model',
    };
  }

  return {
    effort,
    family: family.id,
    prefix,
    injected: true,
    reason: 'ok',
  };
}

function stripThinkEffortMarker(text) {
  if (typeof text !== 'string' || !text) return text || '';
  // Remove any previous injection block
  const re = /<<think_effort>>[\s\S]*?<<\/think_effort>>\n*/g;
  return text.replace(re, '');
}

function wrapPrefix(prefix) {
  if (!prefix) return '';
  return MARKER_START + prefix.replace(/\n+$/, '\n') + MARKER_END;
}

function prependToSystemContent(content, block) {
  if (!block) return content;
  if (typeof content === 'string') {
    return block + stripThinkEffortMarker(content);
  }
  if (Array.isArray(content)) {
    // Strip from first text part if present; prepend new block as leading text part
    const next = content.map((part) => {
      if (part && part.type === 'text' && typeof part.text === 'string') {
        return { ...part, text: stripThinkEffortMarker(part.text) };
      }
      return part;
    });
    next.unshift({ type: 'text', text: block });
    return next;
  }
  return block + String(content ?? '');
}

/**
 * Mutate messages array: ensure system message has (or does not have) think-effort prefix.
 * Safe to call again after model fallback — strips old marker first.
 *
 * @param {Array} messages - OpenAI-style messages
 * @param {string} modelOrConfig - model id or SOLO config_name
 * @param {string|number|boolean|null} rawEffort - think_effort / reasoning_effort
 * @returns {{ messages, meta }}
 */
function applyThinkEffort(messages, modelOrConfig, rawEffort) {
  const list = Array.isArray(messages) ? messages : [];

  // Master switch: when disabled, never inject and never strip markers
  if (!THINK_EFFORT_INJECTION) {
    return {
      messages: list,
      meta: { injected: false, reason: 'injection_disabled' }
    };
  }

  const meta = resolveThinkEffort(modelOrConfig, rawEffort);
  const block = meta.injected ? wrapPrefix(meta.prefix) : '';

  // Always strip existing marker first (fallback / re-apply)
  let systemIdx = list.findIndex((m) => m && m.role === 'system');
  if (systemIdx >= 0) {
    const sys = list[systemIdx];
    if (typeof sys.content === 'string') {
      sys.content = stripThinkEffortMarker(sys.content);
    } else if (Array.isArray(sys.content)) {
      sys.content = sys.content.map((part) => {
        if (part && part.type === 'text' && typeof part.text === 'string') {
          return { ...part, text: stripThinkEffortMarker(part.text) };
        }
        return part;
      });
    }
  }

  if (!meta.injected) {
    return { messages: list, meta };
  }

  if (systemIdx >= 0) {
    const sys = list[systemIdx];
    sys.content = prependToSystemContent(sys.content, block);
  } else {
    list.unshift({ role: 'system', content: block.trimEnd() });
  }

  return { messages: list, meta };
}

/** Public support table for docs / API introspection. */
function getThinkEffortSupport() {
  return {
    param: 'think_effort',
    aliases: ['reasoning_effort'],
    global_values: ['off', 'auto', 'high', 'max', 'low'],
    note:
      'auto/off = no inject. Unsupported model or level = no-op (request still succeeds).',
    models: {
      'glm-5.2': {
        levels: ['high', 'max'],
        inject: {
          high: 'Reasoning Effort: High',
          max: 'Reasoning Effort: Max',
        },
        notes: 'Default SOLO glm-5.2 already thinks deep; high shortens, max can deepen further. Do NOT use Absolute-maximum string on GLM.',
      },
      'DeepSeek-V4-Pro': {
        levels: ['max'],
        inject: {
          max: 'Reasoning Effort: Absolute maximum with no shortcuts permitted. ...',
        },
        notes: 'Short "Max" label ineffective; long Absolute-maximum prefix required.',
      },
      'kimi-k2.7-code': {
        levels: ['low', 'max'],
        inject: {
          low: '<critical_constraints> token-efficient / never draft ...',
          max: 'Reasoning Effort: Absolute maximum with no shortcuts permitted. ...',
        },
        notes: 'low suppresses overthink; max deepens (stable in n=2 probe).',
      },
    },
  };
}

/** Extract think_effort from OpenAI/Anthropic request body. */
function extractThinkEffortFromBody(body) {
  if (!body || typeof body !== 'object') return null;
  if (body.think_effort != null) return body.think_effort;
  if (body.reasoning_effort != null) return body.reasoning_effort;
  // Anthropic-style thinking: { type: 'enabled' } is not effort; ignore budget_tokens as depth
  return null;
}

/**
 * Process-wide default when body/session omit think_effort.
 * Env THINK_EFFORT: auto|off|low|high|max (default auto = no inject).
 * Set THINK_EFFORT=off for OpenCode baseline (rely on model native default, e.g. GLM Max).
 */
function getDefaultThinkEffort() {
  if (!THINK_EFFORT_INJECTION) {
    return 'off';
  }
  const raw = process.env.THINK_EFFORT;
  if (raw == null || raw === '') {
    return 'max';  // default to max so that supported models (glm-5.2) get the reasoning effort prompt injected
  }
  const n = normalizeEffort(raw);
  return n != null ? n : 'max';
}

/**
 * Resolve effort: body > session > env default.
 * @param {*} bodyEffort - from extractThinkEffortFromBody
 * @param {*} sessionEffort - optional session config.think_effort
 */
function resolveRequestThinkEffort(bodyEffort, sessionEffort) {
  if (bodyEffort != null && bodyEffort !== '') return bodyEffort;
  if (
    sessionEffort != null &&
    sessionEffort !== '' &&
    String(sessionEffort).toLowerCase() !== 'auto'
  ) {
    return sessionEffort;
  }
  return getDefaultThinkEffort();
}

module.exports = {
  applyThinkEffort,
  resolveThinkEffort,
  resolveFamily,
  normalizeEffort,
  getThinkEffortSupport,
  extractThinkEffortFromBody,
  getDefaultThinkEffort,
  resolveRequestThinkEffort,
  stripThinkEffortMarker,
  THINK_EFFORT_INJECTION,
  FAMILIES,
  PREFIX_MAX_ABS,
  PREFIX_MAX_SHORT,
  PREFIX_HIGH,
  PREFIX_KIMI_LOW,
  MARKER_START,
  MARKER_END,
};
