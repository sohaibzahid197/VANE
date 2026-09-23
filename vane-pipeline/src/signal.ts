// The model. Deliberately a transparent statistical score, not a black box:
// every signal has to be explainable in three sentences on screen 1d, and a
// weighted sum of named features gives us those sentences for free.

import type { Candle } from './fetch.ts';
import { ema, realizedVol, rsi, zscore } from './indicators.ts';

export type Horizon = '24H' | '7D' | '30D';

/** Candles ahead of `now` that each horizon resolves at, on 1h candles. */
export const HORIZON_HOURS: Record<Horizon, number> = { '24H': 24, '7D': 168, '30D': 720 };

export type Feature = { name: string; value: number; weight: number; reason: string };

export type Signal = {
  up: boolean;
  /** Raw score in roughly [-1, 1]; positive = up. */
  score: number;
  features: Feature[];
};

/**
 * Indicator arrays depend only on the candles, never on the index being
 * scored, so they are computed ONCE per symbol and reused. Recomputing them
 * inside scoreAt made the backtest O(n·w) per call — ~16s of pure CPU for a
 * full run, about 3,500x more work than needed.
 */
export type Indicators = {
  closes: number[];
  fast: number[];
  slow: number[];
  r: number[];
  rv: number[];
  volZ: number[];
};

export function prepare(candles: Candle[]): Indicators {
  const closes = candles.map((c) => c.close);
  return {
    closes,
    fast: ema(closes, 12),
    slow: ema(closes, 48),
    r: rsi(closes, 14),
    rv: realizedVol(closes, 24),
    volZ: zscore(candles.map((c) => c.volume), 48),
  };
}

/**
 * Score the market at index `i`.
 * Only uses data at or before `i` — no lookahead, so the backtest is honest.
 */
export function scoreAt(ind: Indicators, i: number): Signal {
  const { closes, fast, slow, r, rv, volZ } = ind;

  // Trend: fast EMA above slow EMA, scaled by price so it is unit-free.
  const trend = (fast[i] - slow[i]) / closes[i];

  // Momentum: 24h return.
  const mom = i >= 24 ? (closes[i] - closes[i - 24]) / closes[i - 24] : 0;

  // Mean reversion: RSI distance from neutral, inverted — stretched fades.
  const revert = -(r[i] - 50) / 50;

  // Volatility regime: compressing vol favours continuation of the trend.
  let volSum = 0;
  let volN = 0;
  for (let j = Math.max(0, i - 48); j <= i; j++) {
    volSum += rv[j];
    volN += 1;
  }
  const volMean = volN === 0 ? 0 : volSum / volN;
  const volRegime = volMean === 0 ? 0 : (volMean - rv[i]) / volMean;

  const features: Feature[] = [
    {
      name: 'trend',
      value: clamp(trend * 60, -1, 1),
      weight: 0.42,
      reason:
        trend > 0
          ? 'Short-term mean is holding above the long-term mean'
          : 'Short-term mean has crossed below the long-term mean',
    },
    {
      name: 'momentum',
      value: clamp(mom * 18, -1, 1),
      weight: 0.26,
      reason:
        mom > 0
          ? 'Price is up over the last 24 hours of trade'
          : 'Price is down over the last 24 hours of trade',
    },
    {
      name: 'reversion',
      value: clamp(revert, -1, 1),
      weight: 0.18,
      reason:
        r[i] > 65
          ? 'Momentum is stretched — limited room before a pullback'
          : r[i] < 35
            ? 'Selling looks exhausted on the hourly oscillator'
            : 'Oscillator is mid-range, neither stretched nor exhausted',
    },
    {
      name: 'volRegime',
      value: clamp(volRegime, -1, 1),
      weight: 0.08,
      reason:
        volRegime > 0
          ? 'Realised volatility is compressing into the move'
          : 'Realised volatility is expanding — widens the band',
    },
    {
      name: 'volume',
      value: clamp(volZ[i] / 2.5, -1, 1) * Math.sign(trend || 1),
      weight: 0.06,
      reason:
        volZ[i] > 0.5
          ? 'Volume is running above its recent average'
          : 'Volume is unremarkable versus recent sessions',
    },
  ];

  const score = features.reduce((a, f) => a + f.value * f.weight, 0);
  return { up: score >= 0, score, features };
}

/** The three reasoning bullets screen 1d shows: strongest contributors first. */
export function topReasons(sig: Signal, n = 3): string[] {
  return [...sig.features]
    .sort((a, b) => Math.abs(b.value * b.weight) - Math.abs(a.value * a.weight))
    .slice(0, n)
    .map((f) => f.reason);
}

/**
 * Price target for a horizon.
 *
 * The expected move is a DRIFT, so it scales linearly in time — not as
 * sqrt(t), which is how uncertainty scales. Using sqrt for the point estimate
 * hard-wired 30D = 5.48x 24H for every coin at every moment, a constant ratio
 * carrying no information, and left 30D targets around 2.8% when real 30-day
 * crypto ranges are an order of magnitude wider.
 *
 * `band` still uses sqrt(t), because that part genuinely is uncertainty.
 */
export function priceTarget(ind: Indicators, i: number, h: Horizon, sig: Signal) {
  const rv = ind.rv[i];
  const hours = HORIZON_HOURS[h];

  const band = rv * Math.sqrt(hours);

  // The expected move is a DRIFT, so it scales linearly in time; the band is
  // uncertainty, so it scales as sqrt(t). Linear beats sqrt eventually, which
  // means a fixed coefficient cannot keep the two coherent at every horizon:
  // at 0.12 the drift overtakes the band at 30D for any |score| > 0.31, and
  // the p90 score is 0.53. The published interval `pct ± bandPct` would then
  // exclude zero — the model asserting a guaranteed direction.
  const raw = sig.score * rv * hours * 0.12;

  // So the drift is capped at 90% of the band. The forecast can be confident,
  // but never more confident than its own uncertainty allows.
  const ceiling = band * 0.9;
  const bounded = Math.max(-ceiling, Math.min(ceiling, raw));

  // Absolute floor as well: unclamped, a bearish score on a volatile coin
  // drove drift below -1 and published a NEGATIVE price target.
  const drift = Math.max(-0.75, Math.min(0.75, bounded));

  const price = ind.closes[i] * (1 + drift);
  return { price, pct: drift * 100, bandPct: band * 100 };
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}
