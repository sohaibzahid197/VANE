// Binance public klines — no API key, no auth, no rate-limit signup.
// Docs: GET /api/v3/klines, max 1000 candles per call, so we page backwards.

export type Candle = {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

// Binance geo-blocks api.binance.com with HTTP 451 from some regions,
// including the US — which is where GitHub's hosted runners live. The first
// real scheduled run failed on all 30 coins for exactly that reason while the
// identical code worked from a development machine.
//
// data-api.binance.vision is Binance's read-only market-data mirror and is not
// subject to that block, so it is tried first. The others are kept as
// failovers: a host that is reachable from one network may be blocked on
// another, and this list is the only thing standing between a host change and
// the app silently serving stale prices.
const HOSTS = [
  'https://data-api.binance.vision',
  'https://api.binance.com',
  'https://api-gcp.binance.com',
];

/** The host that last answered. Probed once, then reused for the whole run. */
let host: string | null = null;

/** HTTP 451 and 403 are geo-blocks, not request errors: try the next host. */
const isBlocked = (status: number) => status === 451 || status === 403;

/** Fetch `limit` candles of `interval` for `symbol`, paging back as needed. */
/** Retries transport failures and 5xx; never retries a 4xx, which is a real
 *  error in the request itself. */
async function fetchWithRetry(url: string | URL, attempts = 3): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (res.status >= 500) throw new Error(`upstream ${res.status}`);
      return res;
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 400 * 2 ** i));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function fetchCandles(
  symbol: string,
  interval: string,
  limit: number,
): Promise<Candle[]> {
  const out: Candle[] = [];
  let endTime: number | undefined;

  while (out.length < limit) {
    const want = Math.min(1000, limit - out.length);
    const url = new URL(`${host ?? HOSTS[0]}/api/v3/klines`);
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('interval', interval);
    url.searchParams.set('limit', String(want));
    if (endTime !== undefined) url.searchParams.set('endTime', String(endTime));

    // A bare fetch has no timeout and no retry: a single connection reset
    // dropped a whole coin from the published document for 30 minutes, and
    // stalled every pending prediction on it.
    let res = await fetchWithRetry(url);

    // Only a host that has not been pinned can fail over; once one host has
    // answered, a later block from it is a real change worth failing on.
    if (isBlocked(res.status) && host === null) {
      for (const candidate of HOSTS.slice(1)) {
        const alt = new URL(url);
        alt.protocol = new URL(candidate).protocol;
        alt.host = new URL(candidate).host;
        const attempt = await fetchWithRetry(alt);
        if (!isBlocked(attempt.status)) {
          host = candidate;
          res = attempt;
          break;
        }
      }
    }
    if (res.ok && host === null) host = new URL(url).origin;

    if (!res.ok) throw new Error(`binance ${symbol} ${res.status}: ${await res.text()}`);
    const rows = (await res.json()) as unknown[][];
    if (rows.length === 0) break;

    const page = rows.map((r) => ({
      openTime: Number(r[0]),
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      volume: Number(r[5]),
    }));

    out.unshift(...page);
    endTime = page[0].openTime - 1;
    if (rows.length < want) break;
  }

  return out;
}
