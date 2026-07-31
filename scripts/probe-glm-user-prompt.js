#!/usr/bin/env node
/**
 * Controlled A/B: does Reasoning Effort system prefix change glm-5.2 depth?
 * - Pins model + config_name = glm-5.2
 * - Injects prefix INTO messages (server THINK_EFFORT_INJECTION should be off
 *   so we don't double-inject; fallback should be off)
 * - Same user prompt as OpenCode experiment
 * - Metric: reasoning_content chars + wall ms (n>=5)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const API = process.env.PROBE_API || 'http://localhost:19900/v1/chat/completions';
const KEY = process.env.API_KEY || 'trae-solo-local-api-key';
const REPEATS = Math.max(5, parseInt(process.env.PROBE_REPEATS || '5', 10));
const MODEL = process.env.PROBE_MODEL || 'glm-5.2';

// Exact user prompt from OpenCode experiment
const USER_TASK =
  'There is a bug in the following problem: A sorted array nums has been rotated at some unknown pivot. ' +
  'Write a function findMin(nums) that uses binary search to find the minimum element in O(log n) time. ' +
  'Then, prove why the branch condition nums[mid] > nums[right] correctly determines which side to search. ' +
  'Provide the code and a short proof in English.';

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
};

// Only depth-relevant arms for GLM
const CONDITIONS = [
  { id: 'base', prefixKey: 'none' },
  { id: 'max_short', prefixKey: 'max_short' },
  { id: 'max_abs', prefixKey: 'max_abs' },
];

function buildMessages(prefix) {
  return [
    {
      role: 'system',
      content: (prefix || '') + 'You are a careful coding assistant. Prefer correct algorithms.',
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

function std(nums) {
  if (nums.length < 2) return null;
  const m = mean(nums);
  const v = nums.reduce((s, n) => s + (n - m) ** 2, 0) / (nums.length - 1);
  return Math.sqrt(v);
}

function pad(s, n) {
  s = String(s ?? '');
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

async function oneCall(condition, rep) {
  const prefix = PREFIX[condition.prefixKey];
  const t0 = Date.now();
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      config_name: MODEL,
      // Force no server-side think_effort double inject
      think_effort: 'off',
      stream: false,
      messages: buildMessages(prefix),
      max_tokens: 4096,
    }),
  });
  const text = await res.text();
  const ms = Date.now() - t0;
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return {
      condition: condition.id,
      rep,
      ok: false,
      ms,
      error: text.slice(0, 240),
    };
  }
  if (!res.ok) {
    return {
      condition: condition.id,
      rep,
      ok: false,
      ms,
      status: res.status,
      error: JSON.stringify(json).slice(0, 240),
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
    condition: condition.id,
    rep,
    ok: !empty,
    ms,
    returnedModel: json.model || MODEL,
    reasoningChars: reasoning.length,
    contentChars: content.length,
    completionTokens: usage.completion_tokens ?? usage.output_tokens ?? null,
    promptTokens: usage.prompt_tokens ?? usage.input_tokens ?? null,
    finishReason: json.choices?.[0]?.finish_reason || null,
    reasoningHead: reasoning.replace(/\s+/g, ' ').slice(0, 120),
    error: empty ? 'empty response' : undefined,
  };
}

async function oneCallWithRetry(condition, rep) {
  let r = await oneCall(condition, rep);
  if (!r.ok) {
    await sleep(2000);
    r = await oneCall(condition, rep);
    r.retried = true;
  }
  return r;
}

async function main() {
  console.log(`API=${API}`);
  console.log(`MODEL=${MODEL} REPEATS=${REPEATS}`);
  console.log(`Conditions: ${CONDITIONS.map((c) => c.id).join(', ')}`);
  console.log(
    `Cells: ${CONDITIONS.length} × ${REPEATS} = ${CONDITIONS.length * REPEATS} calls\n`
  );

  // health
  try {
    const h = await fetch(API.replace('/chat/completions', '/status'), {
      headers: { Authorization: `Bearer ${KEY}` },
    });
    if (!h.ok) throw new Error(`status ${h.status}`);
    const st = await h.json();
    console.log(
      `status ok; auto_continue=${st.auto_continue} max_continues=${st.max_continues}`
    );
  } catch (e) {
    console.error('Health FAIL:', e.message);
    process.exit(1);
  }

  // fallback check
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
        console.warn('WARN: autoFallback still ON — results may swap models.\n');
      } else {
        console.log('fallback OFF — good\n');
      }
    }
  } catch {
    /* ignore */
  }

  const rows = [];
  // Interleave conditions per rep to reduce temporal confounds
  for (let rep = 1; rep <= REPEATS; rep++) {
    for (const cond of CONDITIONS) {
      process.stdout.write(`>> ${MODEL} / ${cond.id} #${rep} ... `);
      try {
        const r = await oneCallWithRetry(cond, rep);
        rows.push(r);
        if (r.ok) {
          console.log(
            `ok ret=${r.returnedModel} R=${r.reasoningChars} C=${r.contentChars} ${r.ms}ms` +
              (r.completionTokens != null ? ` out=${r.completionTokens}` : '') +
              (r.retried ? ' (retry)' : '')
          );
        } else {
          console.log(`FAIL ${r.error || r.status}`);
        }
      } catch (e) {
        console.log(`ERR ${e.message}`);
        rows.push({
          condition: cond.id,
          rep,
          ok: false,
          error: e.message,
        });
      }
      await sleep(1000);
    }
  }

  console.log('\n=== PER-CELL (reasoning chars / ms) ===');
  console.log(
    pad('cond', 12) +
      pad('n', 4) +
      pad('meanR', 10) +
      pad('medR', 10) +
      pad('stdR', 10) +
      pad('minR', 10) +
      pad('maxR', 10) +
      pad('meanMs', 10) +
      pad('medMs', 10) +
      'meanOutTok'
  );

  const cells = [];
  for (const cond of CONDITIONS) {
    const ok = rows.filter((r) => r.ok && r.condition === cond.id);
    const Rs = ok.map((r) => r.reasoningChars);
    const Ms = ok.map((r) => r.ms);
    const Ts = ok.map((r) => r.completionTokens).filter((x) => x != null);
    const cell = {
      condition: cond.id,
      n: ok.length,
      meanR: mean(Rs),
      medR: median(Rs),
      stdR: std(Rs),
      minR: Rs.length ? Math.min(...Rs) : null,
      maxR: Rs.length ? Math.max(...Rs) : null,
      meanMs: mean(Ms),
      medMs: median(Ms),
      meanTok: mean(Ts),
      samples: ok,
    };
    cells.push(cell);
    console.log(
      pad(cond.id, 12) +
        pad(ok.length, 4) +
        pad(cell.meanR != null ? Math.round(cell.meanR) : '-', 10) +
        pad(cell.medR != null ? Math.round(cell.medR) : '-', 10) +
        pad(cell.stdR != null ? Math.round(cell.stdR) : '-', 10) +
        pad(cell.minR ?? '-', 10) +
        pad(cell.maxR ?? '-', 10) +
        pad(cell.meanMs != null ? Math.round(cell.meanMs) : '-', 10) +
        pad(cell.medMs != null ? Math.round(cell.medMs) : '-', 10) +
        (cell.meanTok != null ? Math.round(cell.meanTok) : '-')
    );
  }

  console.log('\n=== DELTA vs base (mean reasoning) ===');
  const base = cells.find((c) => c.condition === 'base');
  if (base && base.n) {
    for (const cond of CONDITIONS) {
      if (cond.id === 'base') continue;
      const t = cells.find((c) => c.condition === cond.id);
      if (!t || !t.n) {
        console.log(`${cond.id}: missing`);
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
        `${pad(cond.id, 12)} ΔmeanR=${Math.round(d)} (${pct}%)  base=${Math.round(base.meanR)} treat=${Math.round(t.meanR)}  => ${flag}`
      );
      // latency delta
      if (base.meanMs && t.meanMs) {
        const dMs = t.meanMs - base.meanMs;
        console.log(
          `${pad('', 12)} ΔmeanMs=${Math.round(dMs)} (${((dMs / base.meanMs) * 100).toFixed(0)}%)  baseMs=${Math.round(base.meanMs)} treatMs=${Math.round(t.meanMs)}`
        );
      }
    }
  } else {
    console.log('no base cell');
  }

  // model swap check
  const models = [...new Set(rows.filter((r) => r.ok).map((r) => r.returnedModel))];
  console.log('\nreturned models:', models.join(', ') || '(none)');
  if (models.length > 1 || (models[0] && models[0] !== MODEL)) {
    console.warn('WARN: model swap detected — A/B contaminated');
  }

  const outPath = path.join(
    __dirname,
    '..',
    'output',
    `effort-glm-user-${Date.now()}.json`
  );
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        ts: new Date().toISOString(),
        model: MODEL,
        repeats: REPEATS,
        userTask: USER_TASK,
        rows,
        cells,
      },
      null,
      2
    )
  );
  console.log(`\nwrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
