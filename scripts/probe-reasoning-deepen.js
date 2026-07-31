#!/usr/bin/env node
/**
 * Depth-only probe: does system-prefix injection INCREASE reasoning?
 * - Families: GLM / DeepSeek / Kimi
 * - Each (model × condition) repeated REPEATS times
 * - Short task; sequential; fallback must be off
 * - Metric: reasoning_content length + latency (+ completion tokens if any)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const API = process.env.PROBE_API || 'http://localhost:19900/v1/chat/completions';
const KEY = process.env.API_KEY || 'trae-solo-local-api-key';
const REPEATS = Math.max(1, parseInt(process.env.PROBE_REPEATS || '2', 10));
const REQUEST_TIMEOUT_MS = Math.max(
  1_000,
  parseInt(process.env.PROBE_REQUEST_TIMEOUT_MS || '300000', 10)
);

// Short multi-step task — enough to think, not 200s essay
const USER_TASK =
  'nums is a rotated sorted array with UNIQUE ints. ' +
  'Write findMin(nums) binary search O(log n). ' +
  'One counterexample if you used mid vs left instead of mid vs right. ' +
  'English. Code + 3-6 sentence proof. No fluff.';

const PREFIX = {
  none: '',
  max_short: 'Reasoning Effort: Max\n\n',
  max_abs:
    'Reasoning Effort: Absolute maximum with no shortcuts permitted. ' +
    'You MUST be very thorough in your thinking and comprehensively decompose the problem ' +
    'to resolve the root cause, rigorously stress-testing your logic against all potential paths, ' +
    'edge cases, and adversarial scenarios. Explicitly write out your entire deliberation process, ' +
    'documenting every intermediate step, considered alternative, and rejected hypothesis to ensure ' +
    'absolutely no assumption is left unchecked.\n\n',
  // Kimi/community sometimes responds to "thorough" style differently than Max label
  thorough:
    'Thinking Mode: Maximum depth. Expand the full reasoning chain before answering. ' +
    'Consider edge cases, rejected alternatives, and prove each branch. Do not rush.\n\n',
};

const DEFAULT_MODELS = ['glm-5.2', 'DeepSeek-V4-Pro', 'kimi-k2.7-code'];
const MODELS = (process.env.PROBE_MODELS || DEFAULT_MODELS.join(','))
  .split(',')
  .map((model) => model.trim())
  .filter(Boolean);

// Depth-seeking conditions only (no Low suppress)
const DEFAULT_CONDITIONS = [
  { id: 'base', prefixKey: 'none' },
  { id: 'max_short', prefixKey: 'max_short' },
  { id: 'max_abs', prefixKey: 'max_abs' },
  { id: 'thorough', prefixKey: 'thorough' },
];
const conditionIds = (process.env.PROBE_CONDITIONS || '')
  .split(',')
  .map((condition) => condition.trim())
  .filter(Boolean);
const CONDITIONS = conditionIds.length
  ? DEFAULT_CONDITIONS.filter((condition) => conditionIds.includes(condition.id))
  : DEFAULT_CONDITIONS;
if (!CONDITIONS.length) {
  throw new Error(`No valid PROBE_CONDITIONS: ${process.env.PROBE_CONDITIONS}`);
}

function buildMessages(prefix) {
  return [
    {
      role: 'system',
      content:
        (prefix || '') +
        'You are a careful coding assistant. Prefer correct algorithms.',
    },
    { role: 'user', content: USER_TASK },
  ];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function median(nums) {
  if (!nums.length) return null;
  const a = [...nums].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function mean(nums) {
  if (!nums.length) return null;
  return nums.reduce((s, n) => s + n, 0) / nums.length;
}

async function oneCall(model, condition, rep) {
  const prefix = PREFIX[condition.prefixKey];
  const t0 = Date.now();
  const res = await fetch(API, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      config_name: model,
      stream: false,
      messages: buildMessages(prefix),
      max_tokens: 2048,
    }),
  });
  const text = await res.text();
  const ms = Date.now() - t0;
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return {
      model,
      condition: condition.id,
      rep,
      ok: false,
      ms,
      error: text.slice(0, 200),
    };
  }
  if (!res.ok) {
    return {
      model,
      condition: condition.id,
      rep,
      ok: false,
      ms,
      status: res.status,
      error: JSON.stringify(json).slice(0, 200),
    };
  }
  const msg = json.choices?.[0]?.message || {};
  const content = msg.content || '';
  const reasoning =
    msg.reasoning_content ||
    msg.reasoning ||
    (typeof msg.thinking === 'string' ? msg.thinking : '') ||
    '';
  const usage = json.usage || {};
  const empty = !content && !reasoning;
  return {
    model,
    condition: condition.id,
    rep,
    ok: !empty,
    ms,
    returnedModel: json.model || model,
    reasoningChars: reasoning.length,
    contentChars: content.length,
    completionTokens: usage.completion_tokens ?? usage.output_tokens ?? null,
    promptTokens: usage.prompt_tokens ?? usage.input_tokens ?? null,
    reasoningHead: reasoning.replace(/\s+/g, ' ').slice(0, 100),
    error: empty ? 'empty response' : undefined,
  };
}

async function oneCallWithRetry(model, condition, rep) {
  let r = await oneCall(model, condition, rep);
  if (!r.ok) {
    await sleep(1500);
    r = await oneCall(model, condition, rep);
    r.retried = true;
  }
  return r;
}

function pad(s, n) {
  s = String(s ?? '');
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

async function main() {
  console.log(
    `API=${API} REPEATS=${REPEATS} REQUEST_TIMEOUT_MS=${REQUEST_TIMEOUT_MS}`
  );
  console.log(`Models: ${MODELS.join(', ')}`);
  console.log(`Conditions: ${CONDITIONS.map((c) => c.id).join(', ')}`);
  console.log(
    `Cells: ${MODELS.length * CONDITIONS.length} × ${REPEATS} = ${MODELS.length * CONDITIONS.length * REPEATS} calls\n`
  );

  // health
  try {
    const h = await fetch(API.replace('/chat/completions', '/status'), {
      headers: { Authorization: `Bearer ${KEY}` },
    });
    if (!h.ok) throw new Error(`status ${h.status}`);
  } catch (e) {
    console.error('Health FAIL:', e.message);
    process.exit(1);
  }

  // confirm fallback off (best-effort)
  try {
    const fb = await fetch('http://localhost:19900/v1/dashboard/fallback-config', {
      headers: { Authorization: `Bearer ${KEY}` },
    });
    if (fb.ok) {
      const j = await fb.json();
      console.log(
        `fallback: auto=${j.autoFallback} thr=${j.queueThreshold} tiered=${j.tieredFallback} race=${j.raceWithinTier}`
      );
      if (j.autoFallback !== false) {
        console.warn('WARN: autoFallback still ON — results may swap models. Disable first.\n');
      } else {
        console.log('fallback OFF — good\n');
      }
    }
  } catch {
    /* ignore */
  }

  const rows = [];
  // Order: for each model, for each condition, all repeats — keeps family cache-ish, easier abort
  for (const model of MODELS) {
    for (const cond of CONDITIONS) {
      for (let rep = 1; rep <= REPEATS; rep++) {
        process.stdout.write(`>> ${model} / ${cond.id} #${rep} ... `);
        try {
          const r = await oneCallWithRetry(model, cond, rep);
          rows.push(r);
          if (r.ok) {
            console.log(
              `ok ret=${r.returnedModel} R=${r.reasoningChars} C=${r.contentChars} ${r.ms}ms` +
                (r.completionTokens != null ? ` out=${r.completionTokens}` : '')
            );
          } else {
            console.log(`FAIL ${r.error || r.status}`);
          }
        } catch (e) {
          console.log(`ERR ${e.message}`);
          rows.push({
            model,
            condition: cond.id,
            rep,
            ok: false,
            error: e.message,
          });
        }
        await sleep(800);
      }
    }
  }

  // Aggregate
  console.log('\n=== PER-CELL (mean / median reasoning chars over ok repeats) ===');
  console.log(
    pad('model', 18) +
      pad('cond', 12) +
      pad('n', 4) +
      pad('meanR', 10) +
      pad('medR', 10) +
      pad('minR', 10) +
      pad('maxR', 10) +
      pad('meanMs', 10) +
      'meanOutTok'
  );

  const cells = [];
  for (const model of MODELS) {
    for (const cond of CONDITIONS) {
      const ok = rows.filter(
        (r) => r.ok && r.model === model && r.condition === cond.id
      );
      const Rs = ok.map((r) => r.reasoningChars);
      const Ms = ok.map((r) => r.ms);
      const Ts = ok.map((r) => r.completionTokens).filter((x) => x != null);
      const cell = {
        model,
        condition: cond.id,
        n: ok.length,
        meanR: mean(Rs),
        medR: median(Rs),
        minR: Rs.length ? Math.min(...Rs) : null,
        maxR: Rs.length ? Math.max(...Rs) : null,
        meanMs: mean(Ms),
        meanTok: mean(Ts),
        samples: ok,
      };
      cells.push(cell);
      console.log(
        pad(model, 18) +
          pad(cond.id, 12) +
          pad(ok.length, 4) +
          pad(cell.meanR != null ? Math.round(cell.meanR) : '-', 10) +
          pad(cell.medR != null ? Math.round(cell.medR) : '-', 10) +
          pad(cell.minR ?? '-', 10) +
          pad(cell.maxR ?? '-', 10) +
          pad(cell.meanMs != null ? Math.round(cell.meanMs) : '-', 10) +
          (cell.meanTok != null ? Math.round(cell.meanTok) : '-')
      );
    }
  }

  console.log('\n=== DELTA vs base (mean reasoning) — depth goal: positive ===');
  for (const model of MODELS) {
    const base = cells.find((c) => c.model === model && c.condition === 'base');
    if (!base || !base.n) {
      console.log(`${model}: no base`);
      continue;
    }
    for (const cond of CONDITIONS) {
      if (cond.id === 'base') continue;
      const t = cells.find((c) => c.model === model && c.condition === cond.id);
      if (!t || !t.n) {
        console.log(`${model} / ${cond.id}: missing`);
        continue;
      }
      const d = t.meanR - base.meanR;
      const pct = base.meanR ? ((d / base.meanR) * 100).toFixed(0) : 'n/a';
      const flag =
        d >= 400 || (base.meanR && d / base.meanR >= 0.3)
          ? 'DEEPER'
          : d <= -400 || (base.meanR && d / base.meanR <= -0.3)
            ? 'SHALLOWER'
            : 'flat/noise';
      console.log(
        `${pad(model, 18)} ${pad(cond.id, 12)} ΔmeanR=${Math.round(d)} (${pct}%)  base=${Math.round(base.meanR)} treat=${Math.round(t.meanR)}  => ${flag}`
      );
    }
  }

  // Best deepen candidate per model
  console.log('\n=== BEST DEEPEN (max meanR among conditions with n>=1) ===');
  for (const model of MODELS) {
    const mc = cells.filter((c) => c.model === model && c.n > 0);
    if (!mc.length) continue;
    mc.sort((a, b) => (b.meanR || 0) - (a.meanR || 0));
    const best = mc[0];
    const base = mc.find((c) => c.condition === 'base');
    console.log(
      `${model}: best=${best.condition} meanR=${Math.round(best.meanR)}` +
        (base
          ? ` (base=${Math.round(base.meanR)}, Δ=${Math.round(best.meanR - base.meanR)})`
          : '')
    );
  }

  const outPath = path.join(
    __dirname,
    '..',
    'output',
    `effort-deepen-${Date.now()}.json`
  );
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        ts: new Date().toISOString(),
        task: USER_TASK,
        repeats: REPEATS,
        models: MODELS,
        conditions: CONDITIONS.map((c) => c.id),
        rows,
        cells,
      },
      null,
      2
    )
  );
  console.log(`\nSaved: ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
