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
  getPendingTransactionsIOS,
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

/**
 * True while buy() owns the outcome.
 *
 * Both this module's per-purchase listener and the app-level recovery
 * listener receive the same native event, so without this every live purchase
 * was validated twice and finished twice, racing each other.
 */
let purchaseInFlight = false;

/**
 * The transaction identifier Apple's API expects.
 *
 * On iOS `id` and `transactionId` are both StoreKit's Transaction.id. On
 * Android they are NOT interchangeable: react-native-iap sets `id` to the
 * purchaseToken when Play has no orderId, and deliberately leaves
 * `transactionId` null in that case. Reading `id` first therefore sends a
 * purchase token where a transaction id belongs.
 */
export function transactionIdOf(purchase: unknown): string {
  const p = purchase as any;
  return String(p?.transactionId ?? p?.id ?? '');
}

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
    let grace: ReturnType<typeof setTimeout> | undefined;

    const settle = (r: PurchaseOutcome) => {
      if (settled) return;
      settled = true;
      purchaseInFlight = false;
      if (grace) clearTimeout(grace);
      offUpdate?.remove?.();
      offError?.remove?.();
      resolve(r);
    };

    // dedupeTransactionIOS: false is the whole reason this works.
    //
    // The native layer records each transaction id as "delivered" once per
    // connection, across every JS listener. A transaction replayed at launch
    // — which is exactly what an unfinished purchase is — burns that record,
    // so a later requestPurchase for the same SKU emits NOTHING to a deduping
    // listener: no purchase event, no error, no throw. The promise then never
    // settled and the Subscribe button read "Please wait…" forever.
    const offUpdate = purchaseUpdatedListener(
      (purchase: any) => {
        // `productId` is the SKU. `id` is the TRANSACTION id and is always
        // present, so reading `id` first meant this comparison was always true
        // and every purchase event was discarded.
        if (purchase?.productId !== sku) return;
        settle({ status: 'purchased', transaction: purchase });
      },
      { dedupeTransactionIOS: false } as any,
    );

    const offError = purchaseErrorListener((err: any) => {
      const code = String(err?.code ?? '');
      if (/cancel/i.test(code)) return settle({ status: 'cancelled' });
      settle({ status: 'failed', reason: err?.message ?? 'Purchase failed.' });
    });

    purchaseInFlight = true;

    void (async () => {
      if (!(await connect())) {
        settle({ status: 'failed', reason: 'Store unavailable.' });
        return;
      }

      // Already paid, just not confirmed? Then do not buy again.
      //
      // A purchase whose server validation failed is left unfinished on
      // purpose so it can be retried. Tapping Subscribe again should resume
      // THAT transaction rather than start a second one — the user has
      // already been charged, and in production a second purchase is a second
      // charge.
      const pending = await pendingFor(sku);
      if (pending) {
        settle({ status: 'purchased', transaction: pending });
        return;
      }

      // The platform keys are `apple` and `google`. They are NOT `ios` and
      // `android`: react-native-iap reads `request.apple.sku` directly and
      // throws EmptySkuList when it is missing, so the wrong key made every
      // purchase fail instantly. An `as any` here previously suppressed the
      // compile error that would have caught it — hence no cast now.
      await requestPurchase({
        request: { apple: { sku }, google: { skus: [sku] } },
        type: 'subs',
      });

      // requestPurchase has returned, so the sheet is closed and the user has
      // finished interacting. Anything still outstanding is a delivery that is
      // not coming. Ask the store directly rather than waiting forever.
      //
      // The timer starts HERE, not at the top: the sheet can legitimately sit
      // open for minutes behind Face ID, a password, or an Ask to Buy
      // approval, and a blanket timeout would cancel real purchases.
      grace = setTimeout(() => {
        void (async () => {
          const found = await pendingFor(sku);
          if (found) settle({ status: 'purchased', transaction: found });
          else settle({ status: 'failed', reason: 'The store did not confirm the purchase.' });
        })();
      }, 6000);
    })().catch((e: any) => {
      const code = String(e?.code ?? '');
      if (/cancel/i.test(code)) return settle({ status: 'cancelled' });
      settle({ status: 'failed', reason: e?.message ?? 'Purchase failed.' });
    });
  });
}

/**
 * Every unfinished transaction, pulled rather than waited for.
 *
 * The library does not replay unfinished transactions to JS on connect — it
 * caches them natively and emits nothing. The only path to a listener is
 * Transaction.updates, which redelivers an interrupted purchase on a cold
 * launch *often* but not reliably, and never twice in one process. A
 * transaction it declines to re-yield was invisible to the app forever.
 *
 * This asks the store directly, so recovery no longer depends on an event
 * that may not arrive.
 */
export async function pendingTransactions(): Promise<unknown[]> {
  if (!(await connect())) return [];
  try {
    const list = (await getPendingTransactionsIOS()) as unknown[];
    return list ?? [];
  } catch {
    return [];
  }
}

/**
 * Transactions already being handled, so the pull and the event stream cannot
 * both process one purchase — that would validate and finish it twice.
 *
 * An id is removed when validation FAILS, so the next attempt retries it.
 */
const handling = new Set<string>();

export function claimTransaction(id: string): boolean {
  if (!id || handling.has(id)) return false;
  handling.add(id);
  return true;
}

export function releaseTransaction(id: string): void {
  handling.delete(id);
}

/** An unfinished purchase of this SKU sitting in the store's queue, if any. */
async function pendingFor(sku: string): Promise<unknown | null> {
  try {
    const purchases = (await getAvailablePurchases()) as any[];
    return (purchases ?? []).find((p) => String(p?.productId) === sku) ?? null;
  } catch {
    return null;
  }
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
    const purchases = (await getAvailablePurchases()) as any[];
    // Only our own subscriptions count. Returning the raw list meant an
    // unrelated purchase under the same Apple Account satisfied the caller's
    // "found something, grant Pro" check.
    return (purchases ?? []).filter((p) =>
      ALL_PRODUCT_IDS.includes(String(p?.productId)),
    );
  } catch {
    return [];
  }
}

/**
 * Listen for transactions that arrive outside a live `buy()` call.
 *
 * StoreKit replays an unfinished transaction on every launch, and a deferred
 * purchase ("Ask to Buy") is approved by a parent long after the app has
 * moved on. Registering listeners only inside `buy()` meant nothing was
 * listening in either case: the user was charged, the transaction was never
 * finished, and it was re-queued forever with no way to recover.
 *
 * Returns an unsubscribe function. Call this once at app start, not per
 * screen, or a purchase can be handled twice.
 */
export function onPurchaseRecovered(
  handler: (transaction: unknown, productId: string) => void | Promise<void>,
): () => void {
  const sub = purchaseUpdatedListener((purchase: any) => {
    // A live buy() owns its own outcome. Without this, both listeners saw the
    // same event: the purchase was validated twice concurrently and finished
    // twice, and the app-level path could finish the transaction while the
    // paywall was still telling the user it could not confirm it.
    if (purchaseInFlight) return;
    const productId = String(purchase?.productId ?? '');
    // Only our own subscriptions, so an unrelated purchase in the same Apple
    // Account cannot drive entitlement.
    if (!ALL_PRODUCT_IDS.includes(productId)) return;
    void handler(purchase, productId);
  });
  return () => sub?.remove?.();
}
