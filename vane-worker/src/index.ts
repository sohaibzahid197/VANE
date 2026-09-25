// VANE entitlement service.
//
// Two endpoints:
//   POST /validate            the app hands over a transaction after a purchase
//   POST /apple-notifications Apple pushes subscription lifecycle events
//
// Everything this service exists for comes down to one rule: the device's
// claim is never evidence. /validate takes a transaction ID, asks Apple what
// it actually is, and writes the answer to a Firestore document the client
// cannot write. The security rules read that document, so a lapsed or
// refunded subscriber loses access without anything having to run on
// their phone.

import {
  type AppleConfig,
  type Environment,
  entitlementFrom,
  getSubscriptionStatus,
  getTransaction,
} from './apple.ts';
import { decodeJws, verifyJwsSignature } from './jwt.ts';
import {
  linkTransaction,
  readEntitlement,
  uidForTransaction,
  uidFromIdToken,
  writeEntitlement,
} from './firestore.ts';

export const PRODUCT_IDS = [
  'com.vane.app.pro.weekly',
  'com.vane.app.pro.monthly',
  'com.vane.app.pro.yearly',
] as const;

export type Env = {
  BUNDLE_ID: string;
  FIREBASE_PROJECT_ID: string;
  FIREBASE_API_KEY: string;
  FIREBASE_SERVICE_ACCOUNT: string;
  APPLE_KEY_ID: string;
  APPLE_ISSUER_ID: string;
  APPLE_PRIVATE_KEY: string;
  /**
   * Which store environments this deployment honours, comma separated.
   *
   * Both, by default, and that is a deliberate reversal. Refusing Sandbox
   * looked prudent and was in fact a launch blocker: TestFlight purchases are
   * Sandbox, and so are App Review's. Every tester and every reviewer would
   * have bought successfully, been refused by this service, and been shown a
   * message blaming their network — a guideline 3.1.1 rejection produced by
   * our own defence.
   *
   * The risk it was guarding against is small. A Sandbox purchase requires a
   * Sandbox Apple Account, and those exist only where the developer creates
   * them in App Store Connect; a member of the public cannot make one. The
   * environment is recorded on the entitlement either way, so a Sandbox grant
   * is always identifiable after the fact.
   */
  ALLOWED_ENVIRONMENT: string;
};

/**
 * Per-uid throttle for /validate.
 *
 * Every call costs up to two App Store Server API requests plus two Firestore
 * writes, and anyone can mint a Firebase anonymous token, so an unthrottled
 * endpoint lets one attacker burn the Apple API quota that real purchases
 * depend on. A purchase is a once-per-period event; a handful of attempts is
 * generous.
 *
 * Isolate-local, deliberately: a Durable Object or KV would be exact but adds
 * a binding and a round trip, and this only has to stop a flood from being
 * free. It degrades to "per isolate" under load, which is still a ceiling.
 */
const RATE_LIMIT = { max: 10, windowMs: 60_000 };
const hits = new Map<string, number[]>();

function rateLimited(uid: string): boolean {
  const now = Date.now();
  const recent = (hits.get(uid) ?? []).filter((t) => now - t < RATE_LIMIT.windowMs);
  recent.push(now);
  hits.set(uid, recent);
  // Unbounded growth is its own denial of service; drop cold entries.
  if (hits.size > 5000) {
    for (const [k, v] of hits) {
      if (v.length === 0 || now - v[v.length - 1]! > RATE_LIMIT.windowMs) hits.delete(k);
    }
  }
  return recent.length > RATE_LIMIT.max;
}

/** Both environments unless the deployment narrows it. */
function environmentAllowed(env: Env, seen: Environment): boolean {
  const allowed = (env.ALLOWED_ENVIRONMENT ?? 'Production,Sandbox')
    .split(',')
    .map((s) => s.trim());
  return allowed.includes(seen);
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const config = (env: Env): { apple: AppleConfig; db: any } => ({
  apple: {
    keyId: env.APPLE_KEY_ID,
    issuerId: env.APPLE_ISSUER_ID,
    privateKeyPem: env.APPLE_PRIVATE_KEY,
    bundleId: env.BUNDLE_ID,
  },
  db: {
    projectId: env.FIREBASE_PROJECT_ID,
    serviceAccount: JSON.parse(env.FIREBASE_SERVICE_ACCOUNT),
  },
});

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);

    try {
      if (url.pathname === '/validate') return await validate(request, env);
      if (url.pathname === '/apple-notifications') return await notify(request, env);
      return json({ error: 'not found' }, 404);
    } catch (e) {
      // Never leak internals to a caller, but do surface the failure in logs.
      console.error('unhandled', e);
      return json({ error: 'internal error' }, 500);
    }
  },
};

/**
 * Grant entitlement for a purchase the app just made.
 *
 * The uid comes from the Firebase ID token, NOT from the request body. If the
 * body could name a uid, any caller could entitle any account.
 */
async function validate(request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get('Authorization') ?? '';
  const idToken = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!idToken) return json({ error: 'missing token' }, 401);

  const uid = await uidFromIdToken(env.FIREBASE_API_KEY, idToken);
  if (!uid) return json({ error: 'invalid token' }, 401);

  if (rateLimited(uid)) return json({ error: 'too many requests' }, 429);

  const body = (await request.json().catch(() => null)) as { transactionId?: unknown } | null;
  const transactionId = body?.transactionId;
  // Validated, not merely declared. The type said string and nothing checked
  // it, so an array, a 10,000-character string or a URL-encoded query broke
  // the Apple request URL and surfaced as a generic 500 — after a pointless
  // round trip to Apple. StoreKit transaction ids are short decimal numbers.
  if (typeof transactionId !== 'string' || !/^[0-9]{1,32}$/.test(transactionId)) {
    return json({ error: 'missing transactionId' }, 400);
  }

  const { apple, db } = config(env);
  const tx = await getTransaction(apple, transactionId);
  if (!tx) return json({ error: 'unknown transaction' }, 404);

  if (!environmentAllowed(env, tx.environment)) {
    return json({ error: 'wrong environment' }, 403);
  }

  // The transaction to user link is WRITE-ONCE.
  //
  // Nothing proves the caller owns this transaction — Apple's response is
  // identical whoever asks. Without this check, one real purchase entitles
  // unlimited accounts: each attacker posts the same transaction id under
  // their own token and Apple confirms it is genuine and active every time.
  // It also hijacked the webhook route, because the last writer owned the
  // link, so the real buyer's renewals and refunds landed on the attacker.
  const owner = await uidForTransaction(db, tx.originalTransactionId);
  if (owner && owner !== uid) {
    return json({ error: 'transaction belongs to another account' }, 409);
  }
  if (!owner) await linkTransaction(db, tx.originalTransactionId, uid);

  const verdict = entitlementFrom(tx, PRODUCT_IDS, env.BUNDLE_ID);

  // An OLD transaction must not revoke a NEWER subscription.
  //
  // A purchase whose validation once failed is deliberately left unfinished,
  // so the app retries it on every launch — forever. If the user later
  // re-subscribed, that stale transaction now reports itself expired, and
  // writing its verdict unconditionally overwrote a live entitlement with
  // active:false. The user paid, and lost Pro at every cold start. `notify`
  // has had this guard since it was written; `validate` did not.
  const current = await readEntitlement(db, uid);
  const eventAt = new Date(tx.purchaseDate);
  if (!verdict.active && current && current.updatedAt > eventAt) {
    return json({
      active: false,
      superseded: true,
      expiresAt: verdict.expiresAt.toISOString(),
    });
  }

  await writeEntitlement(db, uid, {
    active: verdict.active,
    productId: tx.productId,
    expiresAt: verdict.expiresAt,
    originalTransactionId: tx.originalTransactionId,
    environment: tx.environment,
    // Apple's clock, not ours. Stamping local wall-clock here made a
    // legitimate REFUND webhook — signed seconds earlier — look stale and get
    // dropped, so a refunded user kept access for the rest of the term.
    updatedAt: eventAt,
  });

  return json({ active: verdict.active, expiresAt: verdict.expiresAt.toISOString() });
}

type NotificationPayload = {
  notificationType: string;
  subtype?: string;
  notificationUUID: string;
  signedDate: number;
  data?: { signedTransactionInfo?: string; signedRenewalInfo?: string };
};

/**
 * App Store Server Notifications V2.
 *
 * THE PAYLOAD IS NOT TRUSTED. It is a hint, nothing more.
 *
 * This endpoint is public — Apple cannot present a bearer token — so the
 * obvious design is to authenticate the request by verifying the JWS. That is
 * what this used to do, and it was worthless: the signature was checked
 * against the certificate carried in the token's own x5c header, with no
 * chain to Apple's root. Anyone could self-sign a certificate, sign a payload
 * with it, and have it accepted. A single unauthenticated POST could set any
 * linked account's expiry to the year 2100 — and because the forged
 * signedDate then beat every real event, Apple's own REFUND and EXPIRED
 * notifications would be dropped as stale forever after.
 *
 * Verifying the chain properly would fix that, and it is still worth doing.
 * But it is not what this code relies on. Instead the notification is used
 * only to learn WHICH subscription changed; the actual state is then fetched
 * from Apple over TLS, authenticated with our own private key. A forged
 * notification now buys an attacker nothing: the worst it can do is make us
 * re-read the true state of a subscription.
 */
async function notify(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { signedPayload?: string } | null;
  const signed = body?.signedPayload;
  if (!signed) return json({ error: 'missing signedPayload' }, 400);

  // Cheap pre-filter, not authorization. A malformed token is rejected here so
  // it never costs us an Apple API call; a well-formed forgery gets through
  // this check by design and is defeated by the authoritative fetch below.
  let payload: NotificationPayload;
  try {
    payload = decodeJws<NotificationPayload>(signed).payload;
  } catch {
    return json({ error: 'malformed payload' }, 400);
  }

  const hinted = payload.data?.signedTransactionInfo;
  if (!hinted) return json({ ok: true, ignored: payload.notificationType });

  let originalTransactionId: string;
  try {
    originalTransactionId = decodeJws<{ originalTransactionId: string }>(hinted).payload
      .originalTransactionId;
  } catch {
    return json({ error: 'malformed transaction' }, 400);
  }
  if (!originalTransactionId) return json({ error: 'missing transaction id' }, 400);

  const { apple, db } = config(env);

  // An unknown subscription cannot be acted on, and no retry will change that
  // — the link is created by /validate. A non-2xx would make Apple retry for
  // hours over something only the app can fix.
  const uid = await uidForTransaction(db, originalTransactionId);
  if (!uid) {
    console.warn('unlinked subscription', originalTransactionId, payload.notificationType);
    return json({ ok: true, unlinked: true });
  }

  // THE AUTHORITATIVE READ. Everything above this line is attacker-controlled.
  const tx = await getSubscriptionStatus(apple, originalTransactionId);
  if (!tx) return json({ ok: true, unknown: true });

  if (!environmentAllowed(env, tx.environment)) {
    return json({ ok: true, ignoredEnvironment: tx.environment });
  }

  // Ordering is on Apple's clock for both writers, so a webhook can no longer
  // be discarded merely because /validate ran a moment later on ours. The
  // comparison is scoped to this subscription: a user may hold more than one,
  // and one subscription's events must not gate another's.
  const current = await readEntitlement(db, uid);
  const eventAt = new Date(tx.purchaseDate);
  if (
    current &&
    current.originalTransactionId === originalTransactionId &&
    current.updatedAt > eventAt
  ) {
    return json({ ok: true, stale: true });
  }

  const verdict = entitlementFrom(tx, PRODUCT_IDS, env.BUNDLE_ID);
  await writeEntitlement(db, uid, {
    active: verdict.active,
    productId: tx.productId,
    expiresAt: verdict.expiresAt,
    originalTransactionId: tx.originalTransactionId,
    environment: tx.environment,
    updatedAt: eventAt,
  });

  return json({ ok: true, type: payload.notificationType, active: verdict.active });
}
