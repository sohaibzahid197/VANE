// In-app purchases.
//
// ENTITLEMENT IS NOT DECIDED HERE. This module talks to StoreKit: it lists
// products, starts a purchase, and hands the resulting transaction to the
// server. Whether a user is Pro is decided by the receipt validator and read
// from `users/{uid}/entitlement`, which the security rules make server-write
// only.
//
// That split is the whole point. A local `isPro` boolean — which is what this
// app had — is one AsyncStorage edit away from free Pro on any rooted device.
//
// Prices are never hardcoded. StoreKit returns the localized price for the
// user's storefront; showing "$79.99" to someone billed in rupees is both
// wrong and an App Store guideline 3.1.2 problem.

import {
  endConnection,
  fetchProducts,
  finishTransaction,
  getAvailablePurchases,
  initConnection,
  purchaseErrorListener,
  purchaseUpdatedListener,
  requestPurchase,
} from 'react-native-iap';
import { ALL_PRODUCT_IDS, PRODUCT_IDS, type PlanId } from './products.ts';

/** What the paywall needs to render one plan. */
export type PlanOffer = {
  plan: PlanId;
  productId: string;
  /** Localized, store-formatted price string, e.g. "£64.99". */
  price: string;
  /** Raw amount, for the per-month comparison line. */
  amount: number;
  currency: string;
};

let connected: Promise<boolean> | null = null;

/** Open the StoreKit connection once. */
export function connect(): Promise<boolean> {
  if (connected) return connected;
  connected = initConnection()
    .then(() => true)
    .catch(() => {
      connected = null;
      return false;
    });
  return connected;
}

export async function disconnect(): Promise<void> {
  connected = null;
  try {
    await endConnection();
  } catch {
    // Already closed.
  }
}

const planOf = (productId: string): PlanId | null => {
  for (const [plan, id] of Object.entries(PRODUCT_IDS)) {
    if (id === productId) return plan as PlanId;
  }
  return null;
};

/**
 * Load the three subscriptions from the store.
 *
 * Returns [] when products are missing or incomplete in App Store Connect —
 * a product without a price and a localization is simply not returned, which
 * is the single most confusing failure in this whole flow. The paywall must
 * treat an empty list as "cannot sell right now" rather than rendering an
 * empty page.
 */
export async function loadOffers(): Promise<PlanOffer[]> {
  if (!(await connect())) return [];

  try {
    const products = (await fetchProducts({
      skus: ALL_PRODUCT_IDS,
      type: 'subs',
    })) as any[];

    const offers: PlanOffer[] = [];
    for (const p of products ?? []) {
      const productId: string = p?.id ?? p?.productId ?? '';
      const plan = planOf(productId);
      if (!plan) continue;

      offers.push({
        plan,
        productId,
        price: String(p?.displayPrice ?? p?.localizedPrice ?? ''),
        amount: Number(p?.price ?? 0),
        currency: String(p?.currency ?? p?.currencyCode ?? ''),
      });
    }
    return offers;
  } catch {
    return [];
  }
}

export type PurchaseOutcome =
  | { status: 'purchased'; transaction: unknown }
  | { status: 'cancelled' }
  | { status: 'failed'; reason: string };

/**
 * Start a purchase and resolve when StoreKit reports an outcome.
 *
 * The transaction is deliberately NOT finished here — it is finished only
 * after the server has validated it. Finishing early means a failed
 * validation leaves the user charged with no entitlement and no retry, because
 * the transaction is gone from the queue.
 */
export function buy(plan: PlanId): Promise<PurchaseOutcome> {
  const sku = PRODUCT_IDS[plan];

  return new Promise<PurchaseOutcome>((resolve) => {
    let settled = false;
    const done = (r: PurchaseOutcome) => {
      if (settled) return;
      settled = true;
      offUpdate?.remove?.();
      offError?.remove?.();
      resolve(r);
    };

    const offUpdate = purchaseUpdatedListener((purchase: any) => {
      const id = purchase?.id ?? purchase?.productId;
      if (id && id !== sku) return;
      done({ status: 'purchased', transaction: purchase });
    });

    const offError = purchaseErrorListener((err: any) => {
      const code = String(err?.code ?? '');
      if (/cancel/i.test(code)) return done({ status: 'cancelled' });
      done({ status: 'failed', reason: err?.message ?? 'Purchase failed.' });
    });

    void (async () => {
      if (!(await connect())) {
        done({ status: 'failed', reason: 'Store unavailable.' });
        return;
      }
      await requestPurchase({
        request: { ios: { sku }, android: { skus: [sku] } },
        type: 'subs',
      } as any);
    })()
      .catch((e: any) => {
        const code = String(e?.code ?? '');
        if (/cancel/i.test(code)) return done({ status: 'cancelled' });
        done({ status: 'failed', reason: e?.message ?? 'Purchase failed.' });
      });
  });
}

/**
 * Finish a transaction. Call ONLY after the server has granted entitlement.
 * An unfinished transaction is replayed by StoreKit on next launch, which is
 * the recovery path if validation fails.
 */
export async function complete(transaction: unknown): Promise<void> {
  try {
    await finishTransaction({ purchase: transaction as any, isConsumable: false });
  } catch {
    // Already finished, or the queue moved on. Not fatal.
  }
}

/**
 * Restore purchases.
 *
 * Required by App Store guideline 3.1.1 — an app selling subscriptions with
 * no working restore is rejected, and this was a stub alert until now.
 * Returns the transactions found so the caller can re-validate them server
 * side; an empty list genuinely means "nothing to restore".
 */
export async function restore(): Promise<unknown[]> {
  if (!(await connect())) return [];
  try {
    const purchases = (await getAvailablePurchases()) as unknown[];
    return purchases ?? [];
  } catch {
    return [];
  }
}
