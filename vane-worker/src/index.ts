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

import { type AppleConfig, entitlementFrom, getTransaction } from './apple.ts';
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
};

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

  const body = (await request.json().catch(() => null)) as { transactionId?: string } | null;
  const transactionId = body?.transactionId;
  if (!transactionId) return json({ error: 'missing transactionId' }, 400);

  const { apple, db } = config(env);
  const tx = await getTransaction(apple, transactionId);
  if (!tx) return json({ error: 'unknown transaction' }, 404);

  const verdict = entitlementFrom(tx, PRODUCT_IDS, env.BUNDLE_ID);

  // Record the owner even when the verdict is negative: a subscription that
  // has lapsed can be renewed later, and the webhook that tells us so carries
  // only the transaction, never the user.
  await linkTransaction(db, tx.originalTransactionId, uid);
  await writeEntitlement(db, uid, {
    active: verdict.active,
    productId: tx.productId,
    expiresAt: verdict.expiresAt,
    originalTransactionId: tx.originalTransactionId,
    environment: tx.environment,
    updatedAt: new Date(),
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
 * This endpoint is public — Apple cannot present a bearer token — so the JWS
 * signature IS the authentication. An unverified webhook would let anyone
 * grant themselves a subscription by POSTing a JSON body.
 */
async function notify(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { signedPayload?: string } | null;
  const signed = body?.signedPayload;
  if (!signed) return json({ error: 'missing signedPayload' }, 400);

  if (!(await verifyJwsSignature(signed))) {
    return json({ error: 'signature verification failed' }, 401);
  }

  const payload = decodeJws<NotificationPayload>(signed).payload;
  const signedTx = payload.data?.signedTransactionInfo;
  if (!signedTx) return json({ ok: true, ignored: payload.notificationType });
  if (!(await verifyJwsSignature(signedTx))) {
    return json({ error: 'transaction signature failed' }, 401);
  }

  const tx = decodeJws<import('./apple.ts').TransactionInfo>(signedTx).payload;
  const { db } = config(env);

  const uid = await uidForTransaction(db, tx.originalTransactionId);
  if (!uid) {
    // A renewal for a subscription we never saw validated. Acknowledge it —
    // returning non-2xx makes Apple retry for hours over something no retry
    // can fix — and rely on the app calling /validate when it next launches.
    console.warn('no uid for transaction', tx.originalTransactionId, payload.notificationType);
    return json({ ok: true, unlinked: true });
  }

  // Apple retries, and retries can arrive out of order. Applying an older
  // event over a newer one would resurrect a subscription that has since been
  // refunded, so anything not strictly newer is dropped.
  const current = await readEntitlement(db, uid);
  const eventAt = new Date(payload.signedDate);
  if (current && current.updatedAt >= eventAt) {
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
