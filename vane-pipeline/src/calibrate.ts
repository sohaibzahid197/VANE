// Turning a raw score into an honest percentage.
//
// The UI headlines "87% UP". If that number is not calibrated it is a false
// advertising claim, so we never derive it from the score directly. Instead we
// bucket historical scores and read off how often each bucket actually won.
//
// CRITICAL SEMANTICS: buckets are keyed on |score|, and a "win" is recorded as
// `model === actual`. So the calibrated number is P(the call is correct), NOT
// P(the price goes up). Those coincide only when the model says UP. Rendering
// P(correct) next to the word "UP" on a bearish coin shows a confidently
// inverted prediction roughly half the time — so `confidenceUp()` below is the
// only function a UI may use.

export type Bucket = { lo: number; hi: number; wins: number; total: number };

const EDGES = [0, 0.02, 0.05, 0.09, 0.15, 0.25, 1.01];

/** Minimum samples before a bucket is allowed to express a view. */
const MIN_SAMPLES = 30;

export function newBuckets(): Bucket[] {
  return EDGES.slice(0, -1).map((lo, i) => ({ lo, hi: EDGES[i + 1], wins: 0, total: 0 }));
}

export function observe(buckets: Bucket[], score: number, won: boolean) {
  const b = pick(buckets, score);
  b.total += 1;
  if (won) b.wins += 1;
}

/**
 * P(the model's call is correct) for a score, as a whole percentage.
 * Returns null when the bucket has too few samples to trust — callers must
 * propagate the null rather than substituting a number.
 */
export function confidenceCorrect(buckets: Bucket[], score: number): number | null {
  const b = pick(buckets, score);
  if (b.total < MIN_SAMPLES) return null;
  return Math.round((b.wins / b.total) * 100);
}

/**
 * P(price goes UP), which is what a UI saying "N% UP" must display.
 * If the model called DOWN, the probability of UP is the complement.
 */
export function confidenceUp(buckets: Bucket[], score: number): number | null {
  const correct = confidenceCorrect(buckets, score);
  if (correct === null) return null;
  return score >= 0 ? correct : 100 - correct;
}

/** Serialisable form so the backtest can hand a table to the publisher. */
export function toTable(buckets: Bucket[]): Bucket[] {
  return buckets.map((b) => ({ ...b }));
}

function pick(buckets: Bucket[], score: number): Bucket {
  const a = Math.abs(score);
  return buckets.find((b) => a >= b.lo && a < b.hi) ?? buckets[buckets.length - 1];
}

/** Reliability table — the thing to eyeball before trusting any number. */
export function reliability(buckets: Bucket[]): string {
  return buckets
    .filter((b) => b.total > 0)
    .map((b) => {
      const acc = (b.wins / b.total) * 100;
      const bar = '#'.repeat(Math.round(acc / 2.5));
      const thin = b.total < MIN_SAMPLES ? '  (too few)' : '';
      return `  |score| ${b.lo.toFixed(2)}-${b.hi.toFixed(2)}  n=${String(b.total).padStart(5)}  ${acc.toFixed(1).padStart(5)}%  ${bar}${thin}`;
    })
    .join('\n');
}
