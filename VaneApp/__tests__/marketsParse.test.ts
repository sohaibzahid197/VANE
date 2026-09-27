// Tests for market/history document parsing.
//
// The series validation is the one that matters. The arrays are parallel and the
// chart indexes them together, so a ragged payload draws candles whose highs
// belong to different bars — no error, no warning, and a chart that looks
// entirely plausible while being wrong. Rejecting outright is the only safe
// behaviour, and this locks it in.

import {
  compact,
  compactUnits,
  toGlobal,
  toHistory,
  toMarket,
  toSeries,
} from '../src/marketsParse.ts';

const series = (n: number) => ({
  t: Array.from({ length: n }, (_, i) => 1000 + i),
  o: Array.from({ length: n }, () => 10),
  h: Array.from({ length: n }, () => 11),
  l: Array.from({ length: n }, () => 9),
  c: Array.from({ length: n }, () => 10.5),
  v: Array.from({ length: n }, () => 500),
});

describe('toSeries', () => {
  it('accepts a well-formed series', () => {
    const s = toSeries(series(10));
    expect(s).not.toBeNull();
    expect(s!.c).toHaveLength(10);
    expect(s!.v).toHaveLength(10);
  });

  it('rejects a series whose closes and timestamps disagree', () => {
    const bad = { ...series(10), c: [1, 2, 3] };
    expect(toSeries(bad)).toBeNull();
  });

  it('rejects a ragged high array rather than misaligning candles', () => {
    const bad = { ...series(10), h: [1, 2, 3] };
    expect(toSeries(bad)).toBeNull();
  });

  it('rejects a ragged low array', () => {
    expect(toSeries({ ...series(10), l: [] })).toBeNull();
  });

  it('rejects a ragged open array', () => {
    expect(toSeries({ ...series(10), o: [1] })).toBeNull();
  });

  it('drops a PARTIAL volume array instead of misaligning volume bars', () => {
    // All-or-nothing: the chart can omit the volume pane, but it must never
    // draw some bars against the wrong candles.
    const s = toSeries({ ...series(10), v: [1, 2, 3] });
    expect(s).not.toBeNull();
    expect(s!.v).toEqual([]);
    expect(s!.c).toHaveLength(10);
  });

  it('filters non-finite numbers, which then shows up as a length mismatch', () => {
    const bad = { ...series(4), c: [1, Number.NaN, 3, 4] };
    expect(toSeries(bad)).toBeNull();
  });

  it('rejects empty and malformed payloads', () => {
    expect(toSeries(null)).toBeNull();
    expect(toSeries({})).toBeNull();
    expect(toSeries({ t: [], c: [] })).toBeNull();
    expect(toSeries('nope')).toBeNull();
  });
});

describe('toMarket', () => {
  it('maps a full row', () => {
    const m = toMarket({
      id: 'bitcoin',
      sym: 'BTC',
      name: 'Bitcoin',
      price: 43000,
      marketCap: 8.4e11,
      rank: 1,
      volume24h: 2e10,
      change24hPct: 1.53,
      maxSupply: 21_000_000,
    });
    expect(m.sym).toBe('BTC');
    expect(m.priceLabel).toBe('$43,000');
    expect(m.changeLabel).toBe('+1.5%');
    expect(m.up).toBe(true);
    expect(m.rank).toBe(1);
  });

  it('treats a missing 24h change as unknown, not as a decline', () => {
    // Defaulting `up` to false would paint every coin with no 24h data red.
    const m = toMarket({ id: 'x', sym: 'X', name: 'X', price: 1 });
    expect(m.change24hPct).toBeNull();
    expect(m.changeLabel).toBe('—');
    expect(m.up).toBe(true);
  });

  it('keeps a missing max supply as null rather than zero', () => {
    // ETH has no max supply. Printing "0" there is simply false.
    const m = toMarket({ id: 'eth', sym: 'ETH', name: 'Ethereum', price: 2, maxSupply: null });
    expect(m.maxSupply).toBeNull();
  });

  it('marks a negative change as down', () => {
    const m = toMarket({ id: 'x', sym: 'X', name: 'X', price: 1, change24hPct: -4.2 });
    expect(m.up).toBe(false);
    expect(m.changeLabel).toBe('-4.2%');
  });

  it('survives a garbage row without throwing', () => {
    const m = toMarket({});
    expect(m.sym).toBe('?');
    expect(m.price).toBe(0);
  });
});

describe('toHistory', () => {
  it('keeps valid ranges and drops invalid ones', () => {
    const h = toHistory(
      {
        sym: 'BTC',
        updatedAt: '2026-09-27T00:00:00Z',
        source: 'coingecko',
        ranges: {
          '24H': series(48),
          // Ragged: must be dropped, not rendered.
          '7D': { ...series(48), h: [1] },
          '1Y': series(365),
        },
      },
      'BTC',
    );
    expect(Object.keys(h.ranges).sort()).toEqual(['1Y', '24H']);
    expect(h.ranges['7D']).toBeUndefined();
    expect(h.source).toBe('coingecko');
  });

  it('falls back to the requested symbol when the document has none', () => {
    expect(toHistory({ ranges: {} }, 'SOL').sym).toBe('SOL');
  });

  it('yields no ranges for an empty document rather than throwing', () => {
    expect(toHistory(null, 'BTC').ranges).toEqual({});
  });
});

describe('toGlobal', () => {
  it('maps totals and keeps missing values null', () => {
    const g = toGlobal({ totalMarketCap: 2.4e12, btcDominance: 54.3 });
    expect(g.totalMarketCap).toBe(2.4e12);
    expect(g.btcDominance).toBe(54.3);
    expect(g.totalVolume24h).toBeNull();
  });
});

describe('compact', () => {
  it('labels each magnitude', () => {
    expect(compact(2.4e12)).toBe('$2.40T');
    expect(compact(8.4e11)).toBe('$840.00B');
    expect(compact(1.23e7)).toBe('$12.30M');
    expect(compact(4500)).toBe('$4.5K');
    expect(compact(12.5)).toBe('$12.50');
  });

  it('shows an em dash rather than $0 for missing data', () => {
    expect(compact(null)).toBe('—');
    expect(compact(Number.NaN)).toBe('—');
  });

  it('keeps the sign outside the currency mark', () => {
    expect(compact(-1.5e9)).toBe('-$1.50B');
  });

  it('formats supply counts without a currency mark', () => {
    expect(compactUnits(19_500_000)).toBe('19.50M');
    expect(compactUnits(null)).toBe('—');
  });
});

describe('toSeries alignment guard', () => {
  it('rejects a hole compensated by an extra element', () => {
    // The loophole: filtering non-finite entries and THEN comparing lengths lets
    // a null in one array and a compensating extra element cancel out. The
    // length check passes and every bar after the hole draws against the next
    // bar's open — the exact silent misalignment this guard exists to prevent.
    const bad = {
      t: [1, 2, 3, 4],
      o: [10, 20, null, 40, 50],
      h: [1, 2, 3, 4],
      l: [1, 2, 3, 4],
      c: [1, 2, 3, 4],
      v: [1, 2, 3, 4],
    };
    expect(toSeries(bad)).toBeNull();
  });

  it('rejects a NaN rather than silently shortening the array', () => {
    expect(
      toSeries({
        t: [1, 2, 3],
        o: [1, Number.NaN, 3],
        h: [1, 2, 3],
        l: [1, 2, 3],
        c: [1, 2, 3],
        v: [1, 2, 3],
      }),
    ).toBeNull();
  });

  it('still accepts a well-formed series', () => {
    const good = { t: [1, 2, 3], o: [1, 2, 3], h: [1, 2, 3], l: [1, 2, 3], c: [1, 2, 3], v: [1, 2, 3] };
    expect(toSeries(good)).not.toBeNull();
  });
});

describe('money formatting across token magnitudes', () => {
  const { money } = require('../src/format.ts');

  it('never collapses a sub-cent price to zero', () => {
    // The whole point: a memecoin must not render as "$0.0000" in the list
    // while the chart crosshair on the same screen shows its real price.
    expect(money(0.00002347)).not.toBe('$0.0000');
    expect(money(0.00002347)).not.toBe('$0.00');
    expect(money(0.0000094)).not.toBe('$0.0000');
    // Three significant figures, so the price is actually readable.
    expect(money(0.00002347)).toBe('$0.0000235');
    expect(money(0.0000094)).toBe('$0.00000940');
  });

  it('keeps conventional formatting above a cent', () => {
    expect(money(84560)).toBe('$84,560');
    expect(money(2692.15)).toBe('$2,692');
    expect(money(214.6)).toBe('$214.60');
    expect(money(0.2843)).toBe('$0.2843');
  });

  it('puts the sign outside the currency mark', () => {
    expect(money(-3)).toBe('-$3.00');
    expect(money(-0.00001)).toMatch(/^-\$/);
  });

  it('renders exact zero plainly', () => {
    expect(money(0)).toBe('$0');
  });

  it('returns an em dash for non-finite input', () => {
    expect(money(Number.NaN)).toBe('—');
    expect(money(Infinity)).toBe('—');
  });
});
