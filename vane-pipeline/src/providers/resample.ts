// Aggregating a fine series down to a chart-sized one.
//
// Kept pure and provider-free so it can be tested without a network, and so the
// bucketing rules are in one place rather than scattered through the fetchers.

import type { Candle, Series } from './types.ts';

/**
 * Aggregate candles into at most `points` bars.
 *
 * Buckets are equal-COUNT rather than equal-TIME. For the regularly spaced
 * series CoinGecko returns (hourly or daily) the two are equivalent, and
 * equal-count cannot produce an empty bucket — an equal-time bucketing of a
 * series with a gap yields bars with no data, which then render as a hole or a
 * zero depending on how carefully the chart handles them.
 *
 * Returns fewer than `points` bars when the input is shorter. It never
 * interpolates to reach the target: inventing bars to fill a chart is how a
 * sparse asset ends up looking as liquid as Bitcoin.
 */
export function resample(candles: Candle[], points: number): Series {
  const empty: Series = { t: [], o: [], h: [], l: [], c: [], v: [] };
  if (candles.length === 0 || points <= 0) return empty;

  // Already at or under budget: pass through, preserving whatever OHLC the
  // source gave us rather than re-deriving it.
  if (candles.length <= points) return toSeries(candles);

  // INTEGER arithmetic, not float multiplication.
  //
  // The obvious form — `size = n/points`, `end = floor((b+1)*size)` — relies on
  // `floor(points * (n/points)) === n`, which IEEE-754 does not guarantee.
  // `168 * (173/168)` is 172.99999999999997, so the last bucket ends at 172 and
  // the NEWEST candle is silently dropped. This is not theoretical: a coin
  // listed 21 days ago has 504 hourly bars, and both the 30D (points=180) and
  // 90D (points=90) cuts of it lose their final bar — so the chart stops short
  // of the current price, which reads as the coin having gone quiet.
  //
  // `(b+1)*n/points` computed with integer multiplication first is exact for
  // every n and points in range, so the final bucket always ends at n.
  const n = candles.length;
  const out: Series = { t: [], o: [], h: [], l: [], c: [], v: [] };

  for (let b = 0; b < points; b++) {
    const start = Math.floor((b * n) / points);
    const end = Math.floor(((b + 1) * n) / points);
    if (end <= start) continue;

    const slice = candles.slice(start, end);
    let high = -Infinity;
    let low = Infinity;
    for (const c of slice) {
      if (c.high > high) high = c.high;
      if (c.low < low) low = c.low;
    }

    out.t.push(slice[0]!.openTime);
    out.o.push(r(slice[0]!.open));
    out.h.push(r(high));
    out.l.push(r(low));
    out.c.push(r(slice[slice.length - 1]!.close));
    // LAST, not SUM.
    //
    // CoinGecko's volume series is a rolling 24-hour total, so consecutive
    // samples overlap almost entirely. Summing them would multiply one day's
    // volume by the bucket width and produce numbers that are wrong by an order
    // of magnitude while still looking plausible on a chart. The last sample in
    // the bucket is the rolling total as it stood at the bucket's close, which
    // is the only reading that means anything.
    out.v.push(r(slice[slice.length - 1]!.volume));
  }

  return out;
}

function toSeries(candles: Candle[]): Series {
  const s: Series = { t: [], o: [], h: [], l: [], c: [], v: [] };
  for (const c of candles) {
    s.t.push(c.openTime);
    s.o.push(r(c.open));
    s.h.push(r(c.high));
    s.l.push(r(c.low));
    s.c.push(r(c.close));
    s.v.push(r(c.volume));
  }
  return s;
}

/**
 * Eight significant figures.
 *
 * Matches the rounding publish.ts already applies, which matters for a reason
 * beyond consistency: a packed series is stored as JSON, and full float
 * precision roughly doubles the document size for digits no chart can draw.
 */
const r = (n: number) => (Number.isFinite(n) ? Number(n.toPrecision(8)) : 0);
