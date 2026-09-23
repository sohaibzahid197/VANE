// Shapes the Firestore document and writes it.
//
// Everything for every coin goes into ONE document on purpose: Firestore's
// free tier allows 50,000 reads/day, so one read per app open is the
// difference between ~10,000 and ~50,000 daily opens costing nothing.

import { readFileSync } from 'node:fs';
import type { Candle } from './fetch.ts';
import { type Bucket, confidenceUp } from './calibrate.ts';
import { type Horizon, type Indicators, prepare, priceTarget, scoreAt, topReasons } from './signal.ts';

export const HORIZONS_ALL: Horizon[] = ['24H', '7D', '30D'];

/**
 * Calibration buckets produced by the backtest, loaded from calibration.json.
 *
 * `npm run backtest` writes that file with `enabled: false` whenever no
 * horizon beats the naive baseline, which is the current state — so `conf`
 * publishes as null and the app renders no percentage. The moment a backtest
 * genuinely passes, the same file flips to `enabled: true` and confidence
 * starts flowing with no code change.
 *
 * Loading is deliberately fail-soft: a missing or malformed file means no
 * calibration, never a crash and never a fabricated number.
 */
function loadCalibration(): Bucket[] | null {
  try {
    const raw = readFileSync(new URL('../calibration.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw) as { enabled?: boolean; buckets?: Bucket[] };
    if (!parsed.enabled || !Array.isArray(parsed.buckets)) return null;
    return parsed.buckets;
  } catch {
    return null;
  }
}

const CALIBRATION: Bucket[] | null = loadCalibration();

export type CoinDoc = {
  sym: string;
  name: string;
  price: number;
  /**
   * Real closing prices, newest last, for the app's sparkline.
   *
   * The app previously drew a Math.sin() curve with no price input at all —
   * a decorative shape rendered beside real prices and real targets, which
   * reads as "this is what the coin did". Shipping actual closes is the only
   * honest way to draw a price chart.
   */
  history: number[];
  up: boolean;
  /** P(price goes UP) as a percentage, or null when uncalibrated. */
  conf: number | null;
  targets: Record<Horizon, { price: number; pct: number; bandPct: number }>;
  reasons: string[];
};

export function buildCoin(
  meta: { sym: string; name: string },
  candles: Candle[],
): CoinDoc {
  // Binance's last row is the CURRENT, still-forming hour: its close is a
  // mid-hour snapshot and its volume is partial, which biases the volume
  // feature negative. The backtest only ever sees closed candles, so scoring
  // the open one would make live accuracy diverge from backtested accuracy.
  const closed = candles.slice(0, -1);
  // zscore needs 48 bars of warmup. Without this guard a delisted or renamed
  // symbol returns [] and the crash surfaces as `undefined.toPrecision`,
  // naming neither the symbol nor the real cause, and killing every coin.
  if (closed.length < 49) {
    throw new Error(`${meta.sym}: only ${closed.length} closed candles, need 49`);
  }
  const ind: Indicators = prepare(closed);
  const i = closed.length - 1;
  const sig = scoreAt(ind, i);

  const targets = {} as CoinDoc['targets'];
  for (const h of HORIZONS_ALL) {
    const { price, pct, bandPct } = priceTarget(ind, i, h, sig);
    targets[h] = {
      price: round(price),
      pct: Number(pct.toFixed(2)),
      bandPct: Number(bandPct.toFixed(2)),
    };
  }

  // ~48h of hourly closes, downsampled to 24 points: enough to show shape
  // without bloating a document every client reads on every open.
  const HISTORY_POINTS = 24;
  const HISTORY_HOURS = 48;
  const from = Math.max(0, i - HISTORY_HOURS + 1);
  const window = ind.closes.slice(from, i + 1);
  const step = Math.max(1, Math.floor(window.length / HISTORY_POINTS));
  const history: number[] = [];
  for (let j = 0; j < window.length; j += step) history.push(round(window[j]));
  // Always end on the latest close so the line meets the current price.
  if (history[history.length - 1] !== round(ind.closes[i])) {
    history.push(round(ind.closes[i]));
  }

  return {
    sym: meta.sym,
    name: meta.name,
    price: round(ind.closes[i]),
    history,
    up: sig.up,
    conf: CALIBRATION ? confidenceUp(CALIBRATION, sig.score) : null,
    targets,
    reasons: topReasons(sig, 3),
  };
}

/** Shared admin handle, so one run initialises Firebase exactly once. */
export async function adminDb() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT is not set');

  // Modular entry points: the root `firebase-admin` export has no usable
  // ESM default, so `admin.default.apps` is undefined under Node ESM.
  const { cert, getApps, initializeApp } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');

  if (getApps().length === 0) {
    initializeApp({ credential: cert(JSON.parse(raw)) });
  }
  return getFirestore();
}

export async function publish(doc: unknown) {
  const db = await adminDb();
  await db.doc('public/signals_latest').set(doc as object);
}

const round = (n: number) => Number(n.toPrecision(8));
