// Optional local .env loading.
//
// The API key must never reach a tracked file. This repository is PUBLIC, so a
// key committed to it is a key published to the internet — and unlike a leaked
// password there is no login prompt to notice it being used, just someone else's
// requests quietly spending your monthly credits until the quota runs out mid
// refresh.
//
// So: `.env` is gitignored (at the repo root and again here), this loader is
// optional, and CI supplies the same variables through GitHub Secrets instead.
// Nothing in the pipeline ever writes a key anywhere.
//
// Imported for side effects, before anything reads process.env:
//   import './env.ts';

import { existsSync } from 'node:fs';

/** Candidate locations, nearest first. */
const CANDIDATES = [
  new URL('../.env', import.meta.url),
  new URL('../../.env', import.meta.url),
];

for (const url of CANDIDATES) {
  const path = decodeURIComponent(url.pathname);
  if (!existsSync(path)) continue;
  try {
    // Node 22+. Values already present in the environment win, so an explicit
    // `COINGECKO_API_KEY=... npm run probe` still overrides the file — which is
    // what you want when testing a second key without editing anything.
    process.loadEnvFile(path);
  } catch {
    // A malformed .env should not stop a run that may not need it at all. The
    // caller reports a missing key far more helpfully than a parse error here.
  }
  break;
}
