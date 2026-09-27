// Chart history: seven ranges per coin, from two provider calls.
//
// This is the feature the product is actually being rebuilt around. Today the
// app ships a 24-point, 48-hour sparkline; both incumbents' most persistent
// user complaint across three years is charts without volume and without
// flexible ranges. So this is the wedge, and it is also the largest piece of
// backend work in the plan.
//
// TWO COST DECISIONS ARE BAKED IN HERE, and they are the difference between
// this fitting in the free tiers and not.
//
// 1. TWO PROVIDER CALLS PER COIN, NOT SEVEN. One 90-day hourly series covers
//    1H/24H/7D/30D/90D by resampling; one all-time daily series covers 1Y/ALL.
//    Requesting each range separately would cost 1,750 credits per rebuild of
//    250 coins instead of 500.
//
// 2. ONE FIRESTORE DOCUMENT PER COIN, HOLDING ALL SEVEN RANGES — not one per
//    coin-range. Firestore bills per document read, so this makes opening a
//    coin exactly one read and makes switching ranges free and instant rather
//    than a new read each tap. It also cuts the write cost of a rebuild from
//    1,750 to 250, which matters against a 20,000/day write ceiling the
//    existing pipeline already uses about 11,000 of.
//
// A packed seven-range document runs roughly 60-70KB, comfortably inside
// Firestore's 1MB per-document limit.

import { resample } from './providers/resample.ts';
import { RANGE_POINTS, RANGES } from './providers/types.ts';
import type { Candle, Interval, MarketProvider, Range, Series } from './providers/types.ts';
import { FREE_SYMBOLS } from './publish.ts';

type Firestore = import('firebase-admin/firestore').Firestore;

const isFree = (sym: string) => (FREE_SYMBOLS as readonly string[]).includes(sym);

/**
 * Which of the two fetches each range is cut from, and how far back it reaches.
 *
 * `hours: null` means "everything the fetch returned" — 1Y is bounded by the
 * request itself and ALL is unbounded by definition.
 */
const RANGE_PLAN: Record<Range, { from: 'intraday' | 'daily'; hours: number | null }> = {
  '1H': { from: 'intraday', hours: 1 },
  '24H': { from: 'intraday', hours: 24 },
  '7D': { from: 'intraday', hours: 24 * 7 },
  '30D': { from: 'intraday', hours: 24 * 30 },
  '90D': { from: 'intraday', hours: 24 * 90 },
  '1Y': { from: 'daily', hours: 24 * 365 },
  ALL: { from: 'daily', hours: null },
};

/** The two fetches. 90 days is CoinGecko's hourly ceiling. */
export const FETCH_PLAN: { key: 'intraday' | 'daily'; days: number | 'max'; interval: Interval }[] =
  [
    { key: 'intraday', days: 90, interval: 'hourly' },
    { key: 'daily', days: 'max', interval: 'daily' },
  ];

export type HistoryDoc = {
  sym: string;
  name: string;
  updatedAt: string;
  /** Provider attribution — required by CoinGecko's API Terms on every tier. */
  source: string;
  /**
   * Honest description of what these bars are.
   *
   * Open/high/low are derived by resampling closes into buckets, not taken from
   * exchange OHLC. An intra-bar wick that reversed inside the source resolution
   * is invisible. At phone-chart scale that is not visible, but the field exists
   * so nobody downstream mistakes these for exchange candles.
   */
  resolution: 'resampled-from-close';
  ranges: Partial<Record<Range, Series>>;
};

/**
 * Cut every range out of the two raw series.
 *
 * Pure, so it can be tested without a network — which matters because the
 * windowing is the part that fails quietly. A range that windows to nothing
 * falls back to the whole series rather than publishing an empty chart: a
 * newly-listed coin with four days of history should render four days under
 * "30D", not a blank panel.
 */
export function cutRanges(raw: {
  intraday: Candle[];
  daily: Candle[];
}): Partial<Record<Range, Series>> {
  const now = Date.now();
  const out: Partial<Record<Range, Series>> = {};

  for (const range of RANGES) {
    const plan = RANGE_PLAN[range];
    const source = raw[plan.from];
    if (source.length === 0) continue;

    const windowed =
      plan.hours === null
        ? source
        : source.filter((c) => c.openTime >= now - plan.hours! * 3_600_000);

    const use = windowed.length >= 2 ? windowed : source;
    const series = resample(use, RANGE_POINTS[range]);
    if (series.c.length > 0) out[range] = series;
  }

  return out;
}

/**
 * Build one coin's history document.
 *
 * Returns null when the coin has no usable history at all, so the caller can
 * skip it rather than publishing an empty document that renders as a broken
 * chart.
 */
export async function buildHistory(
  provider: MarketProvider,
  coin: { id: string; sym: string; name: string },
): Promise<HistoryDoc | null> {
  const raw: { intraday: Candle[]; daily: Candle[] } = { intraday: [], daily: [] };

  for (const step of FETCH_PLAN) {
    try {
      raw[step.key] = await provider.candles(coin.id, step.days, step.interval);
    } catch (e) {
      // One failed resolution must not lose the other. A coin with no all-time
      // daily series can still show 24H through 90D.
      console.warn(`${coin.sym}: ${step.key} fetch failed: ${(e as Error).message}`);
    }
  }

  const ranges = cutRanges(raw);
  if (Object.keys(ranges).length === 0) return null;

  return {
    sym: coin.sym,
    name: coin.name,
    updatedAt: new Date().toISOString(),
    source: provider.name,
    resolution: 'resampled-from-close',
    ranges,
  };
}

/**
 * Write history documents, split across the paywall.
 *
 * Same gate as everything else: free coins to `public/`, the rest to `private/`,
 * both matched by existing `{doc=**}` rules so no rules change is needed. A
 * rules change to ship a feature is a rules change that can regress a paywall
 * verified by direct attack, and this feature does not need one.
 *
 * Batched in chunks of 400 — Firestore's limit is 500 writes per batch, and
 * leaving headroom means a later addition to this loop does not silently start
 * throwing at the boundary.
 */
export async function publishHistory(
  db: Firestore,
  docs: HistoryDoc[],
): Promise<{ free: number; paid: number }> {
  let free = 0;
  let paid = 0;

  for (let i = 0; i < docs.length; i += 400) {
    const batch = db.batch();
    for (const doc of docs.slice(i, i + 400)) {
      const where = isFree(doc.sym) ? 'public' : 'private';
      batch.set(db.doc(`${where}/hist_${doc.sym}`), doc);
      if (where === 'public') free += 1;
      else paid += 1;
    }
    await batch.commit();
  }

  return { free, paid };
}

/**
 * How stale a stored series may be before it must be refreshed.
 *
 * TWENTY-FOUR HOURS IS A LICENCE TERM, NOT A TUNING CHOICE. CoinGecko's API
 * Terms permit caching and storage only on the condition that "You should
 * refresh the cache at least every 24 hours". Anything stored here that goes
 * longer than a day without a refresh is outside the licence, so this constant
 * is a compliance boundary and the margin below it is deliberate.
 */
export const MAX_AGE_MS = 20 * 3_600_000;

/** Coins whose stored history is missing or older than the licence allows. */
export async function staleCoins(
  db: Firestore,
  universe: { id: string; sym: string; name: string }[],
  now = Date.now(),
): Promise<typeof universe> {
  const out: typeof universe = [];

  for (const coin of universe) {
    const where = isFree(coin.sym) ? 'public' : 'private';
    const snap = await db.doc(`${where}/hist_${coin.sym}`).get();
    if (!snap.exists) {
      out.push(coin);
      continue;
    }
    const updatedAt = Date.parse((snap.data() as { updatedAt?: string }).updatedAt ?? '');
    if (!Number.isFinite(updatedAt) || now - updatedAt > MAX_AGE_MS) out.push(coin);
  }

  return out;
}
