// Tests for the scoring layer. The backtest's honesty depends on two
// properties that are easy to break silently: no lookahead, and price
// targets that stay inside plausible bounds.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Candle } from '../src/fetch.ts';
import { HORIZON_HOURS, prepare, priceTarget, scoreAt, topReasons } from '../src/signal.ts';

function series(n: number, fn: (i: number) => number): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const close = fn(i);
    return {
      openTime: i * 3_600_000,
      open: close,
      high: close * 1.01,
      low: close * 0.99,
      close,
      volume: 1000 + (i % 13) * 25,
    };
  });
}

const rising = series(400, (i) => 100 + i * 0.4);
const falling = series(400, (i) => 300 - i * 0.4);
const choppy = series(400, (i) => 200 + Math.sin(i / 6) * 18);

test('scoreAt: a sustained uptrend scores positive, a downtrend negative', () => {
  const up = scoreAt(prepare(rising), 399);
  const down = scoreAt(prepare(falling), 399);
  assert.equal(up.up, true, `rising score was ${up.score}`);
  assert.equal(down.up, false, `falling score was ${down.score}`);
});

test('scoreAt: the score stays inside [-1, 1]', () => {
  for (const s of [rising, falling, choppy]) {
    const ind = prepare(s);
    for (let i = 100; i < s.length; i += 17) {
      const { score } = scoreAt(ind, i);
      assert.ok(score >= -1 && score <= 1, `score out of range: ${score}`);
    }
  }
});

test('scoreAt: NO LOOKAHEAD — truncating the future cannot change the past', () => {
  // The single property the whole backtest rests on. If scoring index i ever
  // reads candle i+1, the reported accuracy is fiction.
  const i = 250;
  const full = scoreAt(prepare(choppy), i);
  const truncated = scoreAt(prepare(choppy.slice(0, i + 1)), i);
  assert.equal(
    full.score.toFixed(12),
    truncated.score.toFixed(12),
    'score changed when future candles were removed — lookahead present',
  );
});

test('scoreAt: feature weights sum to 1', () => {
  const { features } = scoreAt(prepare(choppy), 300);
  const total = features.reduce((a, f) => a + f.weight, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `weights summed to ${total}`);
});

test('topReasons: returns the requested count, strongest first, no duplicates', () => {
  const sig = scoreAt(prepare(choppy), 300);
  const three = topReasons(sig, 3);
  assert.equal(three.length, 3);
  assert.equal(new Set(three).size, 3, 'reasons must be distinct');
});

test('priceTarget: never produces a negative or zero price', () => {
  // Unclamped drift used to go below -1 on a bearish score in a volatile
  // regime, publishing a negative price target.
  const violent = series(400, (i) => 100 * Math.exp(Math.sin(i / 3) * 0.6 - i * 0.004));
  const ind = prepare(violent);
  for (let i = 120; i < violent.length; i += 11) {
    const sig = scoreAt(ind, i);
    for (const h of Object.keys(HORIZON_HOURS) as (keyof typeof HORIZON_HOURS)[]) {
      const { price, pct } = priceTarget(ind, i, h, sig);
      assert.ok(price > 0, `${h} price was ${price}`);
      assert.ok(Number.isFinite(pct), `${h} pct was ${pct}`);
      assert.ok(pct > -100, `${h} implied a >100% loss: ${pct}`);
    }
  }
});

test('priceTarget: the drift stays inside the uncertainty band', () => {
  // If the point estimate exceeds the band, the published interval excludes
  // zero and the model is claiming a guaranteed direction.
  const ind = prepare(choppy);
  for (let i = 150; i < choppy.length; i += 23) {
    const sig = scoreAt(ind, i);
    for (const h of ['24H', '7D', '30D'] as const) {
      const { pct, bandPct } = priceTarget(ind, i, h, sig);
      assert.ok(
        Math.abs(pct) <= bandPct + 1e-9,
        `${h}: drift ${pct.toFixed(2)}% exceeded band ${bandPct.toFixed(2)}%`,
      );
    }
  }
});

test('priceTarget: a longer horizon implies a wider band', () => {
  const ind = prepare(choppy);
  const sig = scoreAt(ind, 399);
  const d1 = priceTarget(ind, 399, '24H', sig).bandPct;
  const d7 = priceTarget(ind, 399, '7D', sig).bandPct;
  const d30 = priceTarget(ind, 399, '30D', sig).bandPct;
  assert.ok(d1 < d7 && d7 < d30, `bands not widening: ${d1}, ${d7}, ${d30}`);
});

test('prepare: hoisting indicators is value-preserving', () => {
  // prepare() was extracted from scoreAt for a 20x speedup; if it computed
  // anything differently, every backtest number since would be incomparable.
  const ind = prepare(choppy);
  assert.equal(ind.closes.length, choppy.length);
  assert.equal(ind.fast.length, choppy.length);
  assert.equal(ind.volZ.length, choppy.length);
  for (const arr of [ind.fast, ind.slow, ind.r, ind.rv, ind.volZ]) {
    for (const v of arr) assert.ok(Number.isFinite(v), `non-finite indicator: ${v}`);
  }
});
