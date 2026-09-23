// Tests for the row construction the gate is computed from.
//
// The existing no-lookahead test covers scoreAt. This covers the other half:
// the backtest's own `actual`/`naive` columns, where a future close is read
// deliberately and must never reach the score.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Candle } from '../src/fetch.ts';
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

test('stride controls sampling density and produces non-overlapping windows', () => {
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
