// VANE's own track record.
//
// The app grades the USER's calls and always has. It has never graded its
// own, so the one number a buyer most wants — does this thing actually work —
// existed nowhere in the product. Every competitor in this category has the
// same hole, and their reviews say so in the plainest terms: "must pay $50
// monthly without proof it works". Nobody publishes a verified hit rate.
//
// This records every published call and grades it at close, exactly the way
// user predictions are graded, and publishes the running result. The number
// it produces is unlikely to be flattering — the backtest puts 24H barely
// above a coin flip and 30D below one — and that is the point. A measured,
// unimpressive record is defensible; an unverified "80% accuracy" badge is
// not, and it is what the rest of the category ships.

import { HORIZON_HOURS, type Horizon } from './signal.ts';

type Firestore = import('firebase-admin/firestore').Firestore;

/** Prices keyed by symbol, from the refresh that just ran. */
export type PriceMap = Record<string, number>;

/**
 * A call is recorded once per coin, horizon and hour.
 *
 * The refresh runs every 30 minutes, and recording both runs would double
 * count the same view of the market — two samples of one opinion, inflating
 * whichever way that hour happened to go. Bucketing by hour keeps one call
 * per hour and makes re-runs idempotent, which matters because the cron is
 * retried and occasionally doubles up.
 */
const callId = (coin: string, hz: Horizon, at: number) =>
  `${coin}-${hz}-${Math.floor(at / 3_600_000)}`;

/** Ties are neither a win nor a loss — the same epsilon user calls use. */
const TIE_EPSILON = 1e-5;

const PAGE = 300;

export type ScoreRow = {
  horizon: Horizon;
  /** Calls that have reached their close and were not ties. */
  graded: number;
  correct: number;
  /** Null until there are enough graded calls for the number to mean anything. */
  hitRate: number | null;
};

/**
 * Below this, a hit rate is noise dressed as a statistic.
 *
 * Thirty calls still has a standard error around 9 percentage points, so it
 * is a floor rather than a comfort — but publishing "100% (2 of 2)" would be
 * the same unverifiable theatre this file exists to avoid.
 */
const MIN_GRADED = 30;

/** Record the current call for every coin, so it can be graded later. */
export async function recordCalls(
  db: Firestore,
  coins: { sym: string; price: number; up: boolean; targets: Record<string, unknown> }[],
  horizons: Horizon[],
  now = Date.now(),
): Promise<number> {
  const batch = db.batch();
  let writes = 0;

  for (const coin of coins) {
    if (!Number.isFinite(coin.price) || coin.price <= 0) continue;
    for (const hz of horizons) {
      const id = callId(coin.sym, hz, now);
      // `create` would throw on the second run of an hour; `set` with merge
      // false is idempotent and keeps the first call of the hour, which is
      // the one whose entry price matches when it was made.
      batch.set(
        db.doc(`signals_history/${id}`),
        {
          coin: coin.sym,
          horizon: hz,
          direction: coin.up ? 'up' : 'down',
          entryPrice: coin.price,
          placedAt: new Date(now),
          dueAt: new Date(now + HORIZON_HOURS[hz] * 3_600_000),
          resolved: false,
        },
        { merge: false },
      );
      writes += 1;
    }
  }

  if (writes > 0) await batch.commit();
  return writes;
}

/** Grade every recorded call whose horizon has elapsed. */
export async function gradeCalls(
  db: Firestore,
  prices: PriceMap,
  now = Date.now(),
): Promise<{ graded: number; ties: number; voided: number }> {
  const out = { graded: 0, ties: 0, voided: 0 };

  const snap = await db
    .collection('signals_history')
    .where('resolved', '==', false)
    .where('dueAt', '<=', new Date(now))
    .limit(PAGE)
    .get();

  if (snap.empty) return out;

  const batch = db.batch();
  for (const doc of snap.docs) {
    const d = doc.data() as {
      coin: string;
      direction: 'up' | 'down';
      entryPrice: number;
    };
    const exit = prices[d.coin];

    // A coin that has left the universe can never be graded. Voiding it keeps
    // it out of the query window forever rather than starving newer calls out
    // of every future page.
    if (!Number.isFinite(exit) || exit <= 0) {
      batch.update(doc.ref, { resolved: true, won: null, voidReason: 'no-price' });
      out.voided += 1;
      continue;
    }

    const move = (exit - d.entryPrice) / d.entryPrice;
    if (Math.abs(move) < TIE_EPSILON) {
      batch.update(doc.ref, { resolved: true, exitPrice: exit, won: null, voidReason: 'tie' });
      out.ties += 1;
      continue;
    }

    batch.update(doc.ref, {
      resolved: true,
      exitPrice: exit,
      deltaPct: move * 100,
      won: (d.direction === 'up') === move > 0,
    });
    out.graded += 1;
  }

  await batch.commit();
  return out;
}

/**
 * The running hit rate per horizon.
 *
 * Counted from graded calls only: ties and voids are excluded rather than
 * scored as half-wins, because a tie is an absence of a result and folding it
 * in either direction moves the number without evidence.
 */
export async function scorecard(db: Firestore): Promise<ScoreRow[]> {
  const rows: ScoreRow[] = [];

  for (const hz of ['24H', '7D', '30D'] as Horizon[]) {
    const snap = await db
      .collection('signals_history')
      .where('horizon', '==', hz)
      .where('resolved', '==', true)
      .get();

    let graded = 0;
    let correct = 0;
    for (const doc of snap.docs) {
      const won = doc.get('won');
      if (won === true) {
        graded += 1;
        correct += 1;
      } else if (won === false) {
        graded += 1;
      }
    }

    rows.push({
      horizon: hz,
      graded,
      correct,
      hitRate: graded >= MIN_GRADED ? correct / graded : null,
    });
  }

  return rows;
}
