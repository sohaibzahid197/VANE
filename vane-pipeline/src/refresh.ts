// The live job. Runs on GitHub Actions cron, fired by vane-cron.
//
// Run with DRY_RUN=1 to print instead of publishing, which needs no Firebase
// credentials at all.
//
// WHY THIS JOB HAS MODES NOW
//
// It used to do one thing on one schedule: fetch every coin, publish, grade,
// notify, every fifteen minutes. That was affordable against a keyless exchange
// API. Against a licensed provider with a monthly credit budget it is not — 250
// coins fetched 96 times a day is 720,000 credits a month against a budget of
// 100,000.
//
// The fix is not to refresh less often. It is to notice that the three things
// this job does have genuinely different natural frequencies:
//
//   prices   every 15 min   1 call total      — one /coins/markets page covers
//                                               all 250 coins at once
//   signals  every 4 hours  ~250 calls        — the model reads hourly candles;
//                                               a new one appears hourly, and a
//                                               directional call on a 24H-30D
//                                               horizon does not change
//                                               meaningfully within an hour
//   history  daily          ~500 calls        — and never less often than daily,
//                                               because CoinGecko's terms permit
//                                               storage only if the cache is
//                                               refreshed at least every 24h
//
// Monthly: 2,880 + 2,880 + 45,000 + 15,000 = about 66,000 of 100,000.
//
// GRADING STAYED ON THE FAST CADENCE, deliberately. Resolving predictions and
// grading the scorecard need current prices, not fresh candles — and the prices
// mode already has them from its single call. Moving grading to the 4-hour
// cadence would settle a 24-hour call up to four hours past its horizon, a ~17%
// timing error on the one number this product asks to be trusted on. The whole
// reason vane-cron exists was to stop dropped runs corrupting exactly that.

import './env.ts';
import { HORIZONS_ALL, buildCoin } from './publish.ts';
import {
  UNIVERSE_SIZE,
  creditBudget,
  fetchUniverse,
  loadUniverse,
  publishMarkets,
  saveUniverse,
} from './coins.ts';
import type { UniverseEntry } from './coins.ts';
import { buildHistory, publishHistory, staleCoins } from './history.ts';
import { coinGeckoFromEnv } from './providers/coingecko.ts';
import type { CoinMarket, MarketProvider } from './providers/types.ts';

type Mode = 'prices' | 'signals' | 'history' | 'full';

/** Hourly candles handed to the model. 48 bars of zscore warmup plus room. */
const SIGNAL_HOURS = 1200;

function parseMode(): Mode {
  const raw = (process.env.REFRESH_MODE ?? 'full').toLowerCase();
  if (raw === 'prices' || raw === 'signals' || raw === 'history' || raw === 'full') return raw;
  throw new Error(`REFRESH_MODE must be prices|signals|history|full, got "${raw}"`);
}

/**
 * Resolve the coin universe.
 *
 * Prefers the stored registry so a run does not depend on the ranking being
 * identical to last time — a coin dropping out of the top 250 for an hour must
 * not orphan its stored history or its open predictions. The registry is
 * refreshed whenever markets are fetched.
 */
async function resolveUniverse(
  db: Awaited<ReturnType<typeof import('./publish.ts').adminDb>> | null,
  markets: CoinMarket[] | null,
): Promise<UniverseEntry[]> {
  if (markets && markets.length) {
    return markets.map((m) => ({ id: m.id, sym: m.sym, name: m.name }));
  }
  if (!db) throw new Error('no universe available: need markets or a database');
  const stored = await loadUniverse(db);
  if (stored.length === 0) {
    throw new Error(
      'coin universe is empty — run once with REFRESH_MODE=prices (or full) to seed it',
    );
  }
  return stored;
}

async function main() {
  const dry = process.env.DRY_RUN === '1';
  const mode = parseMode();
  const provider: MarketProvider = coinGeckoFromEnv();

  console.log(`mode=${mode} provider=${provider.name}${dry ? ' (dry run)' : ''}`);

  // Say whether this configuration can survive the month BEFORE spending any of
  // it. A quota exhausted at coin 180 leaves the published documents half
  // updated and looks exactly like a bug, so the warning belongs at the front.
  const tier = process.env.COINGECKO_TIER ?? 'demo';

  // A COMMERCIAL LICENCE BOUNDARY MUST NOT BE REACHABLE BY AN UNSET VARIABLE.
  //
  // `demo` is the right default on a developer's laptop and the wrong one in CI:
  // the workflow's `${{ vars.COINGECKO_TIER || 'demo' }}` means a misspelled or
  // missing repo variable silently publishes the documents a PAYING app reads,
  // using a tier whose licence row on CoinGecko's own pricing matrix is blank.
  // Demo does not fail in that situation — it works, at reduced scale, which is
  // exactly what makes it dangerous.
  //
  // So a publishing run on `demo` has to be asked for out loud. Dry runs and
  // local development are unaffected.
  if (!dry && tier === 'demo' && process.env.ALLOW_DEMO_PUBLISH !== '1') {
    throw new Error(
      'Refusing to publish on the CoinGecko Demo tier.\n' +
        "  Demo carries NO commercial licence — its License cell is blank on\n" +
        '  CoinGecko\'s pricing matrix, while every paid tier reads "Commercial".\n' +
        '  Publishing from it feeds a paid app from an unlicensed source.\n\n' +
        '  For a real deployment: set COINGECKO_TIER=pro with a paid key.\n' +
        '  For local development against Firestore: ALLOW_DEMO_PUBLISH=1\n' +
        '  To inspect output without publishing at all: DRY_RUN=1',
    );
  }
  const budget = creditBudget(tier, {
    coins: UNIVERSE_SIZE,
    pricesPerDay: Number(process.env.PRICES_PER_DAY ?? '96'),
    signalsPerDay: Number(process.env.SIGNALS_PER_DAY ?? '6'),
    historyPerDay: Number(process.env.HISTORY_PER_DAY ?? '1'),
  });
  console.log(
    `budget: ~${budget.projected.toLocaleString('en-US')} credits/month of ` +
      `${budget.allowance.toLocaleString('en-US')} on ${tier} ` +
      `(${UNIVERSE_SIZE} coins)`,
  );
  if (!budget.fits) {
    console.warn(
      `  OVER BUDGET by ${(budget.projected - budget.allowance).toLocaleString('en-US')} ` +
        `credits/month.\n` +
        `  Lower UNIVERSE_SIZE, slow the cadence, or move to a paid tier.\n` +
        `  A free Demo key sustains roughly 50 coins on a daily rebuild.`,
    );
  }

  // --- prices: one call, every coin ---------------------------------------
  //
  // Needed by every mode except a pure history rebuild: signals key off the
  // universe this returns, and grading needs the prices.
  let markets: CoinMarket[] | null = null;
  let global = null;
  if (mode !== 'history') {
    markets = await fetchUniverse(provider, UNIVERSE_SIZE);
    try {
      global = await provider.global();
    } catch (e) {
      // Dashboard garnish. Never worth failing a run over.
      console.warn(`global metrics failed: ${(e as Error).message}`);
    }
    console.log(`fetched ${markets.length} coins in ${provider.callsUsed()} call(s)`);
  }

  if (dry) {
    await dryRun(provider, mode, markets);
    return;
  }

  // Publishing needs firebase-admin + a service account. Kept behind a dynamic
  // import so DRY_RUN works with zero dependencies installed.
  const { publish, adminDb } = await import('./publish.ts');
  const db = await adminDb();
  const health: Record<string, unknown> = { mode, provider: provider.name };

  if (markets) {
    const counts = await publishMarkets(db, markets, global, provider.name);
    await saveUniverse(db, markets);
    health.markets = { ok: true, ...counts };
    console.log(`published markets: ${counts.free} free, ${counts.all} total`);
  }

  const universe = await resolveUniverse(db, markets);

  // --- signals -------------------------------------------------------------
  if (mode === 'signals' || mode === 'full') {
    const coins = [];
    const failed: string[] = [];

    for (const meta of universe) {
      try {
        const candles = await provider.signalSeries(meta.id, SIGNAL_HOURS);
        coins.push(buildCoin(meta, candles));
      } catch (e) {
        // One bad coin (delisted, renamed, thin history) must not take the whole
        // refresh down and leave the app on stale data for every coin.
        failed.push(`${meta.sym}: ${(e as Error).message}`);
      }
    }

    if (coins.length === 0) {
      throw new Error(`every coin failed:\n  ${failed.slice(0, 20).join('\n  ')}`);
    }
    if (failed.length) {
      console.warn(`skipped ${failed.length} coin(s):\n  ${failed.slice(0, 20).join('\n  ')}`);
    }

    await publish({
      updatedAt: new Date().toISOString(),
      horizons: HORIZONS_ALL,
      source: provider.name,
      coins,
    });
    health.signals = { ok: true, published: coins.length, skipped: failed.length };
    console.log(`published ${coins.length} signal(s), skipped ${failed.length}`);

    // VANE's own record. Recorded whenever signals are, graded below.
    try {
      const { recordCalls } = await import('./scorecard.ts');
      const recorded = await recordCalls(db, coins, HORIZONS_ALL);
      health.recorded = { ok: true, recorded };
      console.log(`scorecard: recorded ${recorded}`);
    } catch (e) {
      health.recorded = { ok: false, error: (e as Error).message };
      console.warn(`recordCalls failed: ${(e as Error).message}`);
    }
  }

  // --- history -------------------------------------------------------------
  if (mode === 'history' || mode === 'full') {
    try {
      const stale = await staleCoins(db, universe);
      console.log(`history: ${stale.length} of ${universe.length} coin(s) stale`);

      const docs = [];
      const failed: string[] = [];
      for (const coin of stale) {
        try {
          const doc = await buildHistory(provider, coin);
          if (doc) docs.push(doc);
          else failed.push(`${coin.sym}: no usable series`);
        } catch (e) {
          failed.push(`${coin.sym}: ${(e as Error).message}`);
        }
      }

      const counts = docs.length
        ? await publishHistory(db, docs)
        : { free: 0, paid: 0, failed: 0 };
      health.history = {
        // Not ok when documents were fetched but could not be written — that is
        // credits spent for nothing, and it must not read as a clean run.
        ok: counts.failed === 0,
        built: docs.length,
        fetchFailed: failed.length,
        ...counts,
      };
      console.log(
        `history: published ${counts.free + counts.paid} of ${docs.length} ` +
          `(${counts.free} free, ${counts.paid} paid)` +
          (counts.failed ? `, ${counts.failed} FAILED TO WRITE` : '') +
          (failed.length ? `, ${failed.length} failed to fetch` : ''),
      );
      if (failed.length) console.warn(`  ${failed.slice(0, 10).join('\n  ')}`);
    } catch (e) {
      health.history = { ok: false, error: (e as Error).message };
      console.warn(`history rebuild failed: ${(e as Error).message}`);
    }
  }

  // --- grading, tallies and push -----------------------------------------
  //
  // These run on EVERY mode that has prices, because they are time-sensitive in
  // a way the signals are not: a prediction comes due on its own schedule, and
  // grading it late is a measurement error in the published hit rate.
  //
  // Each step is isolated. Failures here must not mark the whole job failed —
  // the signals and prices are already published and are the critical path. And
  // each reports its own outcome to public/resolver_health, because without that
  // a failure is invisible: the process exits zero and the cron stays green
  // forever while nothing is ever graded.
  if (markets) {
    const prices: Record<string, number> = {};
    for (const m of markets) prices[m.sym] = m.price;
    const known = new Set(markets.map((m) => m.sym));

    const { resolvePredictions, aggregatePolls } = await import('./resolve.ts');

    try {
      const r = await resolvePredictions(db, prices);
      health.predictions = { ok: true, ...r };
      console.log(`graded ${r.resolved}, ties ${r.ties}, voided ${r.voided}, pending ${r.pending}`);
    } catch (e) {
      health.predictions = { ok: false, error: (e as Error).message };
      console.warn(`resolvePredictions failed: ${(e as Error).message}`);
    }

    try {
      const { gradeCalls, scorecard } = await import('./scorecard.ts');
      const g = await gradeCalls(db, prices);
      const rows = await scorecard(db);
      await db.doc('public/scorecard').set({ updatedAt: new Date().toISOString(), rows });
      health.scorecard = { ok: true, ...g };
      console.log(
        `scorecard: graded ${g.graded}, ties ${g.ties}, ` +
          rows.map((r) => `${r.horizon} ${r.correct}/${r.graded}`).join(' '),
      );
    } catch (e) {
      health.scorecard = { ok: false, error: (e as Error).message };
      console.warn(`scorecard failed: ${(e as Error).message}`);
    }

    // Push. Only meaningful when signals were recomputed this run — a flip is a
    // change in the model's direction, and the direction cannot have changed if
    // the model did not run.
    if (mode === 'signals' || mode === 'full') {
      try {
        const { notifyFlips } = await import('./notify.ts');
        const snap = await db.doc('private/signals_all').get();
        const coins = ((snap.data() as { coins?: { sym: string; up: boolean }[] })?.coins ?? []).map(
          (c) => ({ sym: c.sym, up: c.up }),
        );
        const n = await notifyFlips(db, coins);
        health.notify = { ok: true, ...n };
        console.log(
          n.flipped.length === 0
            ? 'no signal flips'
            : `flips ${n.flipped.join(',')} -> ${n.sent}/${n.targeted} sent` +
                (n.pruned ? `, ${n.pruned} dead token(s) pruned` : ''),
        );
      } catch (e) {
        health.notify = { ok: false, error: (e as Error).message };
        console.warn(`notifyFlips failed: ${(e as Error).message}`);
      }
    }

    try {
      const p = await aggregatePolls(db, known);
      health.polls = { ok: true, ...p };
      console.log(
        `${p.polls} poll(s) above threshold from ${p.scanned} vote(s)` +
          (p.truncated ? ' (TRUNCATED — raise VOTE_MAX_PAGES)' : ''),
      );
    } catch (e) {
      health.polls = { ok: false, error: (e as Error).message };
      console.warn(`aggregatePolls failed: ${(e as Error).message}`);
    }

  }

  // OUTSIDE the `if (markets)` block, deliberately.
  //
  // It used to sit inside it, which meant `history` mode — the only mode
  // carrying a licence obligation, since CoinGecko permits storage only if the
  // cache is refreshed every 24 hours — computed its health entry and then threw
  // it away. ops/resolver_health could only ever report a history run that
  // happened to be part of a `full` run, so a nightly rebuild failing silently
  // was invisible in exactly the place built to make silence impossible.
  health.calls = provider.callsUsed();
  try {
    const { writeHealth } = await import('./resolve.ts');
    await writeHealth(db, health);
  } catch (e) {
    console.warn(`writeHealth failed: ${(e as Error).message}`);
  }

  console.log(`done. ${provider.callsUsed()} provider call(s) this run.`);
}

/**
 * Print what would be published, without Firebase.
 *
 * Kept deliberately cheap: a dry run of the history rebuild fetches two series
 * for a handful of coins rather than all 250, because the point is to see the
 * shape of the output, not to spend 500 credits proving the loop works.
 */
async function dryRun(provider: MarketProvider, mode: Mode, markets: CoinMarket[] | null) {
  const SAMPLE = 3;

  if (markets) {
    console.log(JSON.stringify(markets.slice(0, SAMPLE), null, 2));
    console.log(`... ${markets.length} coins total`);
  }

  const universe = (markets ?? []).slice(0, SAMPLE).map((m) => ({
    id: m.id,
    sym: m.sym,
    name: m.name,
  }));

  if (mode === 'signals' || mode === 'full') {
    for (const meta of universe) {
      try {
        const candles = await provider.signalSeries(meta.id, SIGNAL_HOURS);
        console.log(JSON.stringify(buildCoin(meta, candles), null, 2));
      } catch (e) {
        console.warn(`${meta.sym}: ${(e as Error).message}`);
      }
    }
  }

  if (mode === 'history' || mode === 'full') {
    for (const meta of universe) {
      const doc = await buildHistory(provider, meta);
      if (!doc) {
        console.warn(`${meta.sym}: no usable series`);
        continue;
      }
      const shape = Object.fromEntries(
        Object.entries(doc.ranges).map(([r, s]) => [r, `${s.c.length} bars`]),
      );
      console.log(`${meta.sym} history: ${JSON.stringify(shape)}`);
    }
  }

  console.log(`dry run used ${provider.callsUsed()} provider call(s).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
