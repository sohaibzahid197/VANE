// Stand-in for the Firestore `/public/signals_latest` document.
// Shape matches exactly what the pipeline will publish, so swapping this
// module for a Firestore read is a one-line change in SignalsScreen.

export type Horizon = '24H' | '7D' | '30D';

export type Coin = {
  sym: string;
  name: string;
  price: string;
  /** Unformatted price, used as a prediction's entry price. */
  priceNum: number;
  up: boolean;
  /** P(price goes up). null until the model clears the backtest gate. */
  conf: number | null;
  targets: Record<Horizon, [string, string]>;
  rating: 'BUY' | 'SELL' | 'HOLD';
  /** Free tier sees one coin fully; the rest arrive without detail. */
  locked: boolean;
  /** Per-coin model reasoning from the pipeline. */
  reasons?: string[];
  /** Real recent closes, oldest first, for the sparkline. */
  history?: number[];
};

export const HORIZONS: Horizon[] = ['24H', '7D', '30D'];

export const SIGNALS: Coin[] = [
  {
    sym: 'BTC', name: 'Bitcoin', price: '$123,410', priceNum: 123410, up: true, conf: 87, rating: 'BUY', locked: false,
    targets: { '24H': ['$126,400', '+2.4%'], '7D': ['$131,900', '+6.9%'], '30D': ['$142,000', '+15.1%'] },
  },
  {
    sym: 'ETH', name: 'Ethereum', price: '$4,182', priceNum: 4182, up: true, conf: 74, rating: 'BUY', locked: true,
    targets: { '24H': ['$4,290', '+2.6%'], '7D': ['$4,510', '+7.8%'], '30D': ['$4,980', '+19.1%'] },
  },
  {
    sym: 'SOL', name: 'Solana', price: '$214.60', priceNum: 214.60, up: false, conf: 61, rating: 'SELL', locked: true,
    targets: { '24H': ['$206.10', '-4.0%'], '7D': ['$198.40', '-7.5%'], '30D': ['$188.00', '-12.4%'] },
  },
  {
    sym: 'XRP', name: 'XRP', price: '$3.08', priceNum: 3.08, up: true, conf: 68, rating: 'HOLD', locked: true,
    targets: { '24H': ['$3.19', '+3.5%'], '7D': ['$3.34', '+8.4%'], '30D': ['$3.55', '+15.3%'] },
  },
  {
    sym: 'DOGE', name: 'Dogecoin', price: '$0.284', priceNum: 0.284, up: false, conf: 55, rating: 'SELL', locked: true,
    targets: { '24H': ['$0.271', '-4.6%'], '7D': ['$0.259', '-8.8%'], '30D': ['$0.240', '-15.5%'] },
  },
];

/** Procedural sparkline, ported from the prototype's spark(). */
/**
 * Map a REAL price series onto a sparkline path.
 *
 * Replaces a `Math.sin()` generator that took no price input at all — it drew
 * the same decorative curve for every coin, always trending upward, beside
 * real prices and real targets. A chart that does not come from the data is a
 * fabricated claim about the data.
 */
export function seriesPath(
  values: number[],
  w: number,
  h: number,
  pad = 0.08,
): [number, number][] {
  if (!values || values.length === 0) return [];
  if (values.length === 1) return [[0, h / 2], [w, h / 2]];

  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];

  // A perfectly flat series has no range to normalise against; draw it level
  // rather than dividing by zero.
  const span = hi - lo;
  const padPx = h * pad;
  const usable = h - padPx * 2;

  return values.map((v, i) => {
    const t = span === 0 ? 0.5 : (v - lo) / span;
    return [
      (i / (values.length - 1)) * w,
      // SVG y grows downward, so the highest price sits at the smallest y.
      h - (padPx + t * usable),
    ] as [number, number];
  });
}

/** @deprecated Decorative only — never use where a price chart is implied. */
export function spark(seed: number, n: number, w: number, h: number, up: boolean) {
  const pts: [number, number][] = [];
  let v = 0.5;
  for (let i = 0; i < n; i++) {
    v += Math.sin((i + seed) * 1.7) * 0.09 + (up ? 0.022 : -0.02);
    v = Math.max(0.1, Math.min(0.9, v));
    pts.push([(i / (n - 1)) * w, h - v * h]);
  }
  return pts;
}

export const toPath = (pts: [number, number][]) =>
  pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
