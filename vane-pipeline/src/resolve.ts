// Grades user predictions and aggregates crowd polls.
//
// Runs on the same cron as the refresh. Two jobs that both need server-side
// authority, because the security rules deliberately forbid clients from
// touching either:
//
//   1. A prediction is created with `resolved: false` and a server timestamp.
//      Only this job may flip it, so a user cannot mark their own losses as
//      wins — which is the whole point of showing a track record.
//   2. Votes are private per user; the public tally is derived here so the
//      raw votes never have to be world-readable.

import { HORIZON_HOURS, type Horizon } from './signal.ts';

type Firestore = import('firebase-admin/firestore').Firestore;

/** Prices keyed by symbol, from the refresh that just ran. */
export type PriceMap = Record<string, number>;

/**
 * Batches cap at 500 writes. Each prediction costs exactly one write today,
 * but keeping the page well under the cap leaves headroom for a second write
 * per prediction (a user-stats counter, say) without silently breaking.
 */
const PAGE = 200;

/** The shortest horizon the app sells. A prediction younger than this cannot
 *  be due whatever its timeframe. */
const MIN_HORIZON_MS = Math.min(...Object.values(HORIZON_HOURS)) * 3_600_000;
const MAX_PAGES = 20;

/**
 * Ties are neither a win nor a loss.
 *
 * 1e-9 relative was ~$0.00009 on BTC — 100x smaller than the exchange's own
 * $0.01 tick, so it only ever fired on bit-identical prices and never on the
 * pegged/low-volatility assets the handling exists for. 1e-5 is roughly half
 * a tick at four-figure prices and genuinely catches a flat outcome.
 */
const TIE_EPSILON = 1e-5;

const isHorizon = (v: unknown): v is Horizon =>
  v === '24H' || v === '7D' || v === '30D';

const usablePrice = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0;

export type ResolveResult = {
  resolved: number;
  ties: number;
  /** True when the page budget ran out with work still queued — the signal
   *  that predictions are being starved and the cap needs raising. */
  truncated: boolean;
  /** Written off as ungradeable — these leave the queue permanently. */
  voided: number;
  /** Still pending, either not due or awaiting a price. */
  pending: number;
};

/**
 * Resolve every prediction whose horizon has elapsed.
 *
 * Paginates by document path so the whole backlog is walked, not just the
 * lexicographically-first page. Without that, once the unresolved count
 * exceeded one page the same head-of-queue documents were re-read forever and
 * every user whose uid sorted late was never graded at all.
 */
export async function resolvePredictions(
  db: Firestore,
  prices: PriceMap,
): Promise<ResolveResult> {
  const now = Date.now();
  const out: ResolveResult = { resolved: 0, ties: 0, voided: 0, pending: 0, truncated: false };

  let cursor: unknown = null;

  // Nothing placed within the shortest horizon can possibly be due, so there
  // is no reason to read it. Without this the query returned EVERY pending
  // prediction on every run — ninety-six times a day, forever — and a user
  // holding a 30D call kept it in the scan for a month. At around five
  // hundred concurrently pending predictions that alone exhausted the free
  // tier's fifty thousand daily reads, which is a few hundred users.
  //
  // `placedAt` already exists on every prediction and the rules already
  // force it to the server timestamp, so this needs no schema change, no
  // rules change and no migration.
  const youngest = new Date(now - MIN_HORIZON_MS);

  for (let page = 0; page < MAX_PAGES; page++) {
    let q = db
      .collectionGroup('predictions')
      .where('resolved', '==', false)
      .where('placedAt', '<=', youngest)
      // Firestore requires the inequality field to be ordered first; the
      // document name breaks ties so paging stays deterministic.
      .orderBy('placedAt')
      .orderBy('__name__')
      .limit(PAGE);
    if (cursor) q = q.startAfter(cursor);

    const snap = await q.get();
    if (snap.empty) break;
    cursor = snap.docs[snap.docs.length - 1];

    const batch = db.batch();
    let writes = 0;

    for (const doc of snap.docs) {
      const d = doc.data() as {
        coin?: string; direction?: string; tf?: string;
        placedAt?: { toMillis(): number }; entryPrice?: number;
      };

      // Malformed or ungradeable: mark terminally rather than skipping.
      // A skipped document stays `resolved: false` and is re-read on every
      // subsequent run, so a handful of them eventually fill the page and
      // starve every newer prediction out of the queue.
      if (
        !d.coin ||
        !isHorizon(d.tf) ||
        !d.placedAt ||
        typeof d.placedAt.toMillis !== 'function' ||
        !usablePrice(d.entryPrice)
      ) {
        batch.update(doc.ref, {
          resolved: true,
          resolvedAt: new Date(),
          won: null,
          voidReason: 'malformed',
        });
        writes += 1;
        out.voided += 1;
        continue;
      }

      const dueAt = d.placedAt.toMillis() + HORIZON_HOURS[d.tf] * 3_600_000;
      if (now < dueAt) {
        out.pending += 1;
        continue;
      }

      const exit = prices[d.coin];
      if (!usablePrice(exit)) {
        // The coin left the universe. Leave it pending for now; a delisting
        // that never comes back is caught by the age check below.
        const ageDays = (now - d.placedAt.toMillis()) / 86_400_000;
        if (ageDays > 45) {
          batch.update(doc.ref, {
            resolved: true,
            resolvedAt: new Date(),
            won: null,
            voidReason: 'no-price',
          });
          writes += 1;
          out.voided += 1;
        } else {
          out.pending += 1;
        }
        continue;
      }

      const move = (exit - d.entryPrice) / d.entryPrice;

      // An exactly flat outcome is not a correct "down" call. Treating it as
      // one handed every DOWN prediction a free win on any pegged or
      // low-volatility asset, which is exactly where ties actually occur.
      if (Math.abs(move) < TIE_EPSILON) {
        batch.update(doc.ref, {
          resolved: true,
          resolvedAt: new Date(),
          exitPrice: exit,
          deltaPct: 0,
          won: null,
          voidReason: 'tie',
        });
        writes += 1;
        out.ties += 1;
        continue;
      }

      const won = (d.direction === 'up') === move > 0;
      batch.update(doc.ref, {
        resolved: true,
        resolvedAt: new Date(),
        exitPrice: exit,
        deltaPct: Number((move * 100).toFixed(2)),
        won,
      });
      writes += 1;
      out.resolved += 1;
    }

    if (writes > 0) await batch.commit();
    if (snap.size < PAGE) break;
    // Ran the full budget and the last page was still full: more remains.
    if (page === MAX_PAGES - 1) out.truncated = true;
  }

  return out;
}

/**
 * Aggregate private per-user votes into the public tally the app renders.
 *
 * The prototype hardcoded "64% up / 36% down". This computes it. A coin with
 * too few votes publishes null rather than a percentage built on three people.
 */
const MIN_VOTES = 10;

/**
 * How far back a vote counts.
 *
 * The tally used to scan every vote ever cast, on every run — unbounded, and
 * exhausting the free tier's daily reads at roughly five hundred lifetime
 * votes, which is a hundred or so users. It could not be made incremental,
 * because a user may change or delete a vote and the old direction would have
 * to be decremented from a tally the pipeline cannot see.
 *
 * Bounding the window fixes the cost and is the better product anyway: this
 * is "what the crowd thinks", shown beside a 24-hour signal. A vote from
 * eight months ago is not an opinion about now. Seven days is long enough to
 * clear the MIN_VOTES threshold on quieter coins and short enough that the
 * tally tracks the market.
 */
const VOTE_WINDOW_MS = 7 * 24 * 3_600_000;
const VOTE_PAGE = 1000;
const VOTE_MAX_PAGES = 50;

export async function aggregatePolls(
  db: Firestore,
  known: ReadonlySet<string>,
): Promise<{ polls: number; scanned: number; truncated: boolean }> {
  const tally: Record<string, { up: number; down: number }> = {};
  let cursor: unknown = null;
  let scanned = 0;
  let truncated = true;

  for (let page = 0; page < VOTE_MAX_PAGES; page++) {
    let q = db
      .collectionGroup('votes')
      .where('at', '>=', new Date(Date.now() - VOTE_WINDOW_MS))
      .orderBy('at')
      .orderBy('__name__')
      .limit(VOTE_PAGE);
    if (cursor) q = q.startAfter(cursor);

    const snap = await q.get();
    if (snap.empty) {
      truncated = false;
      break;
    }
    cursor = snap.docs[snap.docs.length - 1];
    scanned += snap.size;

    for (const doc of snap.docs) {
      const d = doc.data() as { direction?: string };
      const coin = doc.id;
      // Only symbols the pipeline actually publishes. Without this a client
      // writing users/{uid}/votes/<anything> injects arbitrary keys straight
      // into the public tally.
      if (!known.has(coin)) continue;
      if (d.direction !== 'up' && d.direction !== 'down') continue;
      tally[coin] ??= { up: 0, down: 0 };
      tally[coin][d.direction] += 1;
    }

    if (snap.size < VOTE_PAGE) {
      truncated = false;
      break;
    }
  }

  const polls: Record<string, { up: number; total: number } | null> = {};
  let counted = 0;
  for (const [coin, t] of Object.entries(tally)) {
    const total = t.up + t.down;
    if (total < MIN_VOTES) {
      polls[coin] = null;
      continue;
    }
    polls[coin] = { up: Math.round((t.up / total) * 100), total };
    counted += 1;
  }

  await db.doc('public/polls').set({
    updatedAt: new Date().toISOString(),
    minVotes: MIN_VOTES,
    // Published so the app can say what the tally covers rather than
    // implying it is everyone who ever voted.
    windowDays: VOTE_WINDOW_MS / (24 * 3_600_000),
    polls,
  });

  return { polls: counted, scanned, truncated };
}

/**
 * Publish a heartbeat for the post-publish work.
 *
 * Without this a resolver failure is completely invisible: refresh catches it,
 * logs a warning and exits zero, so the cron stays green forever while nothing
 * is ever graded.
 */
export async function writeHealth(
  db: Firestore,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    // NOT under public/: this carries raw exception text (which routinely
    // includes project ids and index URLs) and exact document counts, i.e. a
    // live floor on the user base. Rules deny reads outside public/, so only
    // the service account can see it.
    await db.doc('ops/resolver_health').set({
      ranAt: new Date().toISOString(),
      ...payload,
    });
  } catch {
    // Health reporting must never be the thing that fails the run.
  }
}
