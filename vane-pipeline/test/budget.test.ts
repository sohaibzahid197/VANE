// Credit budget projection.
//
// This exists because the number it produces decides whether a plan is viable,
// and getting it wrong is expensive in a way that is invisible until a run dies
// part way through — leaving the published documents half updated, with nothing
// to say the cause was billing rather than a bug.
//
// The specific thing being pinned: a `prices` run costs TWO credits no matter
// how many coins there are, because one /coins/markets page carries 250 of them.
// If anyone ever "fixes" that to be per-coin, the projection jumps by two orders
// of magnitude and these tests say so.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { MONTHLY_CREDITS, creditBudget, projectedMonthlyCredits } from '../src/coins.ts';

/** The production cadence: prices 96x/day, signals 6x/day, history 1x/day. */
const PRODUCTION = { coins: 250, pricesPerDay: 96, signalsPerDay: 6, historyPerDay: 1 };

/** What fits a free Demo key: 50 coins, refreshed far less often. */
const DEV = { coins: 50, pricesPerDay: 6, signalsPerDay: 1, historyPerDay: 1 };

test('a prices run costs 2 credits regardless of coin count', () => {
  const ten = projectedMonthlyCredits({ coins: 10, pricesPerDay: 1, signalsPerDay: 0, historyPerDay: 0 });
  const thousand = projectedMonthlyCredits({ coins: 1000, pricesPerDay: 1, signalsPerDay: 0, historyPerDay: 0 });
  assert.equal(ten, thousand, 'one markets page covers every coin — this must not scale with coins');
  assert.equal(ten, 60, '2 calls x 30 days');
});

test('signals cost one call per coin', () => {
  const n = projectedMonthlyCredits({ coins: 100, pricesPerDay: 0, signalsPerDay: 1, historyPerDay: 0 });
  assert.equal(n, 3000, '100 coins x 1 call x 30 days');
});

test('history costs two calls per coin — hourly plus daily', () => {
  const n = projectedMonthlyCredits({ coins: 100, pricesPerDay: 0, signalsPerDay: 0, historyPerDay: 1 });
  assert.equal(n, 6000, '100 coins x 2 calls x 30 days');
});

test('the production cadence fits Basic but NOT Demo', () => {
  const basic = creditBudget('basic', PRODUCTION);
  assert.ok(basic.fits, `production should fit Basic, projected ${basic.projected}`);
  assert.ok(
    basic.projected > 50_000 && basic.projected < MONTHLY_CREDITS.basic,
    `expected roughly 60-70k, got ${basic.projected}`,
  );

  const demo = creditBudget('demo', PRODUCTION);
  assert.equal(demo.fits, false, 'production must NOT be reported as fitting a Demo key');
});

test('the development cadence fits a free Demo key', () => {
  const demo = creditBudget('demo', DEV);
  assert.ok(
    demo.fits,
    `dev cadence should fit Demo's ${MONTHLY_CREDITS.demo}, projected ${demo.projected}`,
  );
  // With real headroom, not scraping the ceiling — a month with a few manual
  // runs in it should not tip over.
  assert.ok(demo.projected < MONTHLY_CREDITS.demo * 0.7, `too tight: ${demo.projected}`);
});

test('an unknown tier is treated as the paid allowance, never as unlimited', () => {
  const b = creditBudget('pro', PRODUCTION);
  assert.equal(b.allowance, MONTHLY_CREDITS.basic);
  assert.ok(Number.isFinite(b.allowance));
});
