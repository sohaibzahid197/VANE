// Tests for the indicator maths. These are pure functions and they decide
// every signal the app shows, so they are the highest-value thing to pin.
//
// Run with: npm test   (node --test, no framework dependency)

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ema, realizedVol, rsi, zscore } from '../src/indicators.ts';

const flat = (n: number, v = 100) => Array.from({ length: n }, () => v);
const ramp = (n: number, step = 1) => Array.from({ length: n }, (_, i) => 100 + i * step);

test('ema: a flat series stays at its own level', () => {
  const out = ema(flat(50), 12);
  assert.equal(out.length, 50);
  for (const v of out) assert.ok(Math.abs(v - 100) < 1e-9, `got ${v}`);
});

test('ema: seeds on the first value rather than zero', () => {
  // A zero seed would drag the first dozen readings toward 0 and fabricate a
  // downtrend on every freshly listed coin.
  const out = ema([100, 100, 100], 12);
  assert.equal(out[0], 100);
});

test('ema: a rising series trails the price but tracks upward', () => {
  const closes = ramp(100);
  const out = ema(closes, 12);
  const last = out[out.length - 1];
  assert.ok(last < closes[closes.length - 1], 'EMA must lag a rising price');
  assert.ok(last > out[0], 'EMA must still be rising');
});

test('ema: a shorter period reacts faster than a longer one', () => {
  const closes = ramp(200);
  const fast = ema(closes, 12);
  const slow = ema(closes, 48);
  assert.ok(
    fast[fast.length - 1] > slow[slow.length - 1],
    'fast EMA should sit above slow EMA while price rises',
  );
});

test('rsi: a monotonic rise pins near 100, a fall near 0', () => {
  const up = rsi(ramp(120), 14);
  const down = rsi(ramp(120, -0.5), 14);
  assert.ok(up[up.length - 1] > 95, `rising RSI was ${up[up.length - 1]}`);
  assert.ok(down[down.length - 1] < 5, `falling RSI was ${down[down.length - 1]}`);
});

test('rsi: stays inside 0..100 on noisy input', () => {
  const noisy = Array.from({ length: 300 }, (_, i) => 100 + Math.sin(i) * 12 + (i % 7));
  for (const v of rsi(noisy, 14)) {
    assert.ok(v >= 0 && v <= 100, `RSI out of range: ${v}`);
  }
});

test('realizedVol: a flat series has zero volatility', () => {
  for (const v of realizedVol(flat(80), 24)) {
    assert.ok(Math.abs(v) < 1e-12, `expected ~0, got ${v}`);
  }
});

test('realizedVol: a noisier series reads higher than a calmer one', () => {
  const calm = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i) * 0.5);
  const wild = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i) * 8);
  const c = realizedVol(calm, 24);
  const w = realizedVol(wild, 24);
  assert.ok(w[w.length - 1] > c[c.length - 1]);
});

test('realizedVol: never negative', () => {
  const series = Array.from({ length: 300 }, (_, i) => 100 + Math.sin(i * 1.7) * 9);
  for (const v of realizedVol(series, 24)) assert.ok(v >= 0, `negative vol: ${v}`);
});

test('zscore: a constant series scores zero, not NaN', () => {
  // A zero standard deviation must not divide by zero — that would poison the
  // volume feature for any coin with perfectly flat volume.
  for (const v of zscore(flat(100, 5), 48)) {
    assert.ok(Number.isFinite(v), `non-finite z: ${v}`);
    assert.equal(v, 0);
  }
});

test('zscore: a spike at the end scores strongly positive', () => {
  const vols = flat(100, 10);
  vols[vols.length - 1] = 200;
  const z = zscore(vols, 48);
  assert.ok(z[z.length - 1] > 2, `spike z was ${z[z.length - 1]}`);
});

test('every indicator returns one value per input and no NaN', () => {
  const closes = Array.from({ length: 500 }, (_, i) => 100 + Math.sin(i / 9) * 14);
  for (const [name, out] of [
    ['ema', ema(closes, 12)],
    ['rsi', rsi(closes, 14)],
    ['realizedVol', realizedVol(closes, 24)],
    ['zscore', zscore(closes, 48)],
  ] as const) {
    assert.equal(out.length, closes.length, `${name} length mismatch`);
    for (const v of out) assert.ok(Number.isFinite(v), `${name} produced ${v}`);
  }
});
