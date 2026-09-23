import assert from 'node:assert/strict';
import { test } from 'node:test';
import { entitlementFrom, type TransactionInfo } from '../src/apple.ts';

const PRODUCTS = [
  'com.vane.app.pro.weekly',
  'com.vane.app.pro.monthly',
  'com.vane.app.pro.yearly',
] as const;

const BUNDLE = 'com.vane.app';
const NOW = Date.UTC(2026, 8, 24);

const tx = (over: Partial<TransactionInfo> = {}): TransactionInfo => ({
  transactionId: '2000000',
  originalTransactionId: '1000000',
  productId: 'com.vane.app.pro.yearly',
  bundleId: BUNDLE,
  purchaseDate: NOW - 86_400_000,
  expiresDate: NOW + 86_400_000,
  environment: 'Production',
  ...over,
});

test('a live subscription is active until its expiry', () => {
  const r = entitlementFrom(tx(), PRODUCTS, BUNDLE, NOW);
  assert.equal(r.active, true);
  assert.equal(r.expiresAt.getTime(), NOW + 86_400_000);
});

test('an expired subscription is not active', () => {
  const r = entitlementFrom(tx({ expiresDate: NOW - 1 }), PRODUCTS, BUNDLE, NOW);
  assert.equal(r.active, false);
  assert.equal(r.reason, 'expired');
});

test('expiry is exclusive at the exact boundary', () => {
  // A subscription expiring at this instant has expired. Treating the
  // boundary as still-active hands out a free window on every renewal.
  const r = entitlementFrom(tx({ expiresDate: NOW }), PRODUCTS, BUNDLE, NOW);
  assert.equal(r.active, false);
});

test('a REFUNDED purchase loses access even though it has not expired', () => {
  // This is the case that matters most: the money has gone back to the user
  // and the expiry is still in the future. Honouring only expiresDate would
  // give a refunded buyer the full remaining term for free.
  const r = entitlementFrom(
    tx({ revocationDate: NOW - 1000, expiresDate: NOW + 30 * 86_400_000 }),
    PRODUCTS,
    BUNDLE,
    NOW,
  );
  assert.equal(r.active, false);
  assert.equal(r.reason, 'revoked');
});

test('a product we do not sell never grants access', () => {
  // Without this, any purchase in the same Apple Account — including one from
  // a different app under a shared id — would satisfy validation.
  const r = entitlementFrom(tx({ productId: 'com.someone.else.pro' }), PRODUCTS, BUNDLE, NOW);
  assert.equal(r.active, false);
  assert.equal(r.reason, 'unknown product');
});

test('a transaction for another bundle is rejected', () => {
  const r = entitlementFrom(tx({ bundleId: 'com.attacker.app' }), PRODUCTS, BUNDLE, NOW);
  assert.equal(r.active, false);
  assert.equal(r.reason, 'bundle mismatch');
});

test('a non-subscription purchase does not grant a subscription', () => {
  const r = entitlementFrom(tx({ expiresDate: undefined }), PRODUCTS, BUNDLE, NOW);
  assert.equal(r.active, false);
  assert.equal(r.reason, 'not a subscription');
});

test('every plan we sell is honoured', () => {
  for (const productId of PRODUCTS) {
    const r = entitlementFrom(tx({ productId }), PRODUCTS, BUNDLE, NOW);
    assert.equal(r.active, true, `${productId} should be active`);
  }
});

test('a sandbox transaction is still evaluated on its merits', () => {
  // TestFlight purchases are Sandbox. Rejecting them by environment would
  // make the app untestable before release.
  const r = entitlementFrom(tx({ environment: 'Sandbox' }), PRODUCTS, BUNDLE, NOW);
  assert.equal(r.active, true);
});
