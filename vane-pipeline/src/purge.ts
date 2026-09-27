// Delete every document derived from the market-data provider.
//
// This exists because of one clause in CoinGecko's API Terms:
//
//   "In the event that CoinGecko terminates your access to or use of the
//    CoinGecko API (regardless of reasons), you agree to promptly and
//    permanently delete all Data and any other information that you have stored
//    pursuant to your use of or access to the CoinGecko API, without keeping any
//    copy thereof unless required by applicable law."
//
// An obligation with no procedure behind it is an obligation you will not meet
// on the day it matters. This is the procedure.
//
//   npm run purge -- --dry-run     list what would be deleted
//   npm run purge -- --confirm     actually delete it
//
// WHAT COUNTS AS "DATA" HERE IS BROADER THAN THE RAW PRICES, and that is not a
// cautious reading — it is the same reasoning that moved this project off
// Binance in the first place. Binance's clause 2.4 swept in "derivative
// analytical indicators", and the signals documents are exactly that: computed
// from provider candles. So they go too, along with the history, the markets
// documents and the coin registry.
//
// WHAT IS DELIBERATELY KEPT: anything the user created. Predictions, votes,
// watchlists, entitlements and the scorecard totals are VANE's own records and a
// user's own data. Deleting a paying subscriber's track record to satisfy a data
// licence would be the wrong trade, and the licence does not ask for it.

import './env.ts';
import { adminDb } from './publish.ts';
import { loadUniverse } from './coins.ts';

type Firestore = import('firebase-admin/firestore').Firestore;

/** Fixed documents built from provider data. */
const FIXED = [
  'public/markets_latest',
  'private/markets_all',
  'public/signals_latest',
  'private/signals_all',
  'ops/universe',
  'ops/last_directions',
];

async function collectPaths(db: Firestore): Promise<string[]> {
  const paths = [...FIXED];

  // History is one document per coin per side. The registry is the reliable
  // list, but it is itself deleted here — so read it first, and fall back to
  // scanning the collections in case it is already gone.
  const universe = await loadUniverse(db).catch(() => []);
  for (const coin of universe) {
    paths.push(`private/hist_${coin.sym}`, `public/hist_${coin.sym}`);
  }

  // Belt and braces: sweep both collections for anything named hist_* that the
  // registry did not know about — a coin that dropped out of the universe still
  // has a stored document, and it is still provider data.
  for (const where of ['public', 'private'] as const) {
    const snap = await db.collection(where).get();
    for (const doc of snap.docs) {
      if (doc.id.startsWith('hist_') || doc.id.startsWith('markets_') || doc.id.startsWith('signals_')) {
        paths.push(`${where}/${doc.id}`);
      }
    }
  }

  return [...new Set(paths)];
}

async function main() {
  const dry = process.argv.includes('--dry-run');
  const confirmed = process.argv.includes('--confirm');

  if (!dry && !confirmed) {
    console.error(
      'Refusing to run without an explicit flag.\n\n' +
        '  npm run purge -- --dry-run    list what would be deleted\n' +
        '  npm run purge -- --confirm    delete it, permanently\n\n' +
        '  This is not reversible and the pipeline will republish on its next\n' +
        '  run — so if you are purging because API access ended, disable the\n' +
        '  cron in .github/workflows/refresh.yml and vane-cron FIRST, or the\n' +
        '  data comes straight back.',
    );
    process.exit(2);
  }

  const db = await adminDb();
  const paths = await collectPaths(db);

  console.log(`${paths.length} provider-derived document(s):`);
  for (const p of paths) console.log(`  ${p}`);

  if (dry) {
    console.log('\nDry run — nothing deleted.');
    return;
  }

  let deleted = 0;
  for (let i = 0; i < paths.length; i += 400) {
    const batch = db.batch();
    for (const p of paths.slice(i, i + 400)) batch.delete(db.doc(p));
    await batch.commit();
    deleted += Math.min(400, paths.length - i);
  }

  console.log(`\nDeleted ${deleted} document(s).`);
  console.log(
    'Still to do by hand, because they are outside Firestore:\n' +
      '  - revoke or delete the API key in CoinGecko\'s Developer Dashboard\n' +
      '  - clear COINGECKO_API_KEY from GitHub Secrets\n' +
      '  - delete vane-pipeline/.env on any machine that has it\n' +
      '  - disable the refresh cron so nothing republishes\n' +
      '  - note that app clients hold a cached copy until they next launch',
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
