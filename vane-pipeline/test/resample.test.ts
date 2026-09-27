// Tests for series aggregation.
//
// The two bugs worth guarding here are both silent. Summing a rolling-24h
// volume instead of taking the bucket's last sample produces volume bars that
// are wrong by roughly the bucket width while still looking like a plausible
// chart. And losing the high/low across a bucket turns a candlestick chart into
// a line chart with decorative wicks.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { resample } from '../src/providers/resample.ts';
import type { Candle } from '../src/providers/types.ts';

const HOUR = 3_600_000;
const base = 1_700_000_000_000;

const candle = (i: number, close: number, opts: Partial<Candle> = {}): Candle => ({
  openTime: base + i * HOUR,
  open: close,
  high: close,
  low: close,
  close,
  volume: 1000,
  ...opts,
});

test('empty input yields an empty series rather than throwing', () => {
  const s = resample([], 60);
  assert.deepEqual(s, { t: [], o: [], h: [], l: [], c: [], v: [] });
});

test('never upsamples — a short series passes through unchanged', () => {
  const input = [candle(0, 100), candle(1, 101), candle(2, 102)];
  const s = resample(input, 60);
  assert.equal(s.c.length, 3, 'should not invent bars to fill the budget');
  assert.deepEqual(s.c, [100, 101, 102]);
});

test('aggregates down to the point budget', () => {
  const input = Array.from({ length: 1000 }, (_, i) => candle(i, 100 + i));
  const s = resample(input, 90);
  assert.equal(s.c.length, 90);
  assert.equal(s.t.length, 90);
  assert.equal(s.o.length, 90);
});

test('open is the first close and close is the last close in each bucket', () => {
  const input = Array.from({ length: 10 }, (_, i) => candle(i, 100 + i));
  const s = resample(input, 5); // buckets of 2
  assert.equal(s.o[0], 100, 'first bucket opens at the first bar');
  assert.equal(s.c[0], 101, 'first bucket closes at its last bar');
  assert.equal(s.o[4], 108);
  assert.equal(s.c[4], 109, 'last bucket must close on the newest bar');
});

test('high and low span the whole bucket, not just its edges', () => {
  // A spike in the MIDDLE of a bucket: edges are 100, interior reaches 150/50.
  const input = [
    candle(0, 100),
    candle(1, 150, { high: 150, low: 150 }),
    candle(2, 50, { high: 50, low: 50 }),
    candle(3, 100),
  ];
  const s = resample(input, 1);
  assert.equal(s.h[0], 150, 'interior high was lost');
  assert.equal(s.l[0], 50, 'interior low was lost');
  assert.equal(s.o[0], 100);
  assert.equal(s.c[0], 100);
});

test('volume takes the bucket LAST value, never the sum', () => {
  // Rolling 24h volume: consecutive samples overlap, so summing is meaningless.
  const input = [
    candle(0, 100, { volume: 1_000_000 }),
    candle(1, 101, { volume: 1_010_000 }),
    candle(2, 102, { volume: 1_020_000 }),
    candle(3, 103, { volume: 1_030_000 }),
  ];
  const s = resample(input, 2); // buckets of 2
  assert.equal(s.v[0], 1_010_000, 'first bucket should carry its last sample');
  assert.equal(s.v[1], 1_030_000, 'second bucket should carry its last sample');
  const summed = 1_000_000 + 1_010_000;
  assert.notEqual(s.v[0], summed, 'volume must not be summed across a bucket');
});

test('timestamps stay ascending and start each bucket', () => {
  const input = Array.from({ length: 100 }, (_, i) => candle(i, 100 + i));
  const s = resample(input, 10);
  for (let i = 1; i < s.t.length; i++) {
    assert.ok(s.t[i]! > s.t[i - 1]!, `not ascending at ${i}`);
  }
  assert.equal(s.t[0], base, 'first bucket should start at the first bar');
});

test('the newest bar always survives aggregation', () => {
  // If the last bar is dropped, the chart stops short of the current price —
  // which reads as the coin having gone quiet.
  for (const points of [7, 13, 60, 97]) {
    const input = Array.from({ length: 500 }, (_, i) => candle(i, 100 + i));
    const s = resample(input, points);
    assert.equal(s.c[s.c.length - 1], 599, `lost the newest close at points=${points}`);
  }
});

test('rounds to eight significant figures to keep documents small', () => {
  const input = Array.from({ length: 4 }, (_, i) => candle(i, 1 / 3));
  const s = resample(input, 2);
  assert.equal(s.c[0], 0.33333333);
});
