// Tests for the row construction the gate is computed from.
//
// The existing no-lookahead test covers scoreAt. This covers the other half:
// the backtest's own `actual`/`naive` columns, where a future close is read
// deliberately and must never reach the score.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Candle } from '../src/providers/types.ts';
import { buildRows } from '../src/backtest.ts';

const HOUR = 3_600_000;
const series = (n: number, fn: (i: number) => number): Candle[] =>
  Array.from({ length: n }, (_, i) => {
    const close = fn(i);
    return {
      openTime: 1_700_000_000_000 + i * HOUR,
      open: close, high: close * 1.01, low: close * 0.99, close,
      volume: 1000 + (i % 9) * 40,
    };
  });

const rising = series(1200, (i) => 100 + i * 0.05);
const choppy = series(1200, (i) => 200 + Math.sin(i / 11) * 18);

test('actual reflects the real future move', () => {
  // On a monotonic rise every forward window is up, by construction.
  const rows = buildRows(rising, 24, 24);
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.actual === true), 'a rising series must resolve up');
});

test('naive is the 24h-persistence baseline, not the outcome', () => {
  const rows = buildRows(rising, 24, 24);
  assert.ok(rows.every((r) => r.naive === true));
  // The baseline must be a PREDICTION, not a copy of `actual` — if they were
  // the same column the baseline would score 100% and the gate would be void.
  const c = series(1200, (i) => 200 + Math.sin(i / 5) * 20);
  const mixed = buildRows(c, 24, 24);
  assert.ok(
    mixed.some((r) => r.naive !== r.actual),
    'naive and actual must be able to disagree',
  );
});

test('NO LOOKAHEAD — appending future candles cannot change earlier rows', () => {
  // The single property the whole gate rests on. If row i's score moves when
  // later candles are appended, the reported accuracy is fiction.
  const short = buildRows(choppy.slice(0, 900), 24, 24);
  const long = buildRows(choppy, 24, 24);
  assert.ok(short.length > 5, 'need rows to compare');
  for (let i = 0; i < short.length; i++) {
    assert.equal(
      short[i].score.toFixed(12), long[i].score.toFixed(12),
      `score at row ${i} changed when future candles were added`,
    );
    assert.equal(short[i].model, long[i].model, `model call at row ${i} changed`);
  }
});

test('never resolves against the still-forming final candle', () => {
  const rows = buildRows(choppy, 24, 24);
  // The last scored index must leave room for `ahead` PLUS the dropped bar.
  const maxScored = (rows.length - 1) * 24 + 720;
  assert.ok(maxScored + 24 <= choppy.length - 2, 'resolved against the open candle');
});

test('a longer horizon yields fewer rows', () => {
  const d1 = buildRows(choppy, 24, 24).length;
  const d30 = buildRows(choppy, 720, 24).length;
  assert.ok(d30 < d1, `expected fewer 30D rows, got ${d30} vs ${d1}`);
});

test('stride controls sampling density', () => {
  const dense = buildRows(choppy, 24, 6).length;
  const sparse = buildRows(choppy, 24, 24).length;
  assert.ok(dense > sparse, 'smaller stride must yield more rows');
  // At stride === horizon the windows do not overlap, which is what makes the
  // significance calculation honest.
  assert.ok(sparse > 0);
});

test('every row is well formed', () => {
  for (const r of buildRows(choppy, 24, 24)) {
    assert.equal(typeof r.model, 'boolean');
    assert.equal(typeof r.naive, 'boolean');
    assert.equal(typeof r.actual, 'boolean');
    assert.ok(Number.isFinite(r.score) && r.score >= -1 && r.score <= 1, `score ${r.score}`);
  }
});

test('every configured stride is at least its horizon', async () => {
  // The property the old test was NAMED for but never checked. A stride shorter
  // than the horizon overlaps evaluation windows, inflating n and understating
  // the standard error — while the run prints "non-overlapping windows" and can
  // print "GATE: PASS" off the inflated measurement.
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../src/backtest.ts', import.meta.url), 'utf8'),
  );
  const { HORIZON_HOURS } = await import('../src/signal.ts');

  const m = src.match(/STRIDE_BY_HORIZON: Record<Horizon, number> = \{([^}]*)\}/);
  assert.ok(m, 'could not find STRIDE_BY_HORIZON');
  const strides = Object.fromEntries(
    m![1]!.split(',').map((p) => {
      const [k, v] = p.split(':').map((x) => x.trim().replace(/'/g, ''));
      return [k, Number(v)];
    }).filter(([k]) => k),
  ) as Record<string, number>;

  for (const [h, ahead] of Object.entries(HORIZON_HOURS)) {
    assert.ok(
      strides[h]! >= ahead,
      `${h}: stride ${strides[h]} < horizon ${ahead} — windows overlap by ` +
        `${(100 * (1 - strides[h]! / ahead)).toFixed(0)}%`,
    );
  }
});

test('buildRows produces non-overlapping windows at the configured stride', () => {
  const candles = Array.from({ length: 3000 }, (_, i) => ({
    openTime: i * 3_600_000,
    open: 100, high: 101, low: 99, close: 100 + Math.sin(i / 9) * 5, volume: 1000,
  }));
  const ahead = 720;
  const rows = buildRows(candles, ahead, 720);
  // Windows start at WARMUP and step by 720, so none can share an hour.
  assert.ok(rows.length > 1, 'need several rows to test spacing');
  assert.ok(rows.length < 3000 / ahead + 2, `too many rows for stride ${ahead}`);
});
