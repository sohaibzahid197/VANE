// Tests for range cutting.
//
// The failure mode worth guarding is a range that windows to nothing. A coin
// listed four days ago has no 30-day window, and the naive result is an empty
// series that renders as a blank panel where a chart should be — indistinguishable
// from a bug, and it would hit exactly the newly-listed coins users go looking for.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { cutRanges, MAX_AGE_MS } from '../src/history.ts';
import { RANGES } from '../src/providers/types.ts';
import type { Candle } from '../src/providers/types.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** `n` bars ending now, spaced `step` apart. */
function bars(n: number, step: number, startPrice = 100): Candle[] {
  const end = Date.now();
  return Array.from({ length: n }, (_, i) => {
    const price = startPrice + i;
    return {
      openTime: end - (n - 1 - i) * step,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: 1_000_000 + i,
    };
  });
}

test('cuts every range when both resolutions are present', () => {
  const out = cutRanges({
    intraday: bars(90 * 24, HOUR),
    daily: bars(1200, DAY),
  });
  for (const r of RANGES) {
    assert.ok(out[r], `missing range ${r}`);
    assert.ok(out[r]!.c.length > 0, `empty range ${r}`);
  }
});

test('each range respects its point budget', () => {
  const out = cutRanges({ intraday: bars(90 * 24, HOUR), daily: bars(3000, DAY) });
  assert.ok(out['1Y']!.c.length <= 365, '1Y over budget');
  assert.ok(out.ALL!.c.length <= 365, 'ALL over budget');
  assert.ok(out['90D']!.c.length <= 90, '90D over budget');
  assert.ok(out['24H']!.c.length <= 96, '24H over budget');
});

test('short ranges really are shorter than long ones', () => {
  const out = cutRanges({ intraday: bars(90 * 24, HOUR), daily: bars(1200, DAY) });
  const span = (r: keyof typeof out) => {
    const s = out[r]!;
    return s.t[s.t.length - 1]! - s.t[0]!;
  };
  assert.ok(span('24H') < span('7D'), '24H should cover less time than 7D');
  assert.ok(span('7D') < span('30D'), '7D should cover less time than 30D');
  assert.ok(span('1Y') > span('90D'), '1Y should cover more time than 90D');
});

test('a newly-listed coin still gets a chart for every range it cannot fill', () => {
  // Four days of hourly data. There is no 30-day or 90-day window.
  const out = cutRanges({ intraday: bars(4 * 24, HOUR), daily: bars(4, DAY) });
  for (const r of RANGES) {
    assert.ok(out[r], `range ${r} vanished for a young coin`);
    assert.ok(out[r]!.c.length >= 2, `range ${r} is unusably short`);
  }
});

test('a missing daily series does not lose the intraday ranges', () => {
  const out = cutRanges({ intraday: bars(90 * 24, HOUR), daily: [] });
  for (const r of ['1H', '24H', '7D', '30D', '90D'] as const) {
    assert.ok(out[r], `lost intraday range ${r} when daily was empty`);
  }
  assert.equal(out['1Y'], undefined, 'should not invent a 1Y series with no daily data');
  assert.equal(out.ALL, undefined);
});

test('a missing intraday series does not lose the long ranges', () => {
  const out = cutRanges({ intraday: [], daily: bars(1200, DAY) });
  assert.ok(out['1Y'], 'lost 1Y when intraday was empty');
  assert.ok(out.ALL);
});

test('no data at all yields no ranges rather than empty charts', () => {
  assert.deepEqual(cutRanges({ intraday: [], daily: [] }), {});
});

test('every range ends on the newest bar', () => {
  const out = cutRanges({ intraday: bars(90 * 24, HOUR), daily: bars(1200, DAY) });
  for (const r of RANGES) {
    const s = out[r]!;
    const newest = s.c[s.c.length - 1]!;
    assert.ok(newest > 0, `range ${r} has no closing price`);
    // The newest close across every intraday range must agree — they all end
    // at the same moment, so a mismatch means one range dropped its last bar.
    if (RANGES.indexOf(r) <= RANGES.indexOf('90D')) {
      assert.equal(newest, out['24H']!.c[out['24H']!.c.length - 1]!, `range ${r} ends elsewhere`);
    }
  }
});

test('volume survives into every range', () => {
  const out = cutRanges({ intraday: bars(90 * 24, HOUR), daily: bars(1200, DAY) });
  for (const r of RANGES) {
    assert.equal(out[r]!.v.length, out[r]!.c.length, `range ${r} volume/close length mismatch`);
    assert.ok(out[r]!.v.some((v) => v > 0), `range ${r} has no volume at all`);
  }
});

test('the licence refresh floor stays under 24 hours', () => {
  // CoinGecko permits storage only if the cache is refreshed at least every
  // 24 hours. If this constant ever creeps to or past that, stored series can
  // age out of the licence between runs.
  assert.ok(MAX_AGE_MS < 24 * 3_600_000, 'MAX_AGE_MS must leave margin under the 24h licence term');
});
