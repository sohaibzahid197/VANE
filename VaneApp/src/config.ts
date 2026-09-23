// Build-level product switches.
//
// MONETIZATION is ON.
//
// It was off for as long as the paywall was theatre: prices were hardcoded
// and contradictory, entitlement was a boolean in AsyncStorage, and every
// "locked" coin's full data already sat on the device inside a world-readable
// document. The gate cost honest users clarity while stopping nobody.
//
// All four preconditions are now met:
//   1. StoreKit wired to the real products, prices read from the store
//   2. receipt validation writing users/{uid}/entitlement server-side
//   3. the app reading entitlement from there, with the local flag demoted
//      to an offline cache that is re-checked on every launch
//   4. the pipeline publishing paid coins to a SEPARATE document that the
//      security rules serve only to an entitled caller
//
// Note what isCoinLocked is NOT for any more: the server does not send a
// non-subscriber the paid coins at all, so locking is about presentation —
// what the free user is invited to buy — not about protecting data.
export const MONETIZATION = true;

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
