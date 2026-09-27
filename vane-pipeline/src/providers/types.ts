// The provider contract.
//
// This file exists because the data source has to be replaceable. VANE shipped
// on Binance's public klines, and Binance's Vision Dataset Terms license that
// data under CC BY-NC-SA 4.0 with commercial use "strictly excluded" — which a
// paid subscription app plainly is. Coinbase, Kraken, OKX and Bybit are all
// stricter, not looser. So the source had to change, and the only thing that
// made that survivable was that nothing downstream of here knows where candles
// come from.
//
// The rule this encodes: provider-specific code lives in providers/, and
// everything else in the pipeline speaks these types. The app never sees any of
// it — it reads Firestore. A future migration is one file in this directory.

/** A price bar. Oldest-first arrays of these are the pipeline's lingua franca. */
export type Candle = {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

/**
 * Chart ranges the app offers.
 *
 * Deliberately a closed set. Every range has to map to a provider request AND
 * to a stored document, so an open-ended range parameter would mean unbounded
 * storage and unbounded quota. Seven is what a phone-sized chart needs.
 */
export const RANGES = ['1H', '24H', '7D', '30D', '90D', '1Y', 'ALL'] as const;
export type Range = (typeof RANGES)[number];

/**
 * How many points each range is aggregated down to before storage.
 *
 * Every range lands at or under 365 points. That is not cosmetic: a packed
 * series is ONE Firestore document and one read, and a 365-point series packs
 * to roughly 15–20KB — comfortably inside the 1MB document ceiling and small
 * enough to be fast on cellular. It is also more resolution than a ~390pt-wide
 * phone chart can draw.
 */
export const RANGE_POINTS: Record<Range, number> = {
  '1H': 60,
  '24H': 96,
  '7D': 168,
  '30D': 180,
  '90D': 90,
  '1Y': 365,
  ALL: 365,
};

/** Market facts for one coin. Nulls are real: not every coin has a max supply. */
export type CoinMarket = {
  /** The provider's canonical id — NOT the ticker. See the collision note below. */
  id: string;
  /** Uppercase ticker, for display and for the entitlement gate's free list. */
  sym: string;
  name: string;
  image: string | null;
  price: number;
  marketCap: number | null;
  rank: number | null;
  volume24h: number | null;
  change24hPct: number | null;
  circulating: number | null;
  totalSupply: number | null;
  maxSupply: number | null;
  ath: number | null;
  athDate: string | null;
  athChangePct: number | null;
  atl: number | null;
  atlDate: string | null;
};

/**
 * Why `id` and `sym` are separate fields, and why it matters.
 *
 * The same ticker means different assets on different venues, and merging
 * sources by ticker silently corrupts a coin list — you get one row whose price
 * is from one asset and whose market cap is from another, with nothing throwing.
 * Canonical provider ids are the fix, and they are a real reason to pay a
 * reference-data provider rather than stitching exchanges together.
 *
 * `sym` remains the app-facing key because the entitlement gate and the free
 * tier are expressed in tickers, and changing that would touch the paywall.
 */

/** A stored, pre-aggregated series for one coin and one range. */
export type Series = {
  /** Epoch ms, oldest first. */
  t: number[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  /** Volume, or an empty array when the provider does not supply it per bar. */
  v: number[];
};

/** Market-wide totals for the dashboard. */
export type GlobalMarket = {
  totalMarketCap: number | null;
  totalVolume24h: number | null;
  btcDominance: number | null;
  marketCapChange24hPct: number | null;
};

/**
 * What the pipeline needs from any data source.
 *
 * Kept deliberately small. Every method here is one the pipeline actually
 * calls; a provider interface that mirrors a vendor's full API surface is a
 * vendor lock-in with extra steps.
 */
export type MarketProvider = {
  readonly name: string;
  /** Ranked market data, highest market cap first. */
  markets(limit: number): Promise<CoinMarket[]>;
  /**
   * Raw candles at one resolution. The single primitive everything else is
   * built from.
   *
   * Exposing a resolution rather than a Range is deliberate and it is a cost
   * decision. A `series(id, range)` method reads better but forces one request
   * per range — seven per coin, 1,750 per rebuild of 250 coins. Two requests
   * per coin (90 days hourly, then everything daily) cover all seven ranges by
   * resampling, which is the difference between ~52,000 credits a month and
   * ~15,000 against a 100,000 budget.
   */
  candles(id: string, days: number | 'max', interval?: Interval): Promise<Candle[]>;
  /** Hourly closes and volumes — what the signal model consumes. */
  signalSeries(id: string, hours: number): Promise<Candle[]>;
  /**
   * Candles across an explicit window, for research runs that need more history
   * than the trailing-window endpoints serve. May return LESS than asked for
   * when the window exceeds the plan's depth, so callers must check.
   */
  candlesRange(
    id: string,
    fromMs: number,
    toMs: number,
    interval?: Interval,
    windowDays?: number,
  ): Promise<Candle[]>;
  /** Market-wide totals, or null when the provider does not offer them. */
  global(): Promise<GlobalMarket | null>;
  /** Calls spent so far this process, for quota accounting. */
  callsUsed(): number;
};

export type Interval = 'hourly' | 'daily';
