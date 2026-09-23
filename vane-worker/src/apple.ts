// Apple's App Store Server API, and the shape of what it returns.
//
// This is the modern replacement for /verifyReceipt, which is deprecated and
// requires parsing an encrypted receipt blob. Here a transaction id is looked
// up directly and the answer comes back as a signed JWS.

import { appleJwt, decodeJws, verifyJwsSignature } from './jwt.ts';

export type Environment = 'Sandbox' | 'Production';

/** The fields of a JWSTransaction that entitlement actually depends on. */
export type TransactionInfo = {
  transactionId: string;
  originalTransactionId: string;
  productId: string;
  bundleId: string;
  /** Milliseconds since epoch. Absent for a non-renewing product. */
  expiresDate?: number;
  purchaseDate: number;
  /** Set only when the purchase has been refunded or revoked. */
  revocationDate?: number;
  environment: Environment;
  type?: string;
};

export type AppleConfig = {
  keyId: string;
  issuerId: string;
  privateKeyPem: string;
  bundleId: string;
};

const HOSTS: Record<Environment, string> = {
  Production: 'https://api.storekit.itunes.apple.com',
  Sandbox: 'https://api.storekit-sandbox.itunes.apple.com',
};

/** Cached bearer, since Apple accepts a token for up to an hour. */
let token: { value: string; expiresAt: number } | null = null;

async function bearer(cfg: AppleConfig): Promise<string> {
  const now = Date.now();
  if (token && token.expiresAt > now + 60_000) return token.value;
  const value = await appleJwt({
    keyId: cfg.keyId,
    issuerId: cfg.issuerId,
    privateKeyPem: cfg.privateKeyPem,
    bundleId: cfg.bundleId,
  });
  token = { value, expiresAt: now + 25 * 60_000 };
  return value;
}

/**
 * Look up one transaction.
 *
 * Production is tried first and Sandbox second. This ordering is not cosmetic:
 * a TestFlight or sandbox purchase does not exist in production and returns
 * 404, and a production purchase is not in sandbox. Checking only one
 * environment means either real buyers or every tester silently fails.
 */
export async function getTransaction(
  cfg: AppleConfig,
  transactionId: string,
): Promise<TransactionInfo | null> {
  for (const env of ['Production', 'Sandbox'] as Environment[]) {
    const res = await fetch(`${HOSTS[env]}/inApps/v1/transactions/${transactionId}`, {
      headers: { Authorization: `Bearer ${await bearer(cfg)}` },
    });
    if (res.status === 404) continue;
    if (!res.ok) throw new Error(`apple ${env} ${res.status}: ${await res.text()}`);

    const { signedTransactionInfo } = (await res.json()) as { signedTransactionInfo: string };
    // Apple signed this, and we check that signature rather than trusting the
    // payload — the whole point of server validation is that the device's
    // claim is not evidence.
    if (!(await verifyJwsSignature(signedTransactionInfo))) {
      throw new Error('transaction signature failed verification');
    }
    return decodeJws<TransactionInfo>(signedTransactionInfo).payload;
  }
  return null;
}

/**
 * Decide what a transaction means for access.
 *
 * Three things can end a subscription and all of them must be honoured, or a
 * refunded user keeps the product they were paid back for:
 *   - the expiry passing
 *   - a revocation (refund, family-sharing removal)
 *   - the product not being one we sell
 */
export function entitlementFrom(
  tx: TransactionInfo,
  allowedProductIds: readonly string[],
  bundleId: string,
  now = Date.now(),
): { active: boolean; expiresAt: Date; reason: string } {
  if (tx.bundleId !== bundleId) {
    return { active: false, expiresAt: new Date(0), reason: 'bundle mismatch' };
  }
  if (!allowedProductIds.includes(tx.productId)) {
    return { active: false, expiresAt: new Date(0), reason: 'unknown product' };
  }
  if (tx.revocationDate) {
    return { active: false, expiresAt: new Date(tx.revocationDate), reason: 'revoked' };
  }
  if (!tx.expiresDate) {
    return { active: false, expiresAt: new Date(0), reason: 'not a subscription' };
  }
  if (tx.expiresDate <= now) {
    return { active: false, expiresAt: new Date(tx.expiresDate), reason: 'expired' };
  }
  return { active: true, expiresAt: new Date(tx.expiresDate), reason: 'active' };
}
