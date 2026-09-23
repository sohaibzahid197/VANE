// Build-level product switches.
//
// MONETIZATION is OFF for v1.0, deliberately.
//
// In-app purchases are not implemented. Shipping a paywall that advertises
// "$49.99 / year" and a 3-day trial, then dead-ends on an alert, is an App
// Store Guideline 2.1 rejection (non-functional feature) and a 3.1.2 problem
// besides. It was also security theatre: entitlement was a boolean in
// AsyncStorage, and the "locked" coins' full data was already on the device
// inside a world-readable document — so the gate cost real users clarity
// while stopping nobody.
//
// Flipping this to true requires, in order:
//   1. StoreKit 2 / Play Billing wired to real products
//   2. receipt validation writing users/{uid}/entitlement server-side
//   3. the app reading entitlement from there, never from local storage
//   4. the pipeline publishing locked coins to a SEPARATE gated document
//      so the paid payload never reaches a free device
export const MONETIZATION = false;

/**
 * Single source of truth for the user-visible version.
 *
 * package.json said 0.0.1, the native projects said 1.0, and the Settings
 * footer said 0.1.0 — three different answers to "what version is this?",
 * which makes a bug report impossible to place.
 */
export const APP_VERSION = '1.0.0';

/** Everything is unlocked while monetization is off. */
export const isCoinLocked = (locked: boolean, isPro: boolean) =>
  MONETIZATION && locked && !isPro;

/** Pro-gated alert rows behave as ordinary rows while monetization is off. */
export const isAlertLocked = (pro: boolean, isPro: boolean) =>
  MONETIZATION && pro && !isPro;
