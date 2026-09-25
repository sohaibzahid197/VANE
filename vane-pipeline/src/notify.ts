// Push notifications for signal flips.
//
// The app has requested a push token, stored it and handled foreground
// delivery since before this file existed. What it never had was a sender —
// so the Alerts screen deleted its signal-flip row, with a comment saying
// those switches "are gone until there is a sender behind them". This is the
// sender.
//
// It notifies about ONE thing: a coin on the user's watchlist changing
// direction. That restraint is the design.
//
//   - Only watchlisted coins, so the user chose each one by starring it.
//   - Only a CHANGE of direction, not the daily state of the market. A signal
//     that stays "down" for a week is not news four times an hour.
//   - One push per user per run, however many coins flipped. Thirty coins
//     turning at once is one market event, not thirty notifications, and
//     sending thirty is how an app gets its notifications switched off.
//
// The honest limit worth naming: a flip is a model output, and the model's
// measured hit rate is barely distinguishable from chance. These are alerts
// that something changed, not advice that something will happen, and the copy
// says so.

import { getMessaging } from 'firebase-admin/messaging';

type Firestore = import('firebase-admin/firestore').Firestore;

/** Where the previous run's directions live, to diff against. */
const LAST = 'ops/last_directions';

export type CoinDirection = { sym: string; up: boolean };

export type NotifyResult = {
  flipped: string[];
  /** Users who had a watchlist hit and a token. */
  targeted: number;
  sent: number;
  /** Tokens FCM rejected as dead; removed from the user document. */
  pruned: number;
};

/**
 * Index of the signal-flip switch inside the persisted alerts array.
 *
 * The array is positional and shared with the app, where indices have never
 * been renumbered precisely so an existing install's stored preferences keep
 * meaning what they meant. Index 1 has always been the flip alert.
 */
const FLIP_ALERT_INDEX = 1;

/** Which coins changed direction since the previous run. */
export function flips(
  previous: Record<string, boolean>,
  current: CoinDirection[],
): string[] {
  const out: string[] = [];
  for (const c of current) {
    const was = previous[c.sym];
    // An unknown coin is not a flip. A new listing, or the first run after
    // deploy, would otherwise notify everybody about everything.
    if (typeof was !== 'boolean') continue;
    if (was !== c.up) out.push(c.sym);
  }
  return out;
}

/** One line, whatever the market did. */
export function flipMessage(
  flipped: string[],
  directions: Record<string, boolean>,
): { title: string; body: string } {
  if (flipped.length === 1) {
    const sym = flipped[0]!;
    return {
      title: `${sym} signal flipped`,
      body: `VANE now reads ${sym} as ${directions[sym] ? 'up' : 'down'}. Signals are often wrong.`,
    };
  }
  const head = flipped.slice(0, 3).join(', ');
  const rest = flipped.length - 3;
  return {
    title: `${flipped.length} signals flipped`,
    body: `${head}${rest > 0 ? ` and ${rest} more` : ''} changed direction. Signals are often wrong.`,
  };
}

/**
 * Send a flip notification to everyone watching an affected coin.
 *
 * Reads users rather than querying by watchlist: Firestore cannot index
 * "array contains any of these thirty values" cheaply, and at this scale a
 * scan of the user collection is a handful of reads. It will need revisiting
 * well before it is a problem — around a few thousand users — and the cap
 * below makes the ceiling visible rather than silent.
 */
export async function notifyFlips(
  db: Firestore,
  coins: CoinDirection[],
  maxUsers = 2000,
): Promise<NotifyResult> {
  const out: NotifyResult = { flipped: [], targeted: 0, sent: 0, pruned: 0 };

  const lastRef = db.doc(LAST);
  const lastSnap = await lastRef.get();
  const previous = (lastSnap.exists ? lastSnap.data() : {}) as Record<string, boolean>;

  const directions: Record<string, boolean> = {};
  for (const c of coins) directions[c.sym] = c.up;

  // Record the new state FIRST. If sending throws halfway, the next run must
  // not re-diff against a stale snapshot and notify the same flip twice.
  await lastRef.set(directions);

  out.flipped = flips(previous, coins);
  if (out.flipped.length === 0) return out;

  const flippedSet = new Set(out.flipped);
  const { title, body } = flipMessage(out.flipped, directions);

  const users = await db.collection('users').limit(maxUsers).get();
  const targets: { uid: string; token: string }[] = [];

  for (const doc of users.docs) {
    const d = doc.data() as { fcmToken?: string; watchlist?: unknown };
    if (!d.fcmToken) continue;
    const watch = Array.isArray(d.watchlist) ? d.watchlist : [];
    if (!watch.some((s) => typeof s === 'string' && flippedSet.has(s))) continue;
    targets.push({ uid: doc.id, token: d.fcmToken });
  }

  out.targeted = targets.length;
  if (targets.length === 0) return out;

  const messaging = getMessaging();
  // Batches of 500, which is the multicast ceiling.
  for (let i = 0; i < targets.length; i += 500) {
    const page = targets.slice(i, i + 500);
    const res = await messaging.sendEachForMulticast({
      tokens: page.map((t) => t.token),
      notification: { title, body },
      // Also sent as data so the in-app handler can render it while the app
      // is open — the OS does not draw a notification for a foregrounded app.
      data: { title, body, kind: 'flip', coins: out.flipped.join(',') },
    });

    out.sent += res.successCount;

    // A token FCM calls unregistered belongs to an app that was deleted.
    // Leaving it costs a failed send on every future notification.
    const dead: string[] = [];
    res.responses.forEach((r, j) => {
      const code = (r.error as { code?: string } | undefined)?.code ?? '';
      if (/registration-token-not-registered|invalid-argument/.test(code)) {
        dead.push(page[j]!.uid);
      }
    });
    for (const uid of dead) {
      await db.doc(`users/${uid}`).update({ fcmToken: '' }).catch(() => {});
      out.pruned += 1;
    }
  }

  return out;
}

export { FLIP_ALERT_INDEX };
