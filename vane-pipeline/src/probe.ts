// Probe the CoinGecko API with your own key.
//
// Everything in providers/ is tested against stubs, which proves the code does
// what the documented schemas say — not that CoinGecko actually behaves that
// way. This script closes that gap. Run it once after adding a key and before
// trusting a refresh run.
//
//   COINGECKO_API_KEY=CG-your-key npm run probe
//
// It costs about 8 credits of a 10,000/month Demo allowance, and it answers the
// two questions the stub tests cannot:
//
//   1. Does `interval=hourly` work on YOUR key? CoinGecko's changelog says it
//      is available on all plans; their endpoint reference describes interval
//      overrides as paid-only. The two disagree, so the only way to know is to
//      ask. providers/coingecko.ts degrades gracefully either way, but a silent
//      fallback to 4-day bars would make a 90-day chart look broken.
//
//   2. Are the field names what we parse? A renamed or missing field publishes
//      as null and renders as an em dash — no error anywhere.

import './env.ts';
import { coinGeckoFromEnv } from './providers/coingecko.ts';
import { cutRanges } from './history.ts';
import { buildCoin } from './publish.ts';
import { RANGES } from './providers/types.ts';

const ok = (s: string) => `  PASS  ${s}`;
const bad = (s: string) => `  FAIL  ${s}`;
const warn = (s: string) => `  WARN  ${s}`;

async function main() {
  // The commonest way to run this is with no key set at all, so that case gets
  // instructions rather than a stack trace.
  if (!process.env.COINGECKO_API_KEY) {
    console.log(
      '\nNo COINGECKO_API_KEY set.\n\n' +
        '  A free Demo key is enough for development:\n' +
        '    1. coingecko.com/en/api/pricing -> Start for Free (Demo)\n' +
        '    2. Developer Dashboard -> + Add New Key\n' +
        '    3. COINGECKO_API_KEY=CG-your-key npm run probe\n\n' +
        '  Use your OWN key. A CoinGecko licence attaches to the account that\n' +
        '  holds it, so a borrowed key carries no commercial rights for VANE —\n' +
        '  which is the entire reason this project left Binance.\n\n' +
        '  The Demo tier is NOT licensed for commercial distribution. It is fine\n' +
        '  for building and testing; charging users needs a paid tier.\n',
    );
    process.exit(1);
  }

  const provider = coinGeckoFromEnv();
  const problems: string[] = [];

  console.log('\nCoinGecko probe');
  console.log(`tier: ${process.env.COINGECKO_TIER ?? 'demo'}\n`);

  // --- 1. is the key actually BEING USED? ---------------------------------
  //
  // This check exists because the obvious version of it is wrong, and it took a
  // deliberately invalid key to notice.
  //
  // `/coins/markets` answers happily with a bogus key — CoinGecko routes an
  // unauthenticated request to its public tier instead of rejecting it. So "a
  // request succeeded" proves nothing about the key, and a probe that stops
  // there reports PASS on a key that is not working.
  //
  // The part that DOES enforce it is the `interval` override. market_chart
  // without an interval answers from the public tier; with `interval=hourly` it
  // answers 401 / error_code 10002 "API Key Missing". So the canary has to send
  // an interval, or it certifies a key that is not working.
  //
  // The distinction matters beyond this script: a keyless public tier is exactly
  // the trap this migration exists to avoid. It appears to work, and it carries
  // no commercial licence whatsoever — so shipping on it would be the Binance
  // problem again, minus the paper trail.
  try {
    // days=7, not days=1. At days=1 CoinGecko serves 5-minutely data and
    // ignores the interval entirely, so it answers without a key and the canary
    // certifies a broken key. Seven days is the shortest window where the
    // interval is actually applied — and it is the window a real range uses.
    await provider.candles('bitcoin', 7, 'hourly');
    console.log(ok('key accepted on an endpoint that enforces it'));
  } catch (e) {
    const msg = (e as Error).message;
    const keyless = /10002|API Key Missing/i.test(msg);
    console.log(bad(keyless ? 'key is NOT being accepted' : `key check failed: ${msg}`));
    console.log(
      keyless
        ? '\n  CoinGecko answered "API Key Missing". Either COINGECKO_API_KEY is\n' +
            '  wrong, or it does not match COINGECKO_TIER — a Demo key needs\n' +
            `  tier=demo, a paid key needs tier=pro (currently ${
              process.env.COINGECKO_TIER ?? 'demo'
            }).\n\n` +
            '  Note that some endpoints DO answer without a valid key, via the\n' +
            '  public tier. Do not mistake that for the key working: the public\n' +
            '  tier carries no commercial licence.\n'
        : '',
    );
    process.exit(1);
  }

  let markets;
  try {
    markets = await provider.markets(5);
    console.log(ok(`markets reachable — ${markets.length} coins returned`));
  } catch (e) {
    console.log(bad(`markets failed: ${(e as Error).message}`));
    process.exit(1);
  }

  // --- 2. every field we parse is actually present ------------------------
  const btc = markets.find((m) => m.sym === 'BTC') ?? markets[0]!;
  const required: [string, unknown][] = [
    ['id', btc.id],
    ['sym', btc.sym],
    ['name', btc.name],
    ['price', btc.price],
    ['marketCap', btc.marketCap],
    ['rank', btc.rank],
    ['volume24h', btc.volume24h],
    ['change24hPct', btc.change24hPct],
    ['circulating', btc.circulating],
    ['ath', btc.ath],
    ['atl', btc.atl],
    ['image', btc.image],
  ];
  const missing = required.filter(([, v]) => v === null || v === undefined || v === '');
  if (missing.length === 0) {
    console.log(ok(`all ${required.length} market fields present on ${btc.sym}`));
  } else {
    const names = missing.map(([k]) => k).join(', ');
    console.log(bad(`market fields missing on ${btc.sym}: ${names}`));
    problems.push(`missing market fields: ${names}`);
  }
  console.log(`        ${btc.sym} $${btc.price} rank #${btc.rank} cap ${btc.marketCap}`);

  // --- 3. does interval=hourly work? -------------------------------------
  //
  // Compared against the same window WITHOUT the override. If hourly is being
  // silently ignored, both come back the same length.
  let hourlyWorks = false;
  try {
    const withHourly = await provider.candles(btc.id, 7, 'hourly');
    const withoutHourly = await provider.candles(btc.id, 7);
    const spacing = medianSpacingHours(withHourly);
    hourlyWorks = withHourly.length > withoutHourly.length || spacing <= 1.5;
    if (hourlyWorks) {
      console.log(
        ok(`interval=hourly honoured — ${withHourly.length} bars over 7d, ~${spacing}h spacing`),
      );
    } else {
      console.log(
        warn(
          `interval=hourly appears IGNORED — ${withHourly.length} bars, ~${spacing}h spacing. ` +
            'Charts will be coarser than intended.',
        ),
      );
      problems.push('interval=hourly not honoured on this key');
    }
  } catch (e) {
    console.log(bad(`hourly probe failed: ${(e as Error).message}`));
    problems.push('hourly probe failed');
  }

  // --- 4. the signal model can actually run on this data -----------------
  //
  // buildCoin throws unless it gets 49 closed candles, and it is the one place
  // where a short series turns into a failed coin rather than a bad chart.
  try {
    const candles = await provider.signalSeries(btc.id, 1200);
    const coin = buildCoin({ sym: btc.sym, name: btc.name }, candles);
    console.log(
      ok(
        `signal built from ${candles.length} candles — ${coin.up ? 'UP' : 'DOWN'}, ` +
          `24H target ${coin.targets['24H'].price} (conf ${coin.conf ?? 'none'})`,
      ),
    );
    if (coin.conf !== null) {
      console.log(
        warn(
          'confidence is NOT null — calibration.json is enabled. It must stay ' +
            'disabled until the backtest is re-run on rolling-volume data.',
        ),
      );
      problems.push('calibration enabled before re-backtest');
    }
    const zeroVol = candles.filter((c) => c.volume === 0).length;
    if (zeroVol > candles.length / 2) {
      console.log(warn(`${zeroVol}/${candles.length} candles have zero volume`));
      problems.push('volume series is mostly empty');
    }
  } catch (e) {
    console.log(bad(`signal build failed: ${(e as Error).message}`));
    problems.push('signal build failed');
  }

  // --- 5. can every chart range be cut? ----------------------------------
  try {
    const intraday = await provider.candles(btc.id, 90, 'hourly');
    const daily = await provider.candles(btc.id, 'max', 'daily');
    const ranges = cutRanges({ intraday, daily });
    const got = RANGES.filter((r) => ranges[r]);
    const absent = RANGES.filter((r) => !ranges[r]);

    // ALL and 1Y are mutually exclusive by design when they would cover the
    // same window: on a plan capped at 365 days ALL would be a false label, and
    // for a coin younger than a year 1Y would be. Exactly one of them missing is
    // the intended outcome, not a gap.
    const yearOrAll = (r: string) => r === 'ALL' || r === '1Y';
    const realGaps = absent.filter((r) => !yearOrAll(r));
    const bothLongMissing = absent.filter(yearOrAll).length === 2;

    if (realGaps.length === 0 && !bothLongMissing) {
      const dropped = absent.find(yearOrAll);
      console.log(
        ok(
          `ranges cut — ${got.map((r) => `${r}:${ranges[r]!.c.length}`).join(' ')}` +
            (dropped
              ? `  (${dropped} correctly omitted — it would duplicate ${
                  dropped === 'ALL' ? '1Y' : 'ALL'
                })`
              : ''),
        ),
      );
      if (dropped === 'ALL') {
        console.log(
          '        this plan reaches 365 days, so there is no all-time series to show',
        );
      }
    } else {
      const missing = bothLongMissing ? absent : realGaps;
      console.log(bad(`ranges missing: ${missing.join(', ')}`));
      problems.push(`ranges missing: ${missing.join(', ')}`);
    }
  } catch (e) {
    console.log(bad(`range cut failed: ${(e as Error).message}`));
    problems.push('range cut failed');
  }

  // --- 6. global metrics -------------------------------------------------
  try {
    const g = await provider.global();
    if (g?.btcDominance) console.log(ok(`global metrics — BTC dominance ${g.btcDominance.toFixed(1)}%`));
    else {
      console.log(warn('global metrics returned nothing usable'));
      problems.push('global metrics empty');
    }
  } catch (e) {
    console.log(warn(`global metrics failed: ${(e as Error).message}`));
  }

  console.log(`\n${provider.callsUsed()} credit(s) spent.`);

  if (problems.length === 0) {
    console.log('\nAll checks passed. Safe to run a refresh.\n');
    return;
  }
  console.log(`\n${problems.length} problem(s) to resolve before trusting a refresh:`);
  for (const p of problems) console.log(`  - ${p}`);
  console.log('');
  // Non-zero so CI or a shell `&&` chain stops here rather than publishing.
  process.exit(1);
}

/** Median gap between bars, in hours. Median because a gap skews a mean. */
function medianSpacingHours(candles: { openTime: number }[]): number {
  if (candles.length < 2) return 0;
  const gaps: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    gaps.push((candles[i]!.openTime - candles[i - 1]!.openTime) / 3_600_000);
  }
  gaps.sort((a, b) => a - b);
  return Number(gaps[Math.floor(gaps.length / 2)]!.toFixed(1));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
