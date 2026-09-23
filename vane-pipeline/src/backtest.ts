// Phase 0 gate. Walk-forward over real Binance history.
//
// Two rules keep this honest:
//   1. No random train/test split. Time series leak the future that way.
//   2. Every model is scored against the naive baseline "tomorrow = today"
//      (i.e. last 24h direction persists). Beating nothing is not a product.

import { fetchCandles, type Candle } from './fetch.ts';
import { UNIVERSE } from './universe.ts';
import { HORIZON_HOURS, type Horizon, prepare, scoreAt } from './signal.ts';
import { newBuckets, observe, reliability, toTable } from './calibrate.ts';
import { writeFileSync } from 'node:fs';

// Calibrate on the same universe the app publishes. Calibrating on five
// large caps and then applying the table to thirty — including thin, young
// alts with completely different vol regimes — makes the confidence number
// meaningless for two thirds of the list.
const SYMBOLS = UNIVERSE.map((c) => c.symbol);
const HORIZONS: Horizon[] = ['24H', '7D', '30D'];
const CANDLES = 8000; // ~11 months of hourly data
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
  console.log(`\nVANE backtest — ${SYMBOLS.length} symbols x ${CANDLES} hourly candles`);
  console.log(
    `walk-forward, non-overlapping windows, ${WARMUP}h warmup, ` +
      `pass needs >${(MIN_EDGE * 100).toFixed(0)}pp edge\n`,
  );

  const perHorizon = new Map<Horizon, Row[]>(HORIZONS.map((h) => [h, []]));

  for (const symbol of SYMBOLS) {
    process.stdout.write(`  fetching ${symbol.padEnd(9)} ... `);
    const candles = await fetchCandles(symbol, '1h', CANDLES);
    const closes = candles.map((c) => c.close);
    console.log(`${candles.length} candles`);

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
