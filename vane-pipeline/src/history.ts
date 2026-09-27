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
  /**
   * True when one of the two fetches failed, so some ranges are missing.
   *
   * Without this a degraded document is indistinguishable from a complete one
   * and staleCoins would skip it for 20 hours. See buildHistory.
   */
  partial?: boolean;
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

  // When 1Y and ALL cover the same window, one of the two labels is a lie —
  // and WHICH one depends on why they match.
  //
  //   Plan-capped: CoinGecko's Demo tier stops at 365 days, so a coin with a
  //     decade of history still returns exactly a year. Here "1Y" is true and
  //     "ALL" is false, so ALL goes.
  //
  //   Coin-capped: a token listed four days ago returns four days however far
  //     back we ask. Here "ALL" is true and "1Y" is false, so 1Y goes.
  //
  // Dropping the same one in both cases would either claim a year of history
  // for a four-day-old token, or claim all-time for a year of it.
  const year = out['1Y'];
  const all = out.ALL;
  if (year && all) {
    const span = (s: Series) => s.t[s.t.length - 1]! - s.t[0]!;
    const yearSpan = span(year);
    const allSpan = span(all);
    // 5% tolerance: resampling puts bucket boundaries in slightly different
    // places, so identical windows do not produce byte-identical spans.
    if (allSpan <= yearSpan * 1.05) {
      const YEAR_MS = 360 * 24 * 3_600_000;
      if (allSpan >= YEAR_MS) delete out.ALL;
      else delete out['1Y'];
    }
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

  // A PARTIAL rebuild must not present itself as a complete, fresh one.
  //
  // publishHistory uses set(), not merge, so a run where the daily fetch failed
  // but the hourly succeeded overwrites a complete 6-range document with a
  // 4-range one — silently deleting 1Y and ALL — and stamps updatedAt with now.
  // staleCoins then skips that coin for another 20 hours, so a chart that lost
  // its long ranges reports itself as up to date. The degraded state is exactly
  // what a mid-run quota exhaustion produces, so it is not a rare path.
  //
  // Marking it keeps the data (a 4-range chart beats no chart) while making the
  // coin eligible for retry on the next run.
  const complete = raw.intraday.length > 0 && raw.daily.length > 0;

  return {
    sym: coin.sym,
    name: coin.name,
    updatedAt: new Date().toISOString(),
    source: provider.name,
    resolution: 'resampled-from-close',
    partial: !complete,
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
 * CHUNKED BY PAYLOAD SIZE, NOT DOCUMENT COUNT, and that distinction is the whole
 * reason this function looks like this. Firestore's batch limit is 500 writes, so
 * batching 400 at a time looks obviously safe — and it is, for the small
 * documents the rest of the pipeline writes. A history document is ~65KB, so 50
 * of them is a ~3.2MB single commit, which died with
 * `DEADLINE_EXCEEDED after 60.002s` on the first real run and published nothing
 * at all after spending 100 provider credits fetching the data.
 *
 * So batches are capped by estimated bytes, each commit is independent, and a
 * failed chunk does not discard the ones that already landed. Partial history is
 * a partial product; no history is a broken one.
 */
const MAX_BATCH_BYTES = 800_000;
/** Firestore's own ceiling, never the binding constraint for these documents. */
const MAX_BATCH_DOCS = 400;

export async function publishHistory(
  db: Firestore,
  docs: HistoryDoc[],
): Promise<{ free: number; paid: number; failed: number }> {
  let free = 0;
  let paid = 0;
  let failed = 0;

  let chunk: HistoryDoc[] = [];
  let bytes = 0;

  const flush = async () => {
    if (chunk.length === 0) return;
    const batch = db.batch();
    for (const doc of chunk) {
      // A FREE coin is written to BOTH sides, exactly as publishMarkets does —
      // `private/markets_all` contains the free coins too.
      //
      // Writing it only to `public/` left `private/hist_BTC` non-existent, so an
      // ENTITLED reader asking for the paid path got a 404 and no chart at all.
      // The bug was invisible to anyone testing without a subscription, and hit
      // 100% of paying users on the three most-opened coins in the product.
      //
      // `private/` is the complete dataset; `public/` is the shop window cut
      // from it. Not the other way round.
      batch.set(db.doc(`private/hist_${doc.sym}`), doc);
      if (isFree(doc.sym)) batch.set(db.doc(`public/hist_${doc.sym}`), doc);
    }
    try {
      await batch.commit();
      for (const doc of chunk) {
        if (isFree(doc.sym)) free += 1;
        else paid += 1;
      }
    } catch (e) {
      // Name the coins that did not land. "history rebuild failed" with no
      // symbols leaves no way to tell which charts are now stale.
      failed += chunk.length;
      console.warn(
        `history batch of ${chunk.length} failed (${chunk.map((d) => d.sym).join(',')}): ` +
          `${(e as Error).message.slice(0, 120)}`,
      );
    }
    chunk = [];
    bytes = 0;
  };

  for (const doc of docs) {
    // JSON length is a close enough proxy for the Firestore payload, and it is
    // far cheaper than serialising twice to find out exactly.
    const size = estimateBytes(doc);
    if (chunk.length > 0 && (bytes + size > MAX_BATCH_BYTES || chunk.length >= MAX_BATCH_DOCS)) {
      await flush();
    }
    chunk.push(doc);
    bytes += size;
  }
  await flush();

  return { free, paid, failed };
}

function estimateBytes(doc: HistoryDoc): number {
  let n = 200; // document overhead and the scalar fields
  for (const series of Object.values(doc.ranges)) {
    if (!series) continue;
    // Six parallel arrays; roughly 12 bytes per number once encoded.
    n += (series.t.length + series.o.length + series.h.length +
          series.l.length + series.c.length + series.v.length) * 12;
  }
  return n;
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
    // private/ holds every coin now, free ones included, so staleness is read
    // from one place rather than branching on the free list.
    const snap = await db.doc(`private/hist_${coin.sym}`).get();
    if (!snap.exists) {
      out.push(coin);
      continue;
    }
    const data = snap.data() as { updatedAt?: string; partial?: boolean };
    // A partial rebuild is always retried, whatever its age.
    if (data.partial) {
      out.push(coin);
      continue;
    }
    const updatedAt = Date.parse(data.updatedAt ?? '');
    if (!Number.isFinite(updatedAt) || now - updatedAt > MAX_AGE_MS) out.push(coin);
  }

  return out;
}
