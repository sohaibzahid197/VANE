// Phase 0 gate. Walk-forward over real market history.
//
// Two rules keep this honest:
//   1. No random train/test split. Time series leak the future that way.
//   2. Every model is scored against the naive baseline "tomorrow = today"
//      (i.e. last 24h direction persists). Beating nothing is not a product.
//
// MIGRATED OFF BINANCE, and this run's result is therefore not comparable to
// the previous one. Two things changed in the input data:
//
//   1. Binance's kline volume is volume traded WITHIN a candle. CoinGecko's is
//      the ROLLING 24-HOUR volume at that timestamp. signal.ts feeds volume
//      through zscore(volume, 48), so that feature now measures something
//      different and smoother. There is no transformation that makes the two
//      equivalent — a rolling window's first difference is not per-bar volume.
//   2. Hourly depth is shorter and tier-dependent (about a year on Demo, two on
//      Basic) rather than nine years.
//
// So the previously recorded edges (24H +0.7pp, 7D -0.9pp, 30D -4.4pp) do not
// carry over and MUST be re-measured. calibration.json stays `enabled: false`
// until a horizon clears MIN_EDGE on this data, which is what stops a changed
// feature quietly switching on a published confidence percentage.

import './env.ts';
import type { Candle } from './providers/types.ts';
import { coinGeckoFromEnv } from './providers/coingecko.ts';
import { UNIVERSE_SIZE, fetchUniverse } from './coins.ts';
import { HORIZON_HOURS, type Horizon, prepare, scoreAt } from './signal.ts';
import { newBuckets, observe, reliability, toTable } from './calibrate.ts';
import { writeFileSync } from 'node:fs';

// Calibrate on the same universe the app publishes. Calibrating on five
// large caps and then applying the table to thirty — including thin, young
// alts with completely different vol regimes — makes the confidence number
// meaningless for two thirds of the list.
/**
 * How many coins to calibrate on.
 *
 * Calibrate on the same universe the app publishes. Calibrating on five large
 * caps and then applying the table to hundreds — including thin, young alts with
 * completely different vol regimes — makes the confidence number meaningless for
 * most of the list. Overridable because a full 250-coin run costs ~2,000 provider
 * credits and this is a research tool, not a cron job.
 */
const BACKTEST_COINS = Number(process.env.BACKTEST_COINS ?? '40');
const HORIZONS: Horizon[] = ['24H', '7D', '30D'];
/**
 * Hourly candles requested per coin.
 *
 * ~11 months. CoinGecko serves this through the paged range endpoint rather than
 * in one response, and will return LESS when the window exceeds the plan's
 * hourly depth — so the run reports what it actually received per coin instead
 * of assuming it got what it asked for.
 */
const CANDLES = 8000;
const WARMUP = 720; // skip the first 30 days so indicators are settled
/**
 * Sampling stride, in hours.
 *
 * At 6h with a 24h horizon each outcome window overlapped the next four, so
 * the effective sample size was about a quarter of the row count and the
 * standard error roughly double what the raw n implied. Sampling at the
 * horizon length makes the windows non-overlapping and the statistics honest.
 */
const STRIDE_BY_HORIZON: Record<Horizon, number> = { '24H': 24, '7D': 168, '30D': 168 };

/**
 * Edge required to call a horizon a pass.
 *
 * 1pp was inside the noise: with non-overlapping 24H windows over ~11 months
 * the standard error is still ~1.3pp, so a 1pp threshold passed on chance
 * roughly a third of the time — and a false pass switches on a published
 * confidence percentage.
 */
const MIN_EDGE = 0.03;
const CALIBRATION_FILE = new URL('../calibration.json', import.meta.url);

type Row = { model: boolean; naive: boolean; actual: boolean; score: number };

const pct = (n: number) => (n * 100).toFixed(1).padStart(5) + '%';

function accuracy(rows: Row[], key: 'model' | 'naive') {
  const hits = rows.filter((r) => r[key] === r.actual).length;
  return hits / rows.length;
}

/**
 * Build the scored rows for one symbol and horizon.
 *
 * Extracted so it can be tested without hitting Binance. This is where the
 * real lookahead risk lives — `actual` reads a FUTURE close by construction,
 * and the only thing keeping the backtest honest is that it never feeds that
 * value back into the score.
 */
export function buildRows(candles: Candle[], ahead: number, stride: number): Row[] {
  const closes = candles.map((c) => c.close);
  const ind = prepare(candles);
  const rows: Row[] = [];
  for (let i = WARMUP; i < candles.length - ahead - 1; i += stride) {
    const sig = scoreAt(ind, i);
    rows.push({
      model: sig.up,
      naive: i >= 24 ? closes[i] > closes[i - 24] : true,
      actual: closes[i + ahead] > closes[i],
      score: sig.score,
    });
  }
  return rows;
}

async function main() {
  const provider = coinGeckoFromEnv();
  const universe = (await fetchUniverse(provider, Math.min(BACKTEST_COINS, UNIVERSE_SIZE))).slice(
    0,
    BACKTEST_COINS,
  );

  console.log(`\nVANE backtest — ${universe.length} coins x up to ${CANDLES} hourly candles`);
  console.log(
    `walk-forward, non-overlapping windows, ${WARMUP}h warmup, ` +
      `pass needs >${(MIN_EDGE * 100).toFixed(0)}pp edge\n`,
  );
  console.log(
    '  NOTE: volume is now a rolling 24h series, not per-bar. Results are not\n' +
      '  comparable to any run made against exchange klines.\n',
  );

  const perHorizon = new Map<Horizon, Row[]>(HORIZONS.map((h) => [h, []]));
  const short: string[] = [];
  const to = Date.now();
  const from = to - CANDLES * 3_600_000;

  for (const coin of universe) {
    process.stdout.write(`  fetching ${coin.sym.padEnd(9)} ... `);
    const candles = await provider.candlesRange(coin.id, from, to, 'hourly');
    const closes = candles.map((c) => c.close);
    console.log(`${candles.length} candles`);

    // The range endpoint returns LESS than asked for when the window exceeds the
    // plan's hourly depth, silently. A coin with barely more than the warmup
    // contributes almost nothing but still counts toward the apparent sample, so
    // record it and report it rather than letting a thin run look like a full one.
    if (candles.length < WARMUP + HORIZON_HOURS['30D'] + 2) {
      short.push(`${coin.sym} (${candles.length}h)`);
      continue;
    }

    // Indicators depend only on the candles, so compute them once per symbol
    // instead of once per scored index.
    const ind = prepare(candles);

    for (const h of HORIZONS) {
      const ahead = HORIZON_HOURS[h];
      const rows = perHorizon.get(h)!;

      // -1 so the final sample never resolves against the still-forming candle,
      // which publish.ts also drops. Keeps backtest and live in agreement.
      const stride = STRIDE_BY_HORIZON[h];
      for (let i = WARMUP; i < candles.length - ahead - 1; i += stride) {
        const sig = scoreAt(ind, i);
        rows.push({
          model: sig.up,
          naive: i >= 24 ? closes[i] > closes[i - 24] : true,
          actual: closes[i + ahead] > closes[i],
          score: sig.score,
        });
      }
    }
  }

  if (short.length) {
    console.log(
      `\n  SKIPPED ${short.length} coin(s) with too little history for a 30D ` +
        `horizon:\n    ${short.join(', ')}`,
    );
  }

  console.log('\n' + '─'.repeat(58));
  console.log('  DIRECTIONAL ACCURACY — model vs naive baseline');
  console.log('─'.repeat(58));
  console.log('  horizon      n     model    naive     edge   verdict');

  let anyPass = false;
  // Tracked separately because the calibration table is built from 24H rows
  // only, so only a 24H pass may enable a published confidence number.
  let pass24 = false;

  for (const h of HORIZONS) {
    const rows = perHorizon.get(h)!;
    const m = accuracy(rows, 'model');
    const nv = accuracy(rows, 'naive');
    const edge = m - nv;
    const pass = edge > MIN_EDGE;
    if (pass) anyPass = true;
    if (pass && h === '24H') pass24 = true;
    console.log(
      `  ${h.padEnd(6)} ${String(rows.length).padStart(6)}   ${pct(m)}   ${pct(nv)}  ${(edge >= 0 ? '+' : '') + (edge * 100).toFixed(1)}pp   ${pass ? 'PASS' : 'fail'}`,
    );
  }

  // Calibration on the 24H horizon — the number the UI headlines.
  const buckets = newBuckets();
  for (const r of perHorizon.get('24H')!) {
    observe(buckets, r.score, r.model === r.actual);
  }

  console.log('\n' + '─'.repeat(58));
  console.log('  CALIBRATION (24H) — does a high score actually win more?');
  console.log('─'.repeat(58));
  console.log(reliability(buckets));

  // The handoff to the publisher. Written ONLY when a horizon actually beats
  // the baseline: publish.ts reads this file, and a missing/disabled file is
  // what keeps `conf: null` flowing to the app. Previously toTable() existed
  // for this and was never called, so calibration could never be turned on.
  // Gated on 24H specifically: `buckets` is built only from the 24H rows
  // above, so enabling on a 30D pass would publish confidence derived from a
  // horizon that did not beat the baseline.
  const table = {
    enabled: pass24,
    generatedAt: new Date().toISOString(),
    horizon: '24H',
    buckets: toTable(buckets),
  };
  writeFileSync(CALIBRATION_FILE, JSON.stringify(table, null, 2) + '\n');

  console.log('\n' + '─'.repeat(58));
  console.log(
    anyPass
      ? '  GATE: PASS — at least one horizon beats the baseline.'
      : '  GATE: FAIL — no horizon beats the baseline. Do not ship\n         a confidence number. Pivot to crowd + track record.',
  );
  console.log(`  calibration.json written (enabled: ${pass24})`);
  console.log('─'.repeat(58) + '\n');
}

// Only run the CLI when this file IS the entry point. Without the guard,
// importing it — as the tests do, for buildRows — kicked off a full 30-symbol
// Binance fetch as a side effect of the import.
const isEntryPoint =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isEntryPoint) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
