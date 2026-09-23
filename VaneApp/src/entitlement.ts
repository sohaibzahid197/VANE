// Entitlement: what the SERVER says about this user's subscription.
//
// The device's own `isPro` boolean is a cache for offline launches, nothing
// more. It used to be the only gate, which meant one AsyncStorage edit bought
// a permanent subscription — and, just as costly, nothing ever set it back to
// false, so a lapsed or refunded subscriber stayed Pro forever.
//
// The authority is users/{uid}/entitlement/current, which the security rules
// make server-write-only and which the same rules consult when deciding
// whether to serve the paid signals document.

import { appCheckHeader } from './appCheck.ts';
import { idToken } from './firebase.ts';
import { FIREBASE_PROJECT_ID } from './firebaseConfig.ts';

/**
 * Where the receipt validator lives.
 *
 * This must stay in step with the deployed Worker. If it ever points at a
 * host that does not resolve, every purchase and every restore fails
 * silently — validatePurchase catches the network error and returns null, so
 * the user is charged and never entitled, with nothing logged anywhere.
 */
export const VALIDATE_URL = 'https://vane-entitlement.letsdev-sohaib.workers.dev/validate';

/** A stalled request must not hang the paywall; RN's fetch has no timeout. */
const TIMEOUT_MS = 12_000;

function withTimeout(): { signal: AbortSignal; done: () => void } {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  return { signal: ctl.signal, done: () => clearTimeout(timer) };
}

const DOC = (uid: string) =>
  `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}` +
  `/databases/(default)/documents/users/${uid}/entitlement/current`;

export type Entitlement = { active: boolean; expiresAt: number };

const EXPIRED: Entitlement = { active: false, expiresAt: 0 };

/**
 * Read entitlement from Firestore.
 *
 * Returns null — meaning "don't know" — when the network fails, so the caller
 * can keep the cached value rather than logging a paying user out on a train.
 * An explicit 404 is a real answer: no document means never subscribed.
 */
export async function fetchEntitlement(uid: string): Promise<Entitlement | null> {
  try {
    const token = await idToken();
    if (!token) return null;
    const t = withTimeout();
    let res: Response;
    try {
      res = await fetch(DOC(uid), {
        signal: t.signal,
        headers: { ...(await appCheckHeader()), Authorization: `Bearer ${token}` },
      });
    } finally {
      t.done();
    }
    // 404 is a real answer from an authenticated owner: the rules allow the
    // read regardless of existence, so a missing document means never
    // subscribed. Anything else — including a 403 from a failed App Check
    // attestation — is "don't know", and the cached value stands.
    if (res.status === 404) return EXPIRED;
    if (!res.ok) return null;

    const body = (await res.json()) as any;
    const f = body?.fields ?? {};
    const active = f.active?.booleanValue === true;
    const expiresAt = Date.parse(f.expiresAt?.timestampValue ?? '') || 0;

    // Trust the expiry over the flag. The rules compare expiresAt against
    // server time, so a document whose flag says active but whose expiry has
    // passed would show a Pro UI over a 403.
    if (!active || expiresAt <= Date.now()) return EXPIRED;
    return { active: true, expiresAt };
  } catch {
    return null;
  }
}

/**
 * Hand a completed purchase to the validator and get the verdict back.
 *
 * Returns null when the server could not be reached. The caller must NOT
 * treat that as a grant — but it must also not finish the StoreKit
 * transaction, so the purchase stays in the queue and can be replayed.
 */
export async function validatePurchase(transactionId: string): Promise<Entitlement | null> {
  try {
    const token = await idToken();
    if (!token) return null;
    const t = withTimeout();
    let res: Response;
    try {
      res = await fetch(VALIDATE_URL, {
      signal: t.signal,
      method: 'POST',
      headers: {
        ...(await appCheckHeader()),
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ transactionId }),
      });
    } finally {
      t.done();
    }
    if (!res.ok) return null;
    const body = (await res.json()) as { active?: boolean; expiresAt?: string };
    return {
      active: body.active === true,
      expiresAt: Date.parse(body.expiresAt ?? '') || 0,
    };
  } catch {
    return null;
  }
}
