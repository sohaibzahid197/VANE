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
  // HOURLY spacing, which is what the provider actually returns. The original
  // version of this test spaced samples one second apart — unrealistic, and it
  // made any matching tolerance look like a bug.
  const H = 3_600_000;
  const base = 1_700_000_000_000;
  const t = [0, 1, 2, 3].map((i) => base + i * H);
  const candles = chartToCandles({
    prices: t.map((ts, i) => [ts, 100 + i] as [number, number]),
    // The second sample is MISSING. An index zip would assign the third bar's
    // volume to it and shift everything after.
    total_volumes: [
      [t[0]!, 11],
      [t[2]!, 33],
      [t[3]!, 44],
    ],
  });
  assert.equal(candles.length, 4);
  assert.equal(candles[0]!.volume, 11);
  assert.equal(candles[1]!.volume, 0, 'a missing volume must be 0, not a neighbour an hour away');
  assert.equal(candles[2]!.volume, 33, 'volume shifted — indexes were zipped');
  assert.equal(candles[3]!.volume, 44);
});

test('a few seconds of clock skew does not zero every volume', () => {
  // The premise for matching on timestamps is that the two series are sampled
  // INDEPENDENTLY — which makes exact equality a trap. A uniform four-second
  // offset made every lookup miss and every volume 0, indistinguishable from a
  // market with no trading, silently killing both the volume pane and the
  // model's volume feature.
  const H = 3_600_000;
  const base = 1_700_000_000_000;
  const n = 6;
  const candles = chartToCandles({
    prices: Array.from({ length: n }, (_, i) => [base + i * H, 100 + i] as [number, number]),
    total_volumes: Array.from(
      { length: n },
      (_, i) => [base + i * H + 4_000, 1_000_000 + i] as [number, number],
    ),
  });
  assert.equal(candles.length, n);
  assert.ok(
    candles.every((c) => c.volume > 0),
    `skew zeroed volumes: ${candles.map((c) => c.volume).join(',')}`,
  );
  assert.equal(candles[0]!.volume, 1_000_000, 'and each bar keeps its OWN volume');
  assert.equal(candles[n - 1]!.volume, 1_000_000 + n - 1);
});

test('a skew on only the live snapshot still matches it', () => {
  const H = 3_600_000;
  const base = 1_700_000_000_000;
  const candles = chartToCandles({
    prices: [
      [base, 100],
      [base + H, 101],
      [base + H + 46 * 60_000, 102],
    ],
    total_volumes: [
      [base, 10],
      [base + H, 11],
      [base + H + 46 * 60_000 + 3_000, 12],
    ],
  });
  assert.equal(candles[2]!.volume, 12, 'the live snapshot lost its volume');
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

// --- the auth guard must be wider than the fallback -------------------------
//
// The fallback exists for "this plan has no such granularity". It must NEVER
// absorb an authentication or rate-limit failure, because doing so produces a
// pipeline that looks healthy while running unauthenticated on the public tier
// — with no commercial licence, which is the exact failure the migration to a
// licensed provider exists to prevent.

/** Fails the interval request with `status`, succeeds without an interval. */
function intervalFails(status: number, body: unknown) {
  let fallbackCalls = 0;
  const impl = (async (input: any) => {
    const url = new URL(String(input));
    if (url.searchParams.has('interval')) {
      return {
        ok: false,
        status,
        headers: new Headers(),
        text: async () => JSON.stringify(body),
        json: async () => body,
      } as any;
    }
    fallbackCalls += 1;
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ prices: [[1000, 10]], total_volumes: [[1000, 1]] }),
      text: async () => '',
    } as any;
  }) as unknown as typeof fetch;
  return { impl, calls: () => fallbackCalls };
}

test('a 403 revoked key THROWS instead of falling back unauthenticated', async () => {
  // 10011 is how CoinGecko reports a revoked/wrong-host key — the likeliest way
  // a key stops working, and it used to take the fallback silently.
  const { impl, calls } = intervalFails(403, {
    status: { error_code: 10011, error_message: 'This request is not authorized with your key' },
  });
  const cg = new CoinGecko({ apiKey: KEY, fetchImpl: impl });
  await assert.rejects(() => cg.candles('bitcoin', 7, 'hourly'));
  assert.equal(calls(), 0, 'must NOT have issued an unauthenticated request');
});

test('exhausted rate limiting THROWS instead of degrading resolution', async () => {
  // The thrown message is "coingecko 429 after N attempts", which the old
  // /coingecko 4\d\d/ fallback matched — so a throttled coin silently came back
  // at automatic granularity inside an otherwise-hourly document.
  const impl = (async (input: any) => {
    const url = new URL(String(input));
    if (url.searchParams.has('interval')) {
      return {
        ok: false,
        status: 429,
        headers: new Headers({ 'retry-after': '0' }),
        text: async () => 'rate limited',
        json: async () => ({}),
      } as any;
    }
    return {
      ok: true, status: 200, headers: new Headers(),
      json: async () => ({ prices: [[1000, 10]], total_volumes: [] }),
      text: async () => '',
    } as any;
  }) as unknown as typeof fetch;

  const cg = new CoinGecko({ apiKey: KEY, fetchImpl: impl });
  await assert.rejects(() => cg.candles('bitcoin', 7, 'hourly'), /429/);
});

test('a genuine plan limitation still falls back to coarser bars', async () => {
  // 10005 is "this endpoint requires a higher plan" — the one case the fallback
  // is for. Degrading beats losing the coin.
  const { impl, calls } = intervalFails(400, {
    status: { error_code: 10005, error_message: 'exclusive to paid plan subscribers' },
  });
  const cg = new CoinGecko({ apiKey: KEY, fetchImpl: impl });
  const out = await cg.candles('bitcoin', 7, 'hourly');
  assert.equal(out.length, 1, 'should have returned the fallback series');
  assert.equal(calls(), 1);
});

test('an unparseable MAX_HISTORY_DAYS fails loudly rather than sending days=NaN', () => {
  const prev = process.env.MAX_HISTORY_DAYS;
  process.env.MAX_HISTORY_DAYS = 'max';
  try {
    assert.throws(() => new CoinGecko({ apiKey: KEY }), /positive number of days/);
  } finally {
    if (prev === undefined) delete process.env.MAX_HISTORY_DAYS;
    else process.env.MAX_HISTORY_DAYS = prev;
  }
});
