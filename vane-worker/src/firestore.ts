// Firestore REST, from a Worker.
//
// firebase-admin does not run here (no Node runtime, and the Worker bundle
// budget would not take it), so the entitlement document is written over REST
// with an OAuth token minted from the service account. The service account
// bypasses security rules, which is exactly why the rules can say
// `allow write: if false` on the entitlement path.

import { googleAccessToken } from './jwt.ts';

export type Entitlement = {
  active: boolean;
  productId: string;
  /** When access ends. The security rules compare this against request.time. */
  expiresAt: Date;
  originalTransactionId: string;
  environment: 'Sandbox' | 'Production';
  /** Apple's signedDate for the event that produced this state. */
  updatedAt: Date;
};

type ServiceAccount = { client_email: string; private_key: string };

/**
 * Cached access token.
 *
 * Google's tokens last an hour. Minting one per request would add an RSA sign
 * and a round trip to every validation, and Apple's webhook retries can arrive
 * in bursts. Module scope persists across requests on a warm isolate and is
 * simply re-derived on a cold one.
 */
let cached: { token: string; expiresAt: number } | null = null;

async function accessToken(sa: ServiceAccount): Promise<string> {
  const now = Date.now();
  // Refresh a minute early so a token cannot expire mid-flight.
  if (cached && cached.expiresAt > now + 60_000) return cached.token;
  const token = await googleAccessToken(sa);
  cached = { token, expiresAt: now + 55 * 60_000 };
  return token;
}

const docUrl = (projectId: string, path: string) =>
  `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${path}`;

/**
 * Write users/{uid}/entitlement/current.
 *
 * The document id is always `current` because the security rules read that
 * exact path — writing any other id silently grants nothing.
 */
export async function writeEntitlement(
  opts: { projectId: string; serviceAccount: ServiceAccount },
  uid: string,
  e: Entitlement,
): Promise<void> {
  const token = await accessToken(opts.serviceAccount);
  const res = await fetch(docUrl(opts.projectId, `users/${uid}/entitlement/current`), {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      fields: {
        active: { booleanValue: e.active },
        productId: { stringValue: e.productId },
        expiresAt: { timestampValue: e.expiresAt.toISOString() },
        originalTransactionId: { stringValue: e.originalTransactionId },
        environment: { stringValue: e.environment },
        updatedAt: { timestampValue: e.updatedAt.toISOString() },
      },
    }),
  });
  if (!res.ok) throw new Error(`firestore write ${res.status}: ${await res.text()}`);
}

export async function readEntitlement(
  opts: { projectId: string; serviceAccount: ServiceAccount },
  uid: string,
): Promise<{ updatedAt: Date; originalTransactionId: string } | null> {
  const token = await accessToken(opts.serviceAccount);
  const res = await fetch(docUrl(opts.projectId, `users/${uid}/entitlement/current`), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`firestore read ${res.status}`);
  const body = (await res.json()) as any;
  const f = body?.fields ?? {};
  return {
    updatedAt: new Date(f.updatedAt?.timestampValue ?? 0),
    originalTransactionId: String(f.originalTransactionId?.stringValue ?? ''),
  };
}

/**
 * Find the uid that owns a subscription, for webhook events.
 *
 * Apple's notifications identify a subscription, never a user — the link
 * between the two exists only because /validate recorded it. Without this
 * index a renewal or a refund cannot be applied to anybody.
 */
export async function uidForTransaction(
  opts: { projectId: string; serviceAccount: ServiceAccount },
  originalTransactionId: string,
): Promise<string | null> {
  const token = await accessToken(opts.serviceAccount);
  const res = await fetch(docUrl(opts.projectId, `subscriptions/${originalTransactionId}`), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const body = (await res.json()) as any;
  return body?.fields?.uid?.stringValue ?? null;
}

/** Record which user owns a subscription, so webhooks can find them later. */
export async function linkTransaction(
  opts: { projectId: string; serviceAccount: ServiceAccount },
  originalTransactionId: string,
  uid: string,
): Promise<void> {
  const token = await accessToken(opts.serviceAccount);
  const res = await fetch(docUrl(opts.projectId, `subscriptions/${originalTransactionId}`), {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields: {
        uid: { stringValue: uid },
        linkedAt: { timestampValue: new Date().toISOString() },
      },
    }),
  });
  if (!res.ok) throw new Error(`firestore link ${res.status}: ${await res.text()}`);
}

/**
 * Verify a Firebase ID token and return its uid.
 *
 * Uses the Identity Toolkit lookup endpoint rather than verifying the RS256
 * signature locally: it is one call, it checks revocation, and it removes the
 * need to fetch and cache Google's rotating public keys in the Worker. The
 * uid must come from the token, never from the request body — otherwise any
 * caller could name someone else's uid and entitle them, or themselves.
 */
export async function uidFromIdToken(apiKey: string, token: string): Promise<string | null> {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: token }),
    },
  );
  if (!res.ok) return null;
  const body = (await res.json()) as { users?: Array<{ localId?: string }> };
  return body.users?.[0]?.localId ?? null;
}
