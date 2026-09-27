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
  // Four days of hourly data. There is no 30-day or 90-day window, but every
  // range must still render something rather than a blank panel.
  const out = cutRanges({ intraday: bars(4 * 24, HOUR), daily: bars(4, DAY) });
  for (const r of RANGES) {
    // 1Y is the one honest exception: for a four-day-old coin it would be a
    // false label, and ALL says the same thing truthfully.
    if (r === '1Y') continue;
    assert.ok(out[r], `range ${r} vanished for a young coin`);
    assert.ok(out[r]!.c.length >= 2, `range ${r} is unusably short`);
  }
  assert.ok(out.ALL, 'ALL is the truthful label for a young coin and must survive');
  assert.equal(out['1Y'], undefined, '1Y overstates a four-day-old coin');
});

test('a missing daily series does not lose the intraday ranges', () => {
  const out = cutRanges({ intraday: bars(90 * 24, HOUR), daily: [] });
  for (const r of ['24H', '7D', '30D', '90D'] as const) {
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

test('a PLAN-capped year drops ALL and keeps 1Y', () => {
  // CoinGecko's Demo tier stops at 365 days, so a decade-old coin still returns
  // exactly a year. "1Y" is true here; "ALL" would be a false claim.
  const out = cutRanges({ intraday: bars(90 * 24, HOUR), daily: bars(365, DAY) });
  assert.ok(out['1Y'], '1Y should survive a plan cap');
  assert.equal(out.ALL, undefined, 'ALL must not duplicate a plan-capped year');
});

test('ALL survives when there is genuinely more history than a year', () => {
  const out = cutRanges({ intraday: bars(90 * 24, HOUR), daily: bars(1500, DAY) });
  assert.ok(out.ALL, 'ALL should exist when history exceeds a year');
  const span = (s: { t: number[] }) => s.t[s.t.length - 1]! - s.t[0]!;
  assert.ok(span(out.ALL!) > span(out['1Y']!) * 1.05, 'ALL should cover more than 1Y');
});

// --- write batching --------------------------------------------------------
//
// The first real run of the history rebuild died with DEADLINE_EXCEEDED after
// 60s and published NOTHING, having already spent 100 provider credits fetching
// the data. The cause was batching by document count: 400 is far inside
// Firestore's 500-write limit, but 50 history documents at ~65KB each is a
// ~3.2MB single commit. These tests pin the two properties that prevent it.

test('a large set is split into several batches rather than one giant commit', async () => {
  const { publishHistory } = await import('../src/history.ts');

  const commits: string[][] = [];
  const fakeDb = {
    doc: (path: string) => ({ path }),
    batch: () => {
      const written: string[] = [];
      return {
        set: (ref: { path: string }) => written.push(ref.path),
        commit: async () => {
          commits.push(written);
        },
      };
    },
  } as never;

  // 50 coins, each carrying six ranges of realistic length.
  const docs = Array.from({ length: 50 }, (_, i) => ({
    sym: `C${i}`,
    name: `Coin ${i}`,
    updatedAt: new Date().toISOString(),
    source: 'coingecko',
    resolution: 'resampled-from-close' as const,
    ranges: {
      '24H': seriesOf(96),
      '7D': seriesOf(168),
      '30D': seriesOf(180),
      '90D': seriesOf(90),
      '1Y': seriesOf(365),
    },
  }));

  const out = await publishHistory(fakeDb, docs);

  assert.ok(commits.length > 1, `expected several batches, got ${commits.length}`);
  assert.equal(out.free + out.paid, 50, 'every document should have been written');
  assert.equal(out.failed, 0);
  for (const c of commits) {
    assert.ok(c.length < 50, `a batch held ${c.length} documents — too many for their size`);
  }
});

test('one failing batch does not discard the batches that succeeded', async () => {
  const { publishHistory } = await import('../src/history.ts');

  let n = 0;
  const fakeDb = {
    doc: (path: string) => ({ path }),
    batch: () => {
      n += 1;
      const mine = n;
      return {
        set: () => {},
        commit: async () => {
          // Fail only the second commit, as a deadline would.
          if (mine === 2) throw new Error('DEADLINE_EXCEEDED: Deadline exceeded after 60.002s');
        },
      };
    },
  } as never;

  const docs = Array.from({ length: 50 }, (_, i) => ({
    sym: `C${i}`,
    name: `Coin ${i}`,
    updatedAt: new Date().toISOString(),
    source: 'coingecko',
    resolution: 'resampled-from-close' as const,
    ranges: { '1Y': seriesOf(365), '30D': seriesOf(180) },
  }));

  const out = await publishHistory(fakeDb, docs);

  assert.ok(out.failed > 0, 'the failed batch should be counted');
  assert.ok(out.free + out.paid > 0, 'successful batches must still be reported as written');
  assert.equal(out.free + out.paid + out.failed, 50, 'every document accounted for');
});

function seriesOf(n: number) {
  const a = Array.from({ length: n }, (_, i) => i);
  return { t: a, o: a, h: a, l: a, c: a, v: a };
}

// --- the paywall split ------------------------------------------------------
//
// This is the single most security-critical line in the backend, and until now
// nothing tested it: every fixture above uses symbols C0..C49, all of which are
// paid, so the suite would pass unchanged if the free/paid ternary were
// inverted and the entire dataset published world-readable.

test('a paid coin is written ONLY to private/', async () => {
  const { publishHistory } = await import('../src/history.ts');
  const written: string[] = [];
  const db = fakeDb(written);

  await publishHistory(db, [histDoc('XRP')]);

  assert.deepEqual(written, ['private/hist_XRP']);
  assert.ok(
    !written.some((p) => p.startsWith('public/')),
    'a paid coin must never reach a world-readable document',
  );
});

test('a free coin is written to BOTH sides', async () => {
  // private/ is the complete dataset; public/ is the shop window cut from it.
  // Publishing a free coin only to public/ left private/hist_BTC missing, and
  // every PAYING user got a 404 and no chart on the three most-opened coins.
  const { publishHistory } = await import('../src/history.ts');
  const written: string[] = [];
  const db = fakeDb(written);

  await publishHistory(db, [histDoc('BTC')]);

  assert.ok(written.includes('private/hist_BTC'), 'paying users read private/');
  assert.ok(written.includes('public/hist_BTC'), 'free users read public/');
  assert.equal(written.length, 2);
});

test('the free list is the one in publish.ts, not a second copy', async () => {
  const { publishHistory } = await import('../src/history.ts');
  const { FREE_SYMBOLS } = await import('../src/publish.ts');
  const written: string[] = [];
  const db = fakeDb(written);

  await publishHistory(db, [...FREE_SYMBOLS, 'XRP', 'DOGE'].map(histDoc));

  for (const sym of FREE_SYMBOLS) {
    assert.ok(written.includes(`public/hist_${sym}`), `${sym} should be free`);
  }
  for (const sym of ['XRP', 'DOGE']) {
    assert.ok(!written.includes(`public/hist_${sym}`), `${sym} must NOT be free`);
    assert.ok(written.includes(`private/hist_${sym}`));
  }
});

function fakeDb(written: string[]) {
  return {
    doc: (path: string) => ({ path }),
    batch: () => ({
      set: (ref: { path: string }) => written.push(ref.path),
      commit: async () => {},
    }),
  } as never;
}

function histDoc(sym: string) {
  const a = Array.from({ length: 10 }, (_, i) => i);
  return {
    sym,
    name: sym,
    updatedAt: new Date().toISOString(),
    source: 'coingecko',
    resolution: 'resampled-from-close' as const,
    ranges: { '24H': { t: a, o: a, h: a, l: a, c: a, v: a } },
  };
}
