// Tests for the document the app actually reads.
//
// Every field here is rendered next to a real price, so a shape change or a
// stray NaN is a user-visible lie rather than a crash.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Candle } from '../src/fetch.ts';
import { HORIZONS_ALL, buildCoin } from '../src/publish.ts';

const HOUR = 3_600_000;
function series(n: number, fn: (i: number) => number): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const close = fn(i);
    return {
      openTime: 1_700_000_000_000 + i * HOUR,
      open: close, high: close * 1.01, low: close * 0.99, close,
      volume: 1000 + (i % 11) * 30,
    };
  });
}

const meta = { sym: 'BTC', name: 'Bitcoin' };
const rising = series(400, (i) => 100 + i * 0.3);
const falling = series(400, (i) => 300 - i * 0.3);
const choppy = series(400, (i) => 200 + Math.sin(i / 7) * 15);

test('drops the still-forming candle', () => {
  // The last row from Binance is the current, incomplete hour. Scoring it
  // would make live results diverge from every backtest.
  const doc = buildCoin(meta, choppy);
  const lastClosed = choppy[choppy.length - 2].close;
  assert.equal(doc.price, Number(lastClosed.toPrecision(8)));
});

test('refuses a series too short to have settled indicators', () => {
  assert.throws(() => buildCoin(meta, series(20, () => 100)), /closed candles/);
});

test('publishes a target for every horizon, all finite', () => {
  const doc = buildCoin(meta, choppy);
  for (const h of HORIZONS_ALL) {
    const t = doc.targets[h];
    assert.ok(t, `missing ${h}`);
    for (const k of ['price', 'pct', 'bandPct'] as const) {
      assert.ok(Number.isFinite(t[k]), `${h}.${k} is ${t[k]}`);
    }
    assert.ok(t.price > 0, `${h} price ${t.price} must be positive`);
  }
});

test('the drift never exceeds its own uncertainty band', () => {
  // If it does, the published interval excludes zero and the model is
  // claiming a guaranteed direction.
  for (const s of [rising, falling, choppy]) {
    const doc = buildCoin(meta, s);
    for (const h of HORIZONS_ALL) {
      const { pct, bandPct } = doc.targets[h];
      assert.ok(
        Math.abs(pct) <= bandPct + 1e-9,
        `${h}: drift ${pct} exceeded band ${bandPct}`,
      );
    }
  }
});

test('conf is null while calibration is disabled', () => {
  // calibration.json ships with enabled:false because the gate fails. A
  // number here would be a confidence claim the backtest does not support.
  assert.equal(buildCoin(meta, choppy).conf, null);
});

test('direction agrees with the sign of the 24H target', () => {
  for (const s of [rising, falling, choppy]) {
    const doc = buildCoin(meta, s);
    if (doc.targets['24H'].pct !== 0) {
      assert.equal(doc.up, doc.targets['24H'].pct > 0, 'up flag contradicts its own target');
    }
  }
});

test('history is real, ordered, and ends on the published price', () => {
  const doc = buildCoin(meta, rising);
  assert.ok(doc.history.length > 1, 'no history published');
  for (const v of doc.history) assert.ok(Number.isFinite(v) && v > 0, `bad point ${v}`);
  assert.equal(
    doc.history[doc.history.length - 1], doc.price,
    'chart must end where the quoted price is',
  );
  // A rising series must produce a rising chart.
  assert.ok(doc.history[doc.history.length - 1] > doc.history[0]);
});

test('reasons are present, distinct, and capped at three', () => {
  const doc = buildCoin(meta, choppy);
  assert.equal(doc.reasons.length, 3);
  assert.equal(new Set(doc.reasons).size, 3);
});
