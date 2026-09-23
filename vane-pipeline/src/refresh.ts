// The live job. Runs on GitHub Actions cron; builds the single Firestore
// document the app reads. Run with DRY_RUN=1 to print instead of publishing,
// which needs no Firebase credentials at all.

import { fetchCandles } from './fetch.ts';
import { HORIZONS_ALL, buildCoin } from './publish.ts';
import { UNIVERSE } from './universe.ts';

async function main() {
  const dry = process.env.DRY_RUN === '1';
  const coins = [];

  const failed: string[] = [];

  for (const meta of UNIVERSE) {
    try {
      const candles = await fetchCandles(meta.symbol, '1h', 1200);
      coins.push(buildCoin(meta, candles));
    } catch (e) {
      // One bad symbol (delisted, renamed, thin history) must not take the
      // whole refresh down and leave the app on stale data for every coin.
      failed.push(`${meta.sym}: ${(e as Error).message}`);
    }
  }

  if (coins.length === 0) {
    throw new Error(`every symbol failed:\n  ${failed.join('\n  ')}`);
  }
  if (failed.length) {
    console.warn(`skipped ${failed.length} symbol(s):\n  ${failed.join('\n  ')}`);
  }

  const doc = {
    updatedAt: new Date().toISOString(),
    horizons: HORIZONS_ALL,
    coins,
  };

  if (dry) {
    console.log(JSON.stringify(doc, null, 2));
    return;
  }

  // Publishing needs firebase-admin + a service account. Kept behind a
  // dynamic import so DRY_RUN works with zero dependencies installed.
  const { publish, adminDb } = await import('./publish.ts');
  await publish(doc);
  console.log(`published ${coins.length} coins at ${doc.updatedAt}`);

  // Same run, same prices: grade any prediction whose horizon has elapsed and
  // refresh the public crowd tally. Failures here must not mark the whole job
  // failed — the signals are already published and are the critical path.
  const { resolvePredictions, aggregatePolls, writeHealth } = await import('./resolve.ts');
  const db = await adminDb();
  const prices: Record<string, number> = {};
  for (const c of coins) prices[c.sym] = c.price;
  const known = new Set(coins.map((c) => c.sym));

  // Grading and poll aggregation are independent, so one failing must not
  // silently take the other down with it. Each reports its own outcome to
  // public/resolver_health — without that a failure here is invisible: the
  // signals still publish, the process exits zero and the cron stays green
  // forever while nothing is ever graded.
  const health: Record<string, unknown> = {};

  try {
    const r = await resolvePredictions(db, prices);
    health.predictions = { ok: true, ...r };
    console.log(
      `graded ${r.resolved}, ties ${r.ties}, voided ${r.voided}, pending ${r.pending}`,
    );
  } catch (e) {
    health.predictions = { ok: false, error: (e as Error).message };
    console.warn(`resolvePredictions failed: ${(e as Error).message}`);
  }

  // VANE's own record. Recorded on every run and graded at close, so the app
  // can show a measured hit rate instead of an assertion. Isolated like the
  // others: a failure here must not take the signals down with it.
  try {
    const { recordCalls, gradeCalls, scorecard } = await import('./scorecard.ts');
    const recorded = await recordCalls(db, coins, HORIZONS_ALL);
    const g = await gradeCalls(db, prices);
    const rows = await scorecard(db);
    await db.doc('public/scorecard').set({
      updatedAt: new Date().toISOString(),
      rows,
    });
    health.scorecard = { ok: true, recorded, ...g };
    console.log(
      `scorecard: recorded ${recorded}, graded ${g.graded}, ties ${g.ties}, ` +
        rows.map((r) => `${r.horizon} ${r.correct}/${r.graded}`).join(' '),
    );
  } catch (e) {
    health.scorecard = { ok: false, error: (e as Error).message };
    console.warn(`scorecard failed: ${(e as Error).message}`);
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

  await writeHealth(db, health);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
