// Tests for the CoinGecko provider.
//
// The alignment test is the important one. `prices` and `total_volumes` come
// back as independent arrays, and zipping them by index is the natural thing to
// write — it works in every sample payload and then silently shifts every bar's
// volume by one sample the first time a volume reading is missing. That feeds
// straight into zscore(volume, 48) and changes the model's output without ever
// throwing.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { CoinGecko, chartToCandles } from '../src/providers/coingecko.ts';

const KEY = 'test-key';

/** A fetch stub that records the URLs it was asked for. */
function stub(handler: (url: URL, init?: RequestInit) => unknown, status = 200) {
  const seen: URL[] = [];
  const impl = (async (input: any, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push(url);
    const body = handler(url, init);
    if (body instanceof Response) return body;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(),
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as any;
  }) as unknown as typeof fetch;
  return { impl, seen };
}

const marketRow = (over: Record<string, unknown> = {}) => ({
  id: 'bitcoin',
  symbol: 'btc',
  name: 'Bitcoin',
  image: 'https://example.test/btc.png',
  current_price: 43000,
  market_cap: 840_000_000_000,
  market_cap_rank: 1,
  total_volume: 20_000_000_000,
  price_change_percentage_24h: 1.5,
  circulating_supply: 19_500_000,
  total_supply: 21_000_000,
  max_supply: 21_000_000,
  ath: 73000,
  ath_date: '2024-03-14T00:00:00.000Z',
  ath_change_percentage: -41,
  atl: 67.81,
  atl_date: '2013-07-06T00:00:00.000Z',
  ...over,
});

// --- construction ----------------------------------------------------------

test('a missing key fails loudly at construction, not at first request', () => {
  assert.throws(() => new CoinGecko({ apiKey: '' }), /COINGECKO_API_KEY/);
});

test('demo and pro use different hosts and different header names', async () => {
  for (const [tier, host, header] of [
    ['demo', 'api.coingecko.com', 'x-cg-demo-api-key'],
    ['pro', 'pro-api.coingecko.com', 'x-cg-pro-api-key'],
  ] as const) {
    let sawHeader: string | undefined;
    const { impl, seen } = stub((_u, init) => {
      const h = new Headers((init as any)?.headers);
      sawHeader = h.get(header) ?? undefined;
      return { data: {} };
    });
    const cg = new CoinGecko({ apiKey: KEY, tier, fetchImpl: impl });
    await cg.global();
    assert.equal(seen[0]!.host, host, `${tier} host`);
    assert.equal(sawHeader, KEY, `${tier} should send ${header}`);
  }
});

// --- chartToCandles --------------------------------------------------------

test('volumes are matched by timestamp, not zipped by index', () => {
  const t = [1000, 2000, 3000, 4000];
  const candles = chartToCandles({
    prices: t.map((ts, i) => [ts, 100 + i] as [number, number]),
    // The 2000 sample is MISSING. An index zip would assign 3000's volume to
    // the 2000 bar and shift everything after it.
    total_volumes: [
      [1000, 11],
      [3000, 33],
      [4000, 44],
    ],
  });
  assert.equal(candles.length, 4);
  assert.equal(candles[0]!.volume, 11);
  assert.equal(candles[1]!.volume, 0, 'a missing volume must be 0, not the next sample');
  assert.equal(candles[2]!.volume, 33, 'volume shifted — indexes were zipped');
  assert.equal(candles[3]!.volume, 44);
});

test('non-finite prices are dropped rather than published as NaN', () => {
  const candles = chartToCandles({
    prices: [
      [1000, 100],
      [2000, Number.NaN],
      [3000, 102],
    ],
    total_volumes: [],
  });
  assert.equal(candles.length, 2);
  assert.ok(candles.every((c) => Number.isFinite(c.close)));
});

test('candles come back oldest-first even when the payload is not', () => {
  const candles = chartToCandles({
    prices: [
      [3000, 102],
      [1000, 100],
      [2000, 101],
    ],
    total_volumes: [],
  });
  assert.deepEqual(
    candles.map((c) => c.openTime),
    [1000, 2000, 3000],
  );
});

test('a close-only payload yields bars whose OHLC all equal the close', () => {
  const [c] = chartToCandles({ prices: [[1000, 42]], total_volumes: [[1000, 7]] });
  assert.equal(c!.open, 42);
  assert.equal(c!.high, 42);
  assert.equal(c!.low, 42);
  assert.equal(c!.close, 42);
  assert.equal(c!.volume, 7);
});

// --- markets ---------------------------------------------------------------

test('markets maps every field and uppercases the ticker', async () => {
  const { impl } = stub(() => [marketRow()]);
  const cg = new CoinGecko({ apiKey: KEY, fetchImpl: impl });
  const [m] = await cg.markets(1);
  assert.equal(m!.id, 'bitcoin');
  assert.equal(m!.sym, 'BTC', 'ticker must be uppercased for the free-tier gate');
  assert.equal(m!.price, 43000);
  assert.equal(m!.rank, 1);
  assert.equal(m!.marketCap, 840_000_000_000);
  assert.equal(m!.maxSupply, 21_000_000);
  assert.equal(m!.ath, 73000);
  assert.equal(m!.atl, 67.81);
});

test('missing optional fields become null, not zero', async () => {
  const { impl } = stub(() => [marketRow({ max_supply: null, market_cap_rank: null })]);
  const cg = new CoinGecko({ apiKey: KEY, fetchImpl: impl });
  const [m] = await cg.markets(1);
  assert.equal(m!.maxSupply, null, 'no max supply is not a max supply of zero');
  assert.equal(m!.rank, null);
});

test('a row with no price is rejected rather than published as $0', async () => {
  const { impl } = stub(() => [marketRow({ current_price: null })]);
  const cg = new CoinGecko({ apiKey: KEY, fetchImpl: impl });
  await assert.rejects(() => cg.markets(1), /missing current_price/);
});

test('markets requests one page of 250 rather than one call per coin', async () => {
  const { impl, seen } = stub(() =>
    Array.from({ length: 250 }, (_, i) => marketRow({ id: `c${i}`, symbol: `c${i}` })),
  );
  const cg = new CoinGecko({ apiKey: KEY, fetchImpl: impl });
  const out = await cg.markets(250);
  assert.equal(out.length, 250);
  assert.equal(cg.callsUsed(), 1, '250 coins must cost 1 credit, not 250');
  assert.equal(seen[0]!.searchParams.get('per_page'), '250');
});

test('markets stops paging when a short page says the list ended', async () => {
  const { impl } = stub((u) => {
    const page = Number(u.searchParams.get('page'));
    if (page === 1) {
      return Array.from({ length: 250 }, (_, i) => marketRow({ id: `a${i}`, symbol: `a${i}` }));
    }
    // A short second page means there is no third.
    return Array.from({ length: 10 }, (_, i) => marketRow({ id: `b${i}`, symbol: `b${i}` }));
  });
  const cg = new CoinGecko({ apiKey: KEY, fetchImpl: impl });
  const out = await cg.markets(1000);
  assert.equal(out.length, 260);
  assert.equal(cg.callsUsed(), 2, 'should not keep paging past the end of the list');
});

// --- errors and retries ----------------------------------------------------

test('a 429 is retried and then succeeds', async () => {
  let n = 0;
  const impl = (async () => {
    n += 1;
    if (n === 1) {
      return {
        ok: false,
        status: 429,
        headers: new Headers({ 'retry-after': '0' }),
        text: async () => 'rate limited',
        json: async () => ({}),
      } as any;
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => [marketRow()],
      text: async () => '',
    } as any;
  }) as unknown as typeof fetch;

  const cg = new CoinGecko({ apiKey: KEY, fetchImpl: impl });
  const out = await cg.markets(1);
  assert.equal(out.length, 1);
  assert.ok(n >= 2, 'should have retried the 429');
});

test('a 401 names the tier/host mismatch, which is the usual cause', async () => {
  const impl = (async () =>
    ({
      ok: false,
      status: 401,
      headers: new Headers(),
      text: async () => 'unauthorized',
      json: async () => ({}),
    }) as any) as unknown as typeof fetch;
  const cg = new CoinGecko({ apiKey: KEY, tier: 'pro', fetchImpl: impl });
  await assert.rejects(() => cg.markets(1), /tier=pro/);
});

test('a transport failure is retried', async () => {
  let n = 0;
  const impl = (async () => {
    n += 1;
    if (n === 1) throw new TypeError('fetch failed');
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => [marketRow()],
      text: async () => '',
    } as any;
  }) as unknown as typeof fetch;
  const cg = new CoinGecko({ apiKey: KEY, fetchImpl: impl });
  assert.equal((await cg.markets(1)).length, 1);
  assert.ok(n >= 2);
});

// --- signal series ---------------------------------------------------------

test('signalSeries asks for hourly data and returns the trailing window', async () => {
  const HOUR = 3_600_000;
  const t0 = 1_700_000_000_000;
  const { impl, seen } = stub(() => ({
    prices: Array.from({ length: 300 }, (_, i) => [t0 + i * HOUR, 100 + i]),
    total_volumes: Array.from({ length: 300 }, (_, i) => [t0 + i * HOUR, 1000 + i]),
  }));
  const cg = new CoinGecko({ apiKey: KEY, fetchImpl: impl });
  const out = await cg.signalSeries('bitcoin', 200);

  assert.equal(seen[0]!.searchParams.get('interval'), 'hourly');
  assert.equal(out.length, 200, 'should trim to the requested window');
  assert.equal(out[out.length - 1]!.close, 399, 'must keep the NEWEST bars');
  assert.ok(out[0]!.openTime < out[out.length - 1]!.openTime);
});

test('signalSeries url-encodes ids so an odd id cannot break the path', async () => {
  const { impl, seen } = stub(() => ({ prices: [[1, 1]], total_volumes: [] }));
  const cg = new CoinGecko({ apiKey: KEY, fetchImpl: impl });
  await cg.signalSeries('some/odd id', 1);
  assert.ok(seen[0]!.pathname.includes('some%2Fodd%20id'), seen[0]!.pathname);
});

// --- global ----------------------------------------------------------------

test('global extracts dominance and totals', async () => {
  const { impl } = stub(() => ({
    data: {
      total_market_cap: { usd: 2.4e12 },
      total_volume: { usd: 9e10 },
      market_cap_percentage: { btc: 54.3 },
      market_cap_change_percentage_24h_usd: -1.2,
    },
  }));
  const cg = new CoinGecko({ apiKey: KEY, fetchImpl: impl });
  const g = await cg.global();
  assert.equal(g!.totalMarketCap, 2.4e12);
  assert.equal(g!.btcDominance, 54.3);
  assert.equal(g!.marketCapChange24hPct, -1.2);
});

test('global tolerates a payload with no data block', async () => {
  const { impl } = stub(() => ({}));
  const cg = new CoinGecko({ apiKey: KEY, fetchImpl: impl });
  assert.equal(await cg.global(), null);
});
