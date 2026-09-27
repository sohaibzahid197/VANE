// Parsing the markets and history documents into what the UI renders.
//
// Split out from markets.ts so it carries NO native imports. markets.ts talks to
// Firestore, which means App Check and Firebase, which means a unit test of a
// pure transform cannot even load. This module is where the logic that is worth
// testing lives, and it is reachable from a test without a simulator.

import { compact, compactUnits, money, num, numOr, signed } from './format.ts';

export const RANGES = ['1H', '24H', '7D', '30D', '90D', '1Y', 'ALL'] as const;
export type Range = (typeof RANGES)[number];

export type Market = {
  id: string;
  sym: string;
  name: string;
  image: string | null;
  price: number;
  priceLabel: string;
  marketCap: number | null;
  rank: number | null;
  volume24h: number | null;
  change24hPct: number | null;
  changeLabel: string;
  up: boolean;
  circulating: number | null;
  totalSupply: number | null;
  maxSupply: number | null;
  ath: number | null;
  athDate: string | null;
  athChangePct: number | null;
  atl: number | null;
  atlDate: string | null;
};

export type GlobalMarket = {
  totalMarketCap: number | null;
  totalVolume24h: number | null;
  btcDominance: number | null;
  marketCapChange24hPct: number | null;
};

/** One chart series. Parallel arrays, oldest first. */
export type Series = {
  t: number[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  v: number[];
};

export type History = {
  sym: string;
  updatedAt: string;
  source: string;
  ranges: Partial<Record<Range, Series>>;
};

export function toMarket(c: any): Market {
  const price = numOr(c?.price, 0);
  const change = num(c?.change24hPct);
  return {
    id: String(c?.id ?? ''),
    sym: String(c?.sym ?? '?'),
    name: String(c?.name ?? c?.sym ?? 'Unknown'),
    image: typeof c?.image === 'string' ? c.image : null,
    price,
    priceLabel: money(price),
    marketCap: num(c?.marketCap),
    rank: num(c?.rank),
    volume24h: num(c?.volume24h),
    change24hPct: change,
    changeLabel: change === null ? '—' : signed(change),
    // A missing change is not a decline. Defaulting `up` to false would paint
    // every coin with no 24h data red.
    up: (change ?? 0) >= 0,
    circulating: num(c?.circulating),
    totalSupply: num(c?.totalSupply),
    maxSupply: num(c?.maxSupply),
    ath: num(c?.ath),
    athDate: typeof c?.athDate === 'string' ? c.athDate : null,
    athChangePct: num(c?.athChangePct),
    atl: num(c?.atl),
    atlDate: typeof c?.atlDate === 'string' ? c.atlDate : null,
  };
}

export function toGlobal(g: any): GlobalMarket {
  return {
    totalMarketCap: num(g?.totalMarketCap),
    totalVolume24h: num(g?.totalVolume24h),
    btcDominance: num(g?.btcDominance),
    marketCapChange24hPct: num(g?.marketCapChange24hPct),
  };
}

/**
 * Validate a series before it reaches a chart.
 *
 * The arrays are parallel and the chart indexes them together, so a length
 * mismatch draws a candle whose high belongs to a different bar — silently, with
 * no error, and looking entirely plausible. Anything ragged is rejected
 * outright: a missing chart is recoverable, a wrong one is not.
 */
export function toSeries(s: any): Series | null {
  const pick = (k: string): number[] =>
    Array.isArray(s?.[k])
      ? s[k].filter((n: unknown): n is number => typeof n === 'number' && Number.isFinite(n))
      : [];

  const t = pick('t');
  const c = pick('c');
  if (t.length === 0 || c.length !== t.length) return null;

  const o = pick('o');
  const h = pick('h');
  const l = pick('l');
  const v = pick('v');
  if (o.length !== t.length || h.length !== t.length || l.length !== t.length) return null;

  // Volume may be absent — the chart can drop the volume pane — but a PARTIAL
  // volume array would misalign the bars it does draw, so it is all or nothing.
  return { t, o, h, l, c, v: v.length === t.length ? v : [] };
}

export function toHistory(raw: any, fallbackSym: string): History {
  const ranges: Partial<Record<Range, Series>> = {};
  const rawRanges = raw?.ranges ?? {};
  for (const r of RANGES) {
    const s = rawRanges[r];
    if (!s) continue;
    const series = toSeries(s);
    if (series) ranges[r] = series;
  }
  return {
    sym: typeof raw?.sym === 'string' ? raw.sym : fallbackSym,
    updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : '',
    source: typeof raw?.source === 'string' ? raw.source : '',
    ranges,
  };
}

export { compact, compactUnits };
