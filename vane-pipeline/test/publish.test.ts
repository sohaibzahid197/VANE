// Tests for the document the app actually reads.
//
// Every field here is rendered next to a real price, so a shape change or a
// stray NaN is a user-visible lie rather than a crash.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Candle } from '../src/providers/types.ts';
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

test('an all-aligned series keeps its newest bar', () => {
  // This asserted the Binance rule — price = second-to-last close, because the
  // last row was the forming hour. CoinGecko has no forming row: its samples
  // are hour-aligned and a live snapshot, when present, is NOT aligned. A
  // fixture where every bar is aligned therefore has no snapshot to drop, and
  // discarding the newest bar would throw away an hour of real data.
  const doc = buildCoin(meta, choppy);
  assert.equal(doc.price, Number(choppy[choppy.length - 1].close.toPrecision(8)));
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

// --- live snapshot vs closed bars -------------------------------------------
//
// CoinGecko's hourly series is hour-aligned and then APPENDS a live snapshot at
// the moment of the request — observed live: a 16:46:20 sample beside a 16:00
// bar. The old `slice(0, -1)`, written for Binance's forming candle, discarded
// it and published a price up to an hour stale. That price becomes entryPrice
// for VANE's own scorecard and for every user prediction, while the exit is live
// spot — so it was a one-sided extension of every measurement window.

test('the live snapshot sets the published price, not the last closed bar', () => {
  const HOUR = 3_600_000;
  const base = Math.floor(Date.now() / HOUR) * HOUR - 200 * HOUR;
  const candles = Array.from({ length: 200 }, (_, i) => ({
    openTime: base + i * HOUR,
    open: 100, high: 100, low: 100, close: 100, volume: 1000,
  }));
  // The live snapshot: NOT hour-aligned, and at a different price.
  candles.push({
    openTime: base + 199 * HOUR + 46 * 60_000,
    open: 137, high: 137, low: 137, close: 137, volume: 1000,
  });

  const coin = buildCoin({ sym: 'TEST', name: 'Test' }, candles);
  assert.equal(coin.price, 137, 'published price must be the freshest sample');
  assert.equal(
    coin.history[coin.history.length - 1],
    137,
    'the sparkline must meet the price shown beside it',
  );
});

test('an hour-aligned final bar is treated as closed and still scored', () => {
  const HOUR = 3_600_000;
  const base = Math.floor(Date.now() / HOUR) * HOUR - 200 * HOUR;
  const candles = Array.from({ length: 200 }, (_, i) => ({
    openTime: base + i * HOUR,
    open: 100 + i, high: 100 + i, low: 100 + i, close: 100 + i, volume: 1000,
  }));
  const coin = buildCoin({ sym: 'TEST', name: 'Test' }, candles);
  // No live snapshot present, so the newest closed bar is the price.
  assert.equal(coin.price, 299);
});

test('the live snapshot does not enter the indicator window', () => {
  // An absurd spike in the live snapshot must not move the model's score, or
  // live and backtest stop agreeing — the backtest only ever sees closed bars.
  const HOUR = 3_600_000;
  const base = Math.floor(Date.now() / HOUR) * HOUR - 200 * HOUR;
  const mk = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      openTime: base + i * HOUR,
      open: 100, high: 100, low: 100, close: 100, volume: 1000,
    }));

  const calm = buildCoin({ sym: 'A', name: 'A' }, [
    ...mk(200),
    { openTime: base + 199 * HOUR + 46 * 60_000, open: 101, high: 101, low: 101, close: 101, volume: 1000 },
  ]);
  const spiked = buildCoin({ sym: 'A', name: 'A' }, [
    ...mk(200),
    { openTime: base + 199 * HOUR + 46 * 60_000, open: 9999, high: 9999, low: 9999, close: 9999, volume: 9e9 },
  ]);

  assert.equal(calm.up, spiked.up, 'the live snapshot must not change the signal');
  assert.deepEqual(calm.reasons, spiked.reasons, 'nor the reasoning');
  assert.notEqual(calm.price, spiked.price, 'but it must change the published price');
});
