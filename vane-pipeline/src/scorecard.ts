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
 * One call per coin per HORIZON LENGTH — not per hour.
 *
 * This is the difference between a track record and a misleading one.
 *
 * Recording hourly looks like more evidence and is not. Twenty-four 24H calls
 * placed an hour apart share twenty-three hours of the same price path; 720
 * hourly 30D calls are 720 views of one month. The published sample would
 * have read "135,000/262,000" after a year while the independent evidence was
 * roughly 360 observations — a quarter-million-sample claim backed by a few
 * hundred. That is precisely the unverifiable number this feature exists to
 * replace, and a reviewer could take it apart in an afternoon.
 *
 * Spacing consecutive calls by the horizon's own length makes them
 * non-overlapping, so `graded` counts independent windows. The cost is that
 * 30D accumulates 30 calls a month rather than 21,600, which is the honest
 * rate at which evidence about a 30-day forecast actually arrives.
 *
 * Note this still does not make calls independent ACROSS coins: crypto majors
 * move together, so thirty coins in one window is nearer five independent
 * observations than thirty. The published figure is an upper bound on the
 * evidence, which is why the threshold below is deliberately high.
 */
// Gated on ELAPSED TIME, not on a wall-clock bucket.
//
// Fixed UTC buckets looked equivalent and are not: a call at 23:00 and one at
// 01:00 sit in different day-buckets while their 24-hour windows overlap by
// twenty-two hours. The boundary, not the spacing, decided — so the very
// overlap this exists to prevent could still happen twice a day.
const isDue = (hz: Horizon, lastAt: number, now: number) =>
  now - lastAt >= HORIZON_HOURS[hz] * 3_600_000;

/** Unique per recording. Two calls for one coin and horizon can never be
 *  closer than the horizon itself, so the minute is more than enough. */
const callId = (coin: string, hz: Horizon, at: number) =>
  `${coin}-${hz}-${Math.floor(at / 60_000)}`;

/** When each horizon last recorded, so an undue horizon costs one read
 *  rather than thirty redundant writes. */
const CURSOR = 'ops/scorecard_cursor';

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
 * Thirty was far too low. At n=30 the standard error on a coin flip is 9.1
 * percentage points, so the 95% interval spans 32% to 68% — a measured 50%
 * is consistent with a strong edge in either direction, and the number would
 * have been rendered as a bold 24pt percentage carrying none of that doubt.
 * Detecting a genuine 55% edge against 50% at 80% power needs roughly 780
 * independent calls.
 *
 * Two hundred is a compromise: still not enough to prove a small edge, but
 * enough that the figure is not simply noise, and reachable in a week for
 * 24H. Longer horizons will sit at "—" for months, which is the honest
 * consequence of only having one independent 30-day window per month.
 */
const MIN_GRADED = 200;

/** Record the current call for every coin, so it can be graded later. */
export async function recordCalls(
  db: Firestore,
  coins: { sym: string; price: number; up: boolean; targets: Record<string, unknown> }[],
  horizons: Horizon[],
  now = Date.now(),
): Promise<number> {
  // One read tells us whether anything needs writing at all. Firestore bills
  // every set, identical content or not, so re-writing unchanged rows on all
  // ninety-six runs a day was thousands of billed writes carrying no new
  // information — and, because `set` replaces, it also meant the LAST run of
  // a bucket overwrote the entry price the first one recorded, so the stored
  // call no longer matched what users were shown when it was made.
  const cursorRef = db.doc(CURSOR);
  const cursorSnap = await cursorRef.get();
  const cursor = (cursorSnap.exists ? cursorSnap.data() : {}) as Record<string, number>;

  const due = horizons.filter((hz) => isDue(hz, cursor[hz] ?? 0, now));
  if (due.length === 0) return 0;

  const batch = db.batch();
  let writes = 0;

  for (const coin of coins) {
    if (!Number.isFinite(coin.price) || coin.price <= 0) continue;
    for (const hz of due) {
      const id = callId(coin.sym, hz, now);
      // Reached only when the bucket has actually turned over, so this
      // writes the FIRST call of each window and never overwrites it.
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

  if (writes > 0) {
    for (const hz of due) batch.set(cursorRef, { [hz]: now }, { merge: true });
    await batch.commit();
  }
  return writes;
}

/** Where the running totals live. Not under /public: clients read the
 *  derived scorecard, never the counters. */
const TOTALS = 'ops/scorecard_totals';

type Totals = Record<string, { graded: number; correct: number }>;

/** Grade every recorded call whose horizon has elapsed. */
export async function gradeCalls(
  db: Firestore,
  prices: PriceMap,
  now = Date.now(),
): Promise<{ graded: number; ties: number; voided: number }> {
  const out = { graded: 0, ties: 0, voided: 0 };
  // Per-horizon deltas from THIS run, folded into the running totals below.
  const delta: Totals = {};
  const bump = (hz: string, correct: boolean) => {
    const d = (delta[hz] ??= { graded: 0, correct: 0 });
    d.graded += 1;
    if (correct) d.correct += 1;
  };

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
      horizon: string;
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

    const won = (d.direction === 'up') === move > 0;
    batch.update(doc.ref, {
      resolved: true,
      exitPrice: exit,
      deltaPct: move * 100,
      won,
    });
    bump(d.horizon, won);
    out.graded += 1;
  }

  await batch.commit();
  await addToTotals(db, delta);
  return out;
}

/**
 * Fold this run's results into the running totals.
 *
 * Counters, not a recount. `scorecard()` used to scan every resolved call,
 * three times per run: signals_history grows by ~2,000 documents a day and is
 * never pruned, so within a fortnight that was over a million reads a day
 * against a 50,000/day free quota — a bill that grows forever while telling
 * us nothing a counter does not. One read and one write per run is flat.
 */
async function addToTotals(db: Firestore, delta: Totals): Promise<void> {
  if (Object.keys(delta).length === 0) return;
  const ref = db.doc(TOTALS);
  // A transaction because the cron can double-fire: two runs reading the same
  // totals and writing back would lose one run's grades entirely.
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = (snap.exists ? snap.data() : {}) as Totals;
    const next: Totals = { ...current };
    for (const [hz, d] of Object.entries(delta)) {
      const c = next[hz] ?? { graded: 0, correct: 0 };
      next[hz] = { graded: c.graded + d.graded, correct: c.correct + d.correct };
    }
    tx.set(ref, next);
  });
}

/**
 * The running hit rate per horizon.
 *
 * Counted from graded calls only: ties and voids are excluded rather than
 * scored as half-wins, because a tie is an absence of a result and folding it
 * in either direction moves the number without evidence.
 */
export async function scorecard(db: Firestore): Promise<ScoreRow[]> {
  // ONE read, whatever the history's size. This used to scan every resolved
  // call per horizon per run, which grew without bound.
  const snap = await db.doc(TOTALS).get();
  const totals = (snap.exists ? snap.data() : {}) as Totals;

  return (['24H', '7D', '30D'] as Horizon[]).map((hz) => {
    const t = totals[hz] ?? { graded: 0, correct: 0 };
    return {
      horizon: hz,
      graded: t.graded,
      correct: t.correct,
      hitRate: t.graded >= MIN_GRADED ? t.correct / t.graded : null,
    };
  });
}
