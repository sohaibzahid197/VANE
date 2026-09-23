// Subscription products.
//
// These identifiers MUST match App Store Connect exactly. A product id there
// is permanent — it cannot be edited, and it cannot be reused even after the
// product is deleted — so a typo on either side means creating a new one.
//
// Prices are NOT listed here on purpose. StoreKit returns the localized price
// for the user's storefront, and hardcoding "$79.99" would show the wrong
// number, in the wrong currency, to everyone outside the US — and misstating
// a price is an App Store guideline 3.1.2 problem, not just a cosmetic bug.

export type PlanId = 'weekly' | 'monthly' | 'yearly';

export const PRODUCT_IDS: Record<PlanId, string> = {
  weekly: 'com.vane.app.pro.weekly',
  monthly: 'com.vane.app.pro.monthly',
  yearly: 'com.vane.app.pro.yearly',
};

/** Order the paywall lists them in. Yearly first: it is the anchor. */
export const PLAN_ORDER: PlanId[] = ['yearly', 'monthly', 'weekly'];

/** Every id, for the single StoreKit fetch at paywall mount. */
export const ALL_PRODUCT_IDS = PLAN_ORDER.map((p) => PRODUCT_IDS[p]);

/**
 * No introductory free trial.
 *
 * A trial user costs the same Firebase reads as a paying one, and the free
 * tier already gives a real sample of the product, so the trial was paying
 * for evaluation twice.
 *
 * If one is ever added in App Store Connect, do NOT hardcode it here: read
 * eligibility from the StoreKit product, because an introductory offer is
 * once per subscription GROUP and a returning subscriber is not eligible.
 * Promising a trial the store will not honour is a 3.1.2 problem.
 */
export const TRIAL_PLAN: PlanId | null = null;

/** Copy shown under each plan. The PRICE comes from StoreKit, not from here. */
export const PLAN_LABEL: Record<PlanId, string> = {
  yearly: 'Yearly',
  monthly: 'Monthly',
  weekly: 'Weekly',
};
