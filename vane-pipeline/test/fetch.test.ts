// Tests for the candle fetcher.
//
// Paging is the part most likely to break silently: an off-by-one at a page
// boundary duplicates or drops a candle every 1000 bars, which shifts every
// indicator downstream without ever throwing.

import { strict as assert } from 'node:assert';
import { afterEach, test } from 'node:test';
import { fetchCandles } from '../src/fetch.ts';

type Row = [number, string, string, string, string, string];

/** Binance returns [openTime, open, high, low, close, volume, ...]. */
const row = (openTime: number, close: number): Row => [
  openTime, String(close), String(close * 1.01), String(close * 0.99),
  String(close), '1000',
];

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Serves `total` hourly candles, honouring limit + endTime like Binance. */
function stubBinance(total: number, onCall?: (url: string) => void) {
  const HOUR = 3_600_000;
  const base = 1_700_000_000_000;
  const all = Array.from({ length: total }, (_, i) => row(base + i * HOUR, 100 + i));

  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    onCall?.(url);
    const q = new URL(url).searchParams;
    const limit = Number(q.get('limit') ?? 500);
    const endTime = q.get('endTime') ? Number(q.get('endTime')) : Infinity;
    const eligible = all.filter((r) => r[0] <= endTime);
    // Binance returns the LAST `limit` rows at or before endTime, ascending.
    const page = eligible.slice(Math.max(0, eligible.length - limit));
    return { ok: true, status: 200, json: async () => page } as any;
  }) as any;
}

test('returns candles oldest-first', async () => {
  stubBinance(300);
  const out = await fetchCandles('BTCUSDT', '1h', 300);
  assert.equal(out.length, 300);
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i].openTime > out[i - 1].openTime, `not ascending at ${i}`);
  }
});

test('pages across the 1000-row limit without duplicating a candle', async () => {
  stubBinance(2500);
  const out = await fetchCandles('BTCUSDT', '1h', 2500);
  assert.equal(out.length, 2500);
  const seen = new Set(out.map((c) => c.openTime));
  assert.equal(seen.size, out.length, 'duplicate openTime across a page boundary');
});

test('pages leave no gap at the boundary', async () => {
  stubBinance(2500);
  const out = await fetchCandles('BTCUSDT', '1h', 2500);
  const HOUR = 3_600_000;
  for (let i = 1; i < out.length; i++) {
    assert.equal(
      out[i].openTime - out[i - 1].openTime, HOUR,
      `gap at index ${i}`,
    );
  }
});

test('terminates when the exchange has less history than requested', async () => {
  stubBinance(120);
  const out = await fetchCandles('NEWCOIN', '1h', 5000);
  assert.equal(out.length, 120, 'should return what exists, not loop');
});

test('parses numeric fields rather than leaving them as strings', async () => {
  stubBinance(10);
  const [c] = await fetchCandles('BTCUSDT', '1h', 10);
  for (const k of ['open', 'high', 'low', 'close', 'volume'] as const) {
    assert.equal(typeof c[k], 'number', `${k} not parsed`);
    assert.ok(Number.isFinite(c[k]), `${k} not finite`);
  }
});

test('a 4xx surfaces as an error instead of an empty series', async () => {
  globalThis.fetch = (async () => ({
    ok: false, status: 400,
    json: async () => ({ code: -1121, msg: 'Invalid symbol.' }),
    text: async () => '{"code":-1121,"msg":"Invalid symbol."}',
  })) as any;
  await assert.rejects(() => fetchCandles('NOTACOIN', '1h', 100));
});

test('retries a transient failure and then succeeds', async () => {
  let calls = 0;
  const HOUR = 3_600_000;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) throw new TypeError('fetch failed');
    return {
      ok: true, status: 200,
      json: async () => [row(1_700_000_000_000, 100), row(1_700_000_000_000 + HOUR, 101)],
    } as any;
  }) as any;
  const out = await fetchCandles('BTCUSDT', '1h', 2);
  assert.ok(calls >= 2, 'should have retried');
  assert.equal(out.length, 2);
});
