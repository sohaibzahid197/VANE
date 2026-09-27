// The coin universe, and the markets documents the app reads.
//
// This replaces the hardcoded array in universe.ts. That array meant adding a
// coin required an app release, capped the product at 30 coins, and encoded
// Binance's `BTCUSDT` pair naming in a file the app also imported — so the data
// source leaked into the product's vocabulary.
//
// The universe now comes from the provider, ranked by market cap, and is stored
// so the pipeline has a stable id -> ticker registry between runs.
//
// WHAT IS DELIBERATELY UNCHANGED: the public/private document split. That split
// is the paywall, it is enforced by Firestore rules rather than by the client,
// and it has been verified by direct attack. Every document written here goes
// through the same `isFree` gate that publish.ts already uses, reusing its
// FREE_SYMBOLS constant rather than restating the list — two copies of the free
// tier is how a paid coin eventually ends up in the public document.

import type { CoinMarket, GlobalMarket, MarketProvider } from './providers/types.ts';
import { FREE_SYMBOLS } from './publish.ts';

type Firestore = import('firebase-admin/firestore').Firestore;

/** Where the pipeline keeps its own id -> ticker registry. */
const UNIVERSE_DOC = 'ops/universe';

/**
 * How many coins the product carries.
 *
 * Overridable because the credit budget, not the product, sets the ceiling
 * during development. CoinGecko's free Demo plan allows 10,000 credits a month;
 * Basic allows 100,000. The full 250-coin cadence needs about 66,000, so it does
 * not fit on Demo at all — see creditBudget() below, which is there to say so
 * before a run spends the month's quota rather than after.
 */
export const UNIVERSE_SIZE = Number(process.env.UNIVERSE_SIZE ?? '250');

/** Monthly credit allowance by plan, from CoinGecko's published pricing. */
export const MONTHLY_CREDITS = { demo: 10_000, basic: 100_000 } as const;

export type BudgetInput = {
  coins: number;
  /** Runs per day of each mode. */
  pricesPerDay: number;
  signalsPerDay: number;
  historyPerDay: number;
};

/**
 * Projected monthly credit spend.
 *
 * CoinGecko bills a flat 1 call = 1 credit, and failed requests (4xx/5xx) do not
 * consume credits — so this is a straight count of successful calls.
 *
 *   prices   2 calls per run  (one /coins/markets page + /global), regardless
 *                             of coin count — the page covers 250 at once
 *   signals  1 call per coin  (market_chart, hourly)
 *   history  2 calls per coin (90d hourly + max daily)
 */
export function projectedMonthlyCredits(b: BudgetInput): number {
  const perDay =
    b.pricesPerDay * 2 + b.signalsPerDay * b.coins + b.historyPerDay * b.coins * 2;
  return Math.round(perDay * 30);
}

/**
 * Warn when the configured cadence cannot fit the plan.
 *
 * Deliberately a warning at start-up rather than a failure part way through: a
 * run that exhausts the quota at coin 180 leaves the published documents half
 * updated, with no signal that the cause was billing rather than a bug.
 */
export function creditBudget(
  tier: string,
  b: BudgetInput,
): { projected: number; allowance: number; fits: boolean } {
  const allowance =
    tier === 'demo' ? MONTHLY_CREDITS.demo : MONTHLY_CREDITS.basic;
  const projected = projectedMonthlyCredits(b);
  return { projected, allowance, fits: projected <= allowance };
}

export type UniverseEntry = { id: string; sym: string; name: string };

const isFree = (sym: string) => (FREE_SYMBOLS as readonly string[]).includes(sym);

/**
 * Fetch the ranked universe.
 *
 * One provider call for 250 coins. Worth stating because the alternative — a
 * call per coin — costs 250x the credits for identical bytes and is the easiest
 * way to exhaust a monthly budget in an afternoon.
 */
export async function fetchUniverse(
  provider: MarketProvider,
  limit = UNIVERSE_SIZE,
): Promise<CoinMarket[]> {
  const markets = await provider.markets(limit);

  // Two coins can share a ticker (the collision problem canonical ids exist to
  // solve). The app keys on `sym`, so a duplicate would mean one row silently
  // overwriting another's price and history. Keep the higher-ranked one and say
  // what was dropped rather than letting it happen quietly.
  const bySym = new Map<string, CoinMarket>();
  const dropped: string[] = [];
  for (const m of markets) {
    if (!m.sym) continue;
    const held = bySym.get(m.sym);
    if (held) {
      dropped.push(`${m.sym} (${m.id}, kept ${held.id})`);
      continue;
    }
    bySym.set(m.sym, m);
  }
  if (dropped.length) {
    console.warn(`ticker collisions dropped: ${dropped.join(', ')}`);
  }

  return [...bySym.values()];
}

/** Persist the id -> ticker registry so later runs can resolve tickers to ids. */
export async function saveUniverse(db: Firestore, markets: CoinMarket[]): Promise<void> {
  const entries: UniverseEntry[] = markets.map((m) => ({
    id: m.id,
    sym: m.sym,
    name: m.name,
  }));
  await db.doc(UNIVERSE_DOC).set({ updatedAt: new Date().toISOString(), entries });
}

/**
 * Read the stored registry.
 *
 * Returns an empty array when nothing has been stored yet, so a first run can
 * detect that and seed instead of failing.
 */
export async function loadUniverse(db: Firestore): Promise<UniverseEntry[]> {
  const snap = await db.doc(UNIVERSE_DOC).get();
  if (!snap.exists) return [];
  const data = snap.data() as { entries?: unknown };
  return Array.isArray(data.entries) ? (data.entries as UniverseEntry[]) : [];
}

export type MarketsDoc = {
  updatedAt: string;
  /** Provider attribution. Required by CoinGecko's API Terms on every tier. */
  source: string;
  count: number;
  global: GlobalMarket | null;
  coins: CoinMarket[];
};

/**
 * Publish the markets list, split across the paywall.
 *
 * ONE document per side rather than one document per coin. Firestore bills per
 * document read, so a 250-coin list read row-by-row is 250 reads per app open —
 * which exhausts the 50,000/day free tier at 200 opens. Packed, it is one read.
 *
 * Both writes go in a single batch so a device can never observe a fresh free
 * document beside a stale paid one. That is the same reason publish.ts batches,
 * and the same failure it is avoiding: two prices for the same coin on one
 * screen depending on whether the reader had paid.
 */
export async function publishMarkets(
  db: Firestore,
  markets: CoinMarket[],
  global: GlobalMarket | null,
  source = 'coingecko',
): Promise<{ free: number; all: number }> {
  const updatedAt = new Date().toISOString();
  const all: MarketsDoc = {
    updatedAt,
    source,
    count: markets.length,
    global,
    coins: markets,
  };
  const freeCoins = markets.filter((m) => isFree(m.sym));
  const free: MarketsDoc = { ...all, count: freeCoins.length, coins: freeCoins };

  const batch = db.batch();
  batch.set(db.doc('public/markets_latest'), free);
  batch.set(db.doc('private/markets_all'), all);
  await batch.commit();

  return { free: freeCoins.length, all: markets.length };
}
