// The cron -> mode mapping.
//
// Worth a test despite being a switch statement: these exact strings are
// duplicated in wrangler.toml and in .github/workflows/refresh.yml, and if they
// drift the Worker fires a valid request in the WRONG mode. The failure is
// silent and asymmetric — a run that should have rebuilt history quietly refreshes
// prices instead, stored series age past CoinGecko's 24-hour refresh condition,
// and nothing errors.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { modeFor } from '../src/index.ts';

test('each scheduled expression maps to its mode', () => {
  assert.equal(modeFor('*/15 * * * *'), 'prices');
  assert.equal(modeFor('7 */4 * * *'), 'signals');
  assert.equal(modeFor('23 3 * * *'), 'history');
});

test('an unknown expression falls back to the cheap mode', () => {
  // `prices` is one provider call. Falling back to `history` would spend ~500
  // credits every time an unrecognised trigger fired.
  assert.equal(modeFor(''), 'prices');
  assert.equal(modeFor('* * * * *'), 'prices');
  assert.equal(modeFor('0 0 * * *'), 'prices');
});

test('the expressions here match wrangler.toml exactly', async () => {
  const { readFileSync } = await import('node:fs');
  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  const line = toml.split('\n').find((l) => l.trim().startsWith('crons ='));
  assert.ok(line, 'no crons line in wrangler.toml');
  for (const cron of ['*/15 * * * *', '7 */4 * * *', '23 3 * * *']) {
    assert.ok(line!.includes(cron), `wrangler.toml is missing the ${modeFor(cron)} cron: ${cron}`);
  }
});
