// CoinGecko provider.
//
// This replaces Binance as the data source. Not because Binance was worse
// technically — it was free, keyless and had nine years of hourly candles — but
// because its Vision Dataset Terms (v1.0, 26 Aug 2026) license the data under
// CC BY-NC-SA 4.0, clause 3.4 says "Commercial licensing is strictly excluded",
// and clause 2.4 pulls "derivative analytical indicators" inside that scope. A
// paid subscription app is commercial use. Coinbase, Kraken, OKX and Bybit are
// all stricter. CoinGecko's API Terms §4.1.6 is the only affirmative grant at
// an indie price: "You are entitled to charge for your services and products
// that incorporate or integrates our CoinGecko API."
//
// Three obligations ride along with that grant, and they are requirements here
// rather than notes in a document:
//
//   1. Stored data must be refreshed at least every 24 hours. That makes the
//      daily rebuild in refresh.ts a compliance floor, not a tuning choice.
//   2. "Powered by CoinGecko" must appear in the app at font size >= 10, on
//      every tier including paid.
//   3. All stored data must be deleted if API access is ever terminated.
//
// ATTRIBUTION and quota notes live with the code that can violate them.

import type {
  Candle,
  CoinMarket,
  GlobalMarket,
  Interval,
  MarketProvider,
} from './types.ts';

const DEMO_BASE = 'https://api.coingecko.com/api/v3';
const PRO_BASE = 'https://pro-api.coingecko.com/api/v3';

/**
 * Requests per minute we allow ourselves.
 *
 * Demo is documented at 100/min and Basic at 300/min. We stay well under both:
 * a 429 costs a retry and a delay, and the pipeline is never in a hurry — it
 * runs on a cron, not in front of a user. Being slow is free; being throttled
 * mid-run leaves the published document half-updated.
 */
const RPM = { demo: 30, pro: 200 } as const;

/**
 * How far back each tier may query historical data.
 *
 * Demo is capped at 365 days and says so with error_code 10012: "Public API
 * users are limited to querying historical data within the past 365 days."
 * Asking for `days=max` on a Demo key is therefore a hard 401, not a degraded
 * response — which took a live probe to discover, because every stub happily
 * returns whatever it is given.
 *
 * Basic reaches 2 years; Analyst and above reach 2013. `pro` here means "any
 * paid tier", so it takes the conservative Basic figure and can be raised with
 * MAX_HISTORY_DAYS when the plan allows more.
 */
const MAX_HISTORY_DAYS = { demo: 365, pro: 730 } as const;

export type CoinGeckoOptions = {
  apiKey: string;
  /** Demo keys and paid keys use different hosts AND different header names. */
  tier?: 'demo' | 'pro';
  /** Override for tests. */
  fetchImpl?: typeof fetch;
};

export class CoinGecko implements MarketProvider {
  readonly name = 'coingecko';

  private readonly key: string;
  private readonly tier: 'demo' | 'pro';
  private readonly base: string;
  private readonly minGapMs: number;
  private readonly doFetch: typeof fetch;
  private lastCallAt = 0;
  private calls = 0;
  /** Furthest back this key may ask. See MAX_HISTORY_DAYS. */
  readonly maxHistoryDays: number;

  constructor(opts: CoinGeckoOptions) {
    if (!opts.apiKey) {
      throw new Error(
        'CoinGecko API key missing. Set COINGECKO_API_KEY. A free Demo key is ' +
          'enough for development; commercial distribution needs a paid tier.',
      );
    }
    this.key = opts.apiKey;
    this.tier = opts.tier ?? 'demo';
    this.base = this.tier === 'pro' ? PRO_BASE : DEMO_BASE;
    this.minGapMs = Math.ceil(60_000 / RPM[this.tier]);
    // Validated, because an unparseable override became NaN and was sent as
    // `days=NaN`. The 10012 retry is gated on `asked > 365`, which is false for
    // NaN, so it never fired either — a typo produced a request that could not
    // succeed and could not recover.
    const rawMax = process.env.MAX_HISTORY_DAYS;
    const parsedMax = rawMax === undefined ? MAX_HISTORY_DAYS[this.tier] : Number(rawMax);
    if (!Number.isFinite(parsedMax) || parsedMax <= 0) {
      throw new Error(
        `MAX_HISTORY_DAYS must be a positive number of days, got "${rawMax}". ` +
          'Use a day count (365, 730); "max" is not accepted here.',
      );
    }
    this.maxHistoryDays = Math.floor(parsedMax);
    this.doFetch = opts.fetchImpl ?? fetch;
  }

  callsUsed(): number {
    return this.calls;
  }

  /**
   * One request, throttled and retried.
   *
   * The throttle is a minimum gap rather than a token bucket on purpose: a
   * bucket lets a burst through and then stalls, which under a per-minute cap
   * means the burst earns the 429 the bucket was meant to prevent.
   */
  private async get<T>(path: string, params: Record<string, string | number>): Promise<T> {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

    const header = this.tier === 'pro' ? 'x-cg-pro-api-key' : 'x-cg-demo-api-key';

    for (let attempt = 0; attempt < 4; attempt++) {
      const wait = this.lastCallAt + this.minGapMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastCallAt = Date.now();
      this.calls += 1;

      let res: Response;
      try {
        res = await this.doFetch(url, {
          headers: { [header]: this.key, accept: 'application/json' },
          signal: AbortSignal.timeout(20_000),
        });
      } catch (e) {
        // Transport failure. Worth retrying; a reset connection once dropped a
        // whole coin from the published document for half an hour.
        if (attempt === 3) throw e;
        await sleep(600 * 2 ** attempt);
        continue;
      }

      if (res.status === 429) {
        // Honour Retry-After when present; CoinGecko sends it in seconds.
        const after = Number(res.headers.get('retry-after') ?? '0');
        const backoff = after > 0 ? after * 1000 : 2_000 * 2 ** attempt;
        if (attempt === 3) {
          throw new Error(`coingecko 429 after ${attempt + 1} attempts: ${path}`);
        }
        await sleep(backoff);
        continue;
      }

      if (res.status >= 500) {
        if (attempt === 3) throw new Error(`coingecko ${res.status}: ${path}`);
        await sleep(800 * 2 ** attempt);
        continue;
      }

      if (!res.ok) {
        // A 4xx is a real error in the request. 401 means the key is wrong for
        // the host: a Demo key sent to pro-api, or a paid key sent to the
        // public host, both answer 401 and look identical to an expired key.
        const body = await res.text().catch(() => '');
        const hint =
          res.status === 401
            ? ` — check the key matches the tier (tier=${this.tier}, host=${this.base})`
            : '';
        throw new Error(`coingecko ${res.status} ${path}${hint}: ${body.slice(0, 300)}`);
      }

      return (await res.json()) as T;
    }
    throw new Error(`coingecko: exhausted retries for ${path}`);
  }

  /**
   * Ranked market data.
   *
   * ONE call returns 250 coins with price, market cap, rank, volume, supply,
   * ATH and ATL. Fetching those per coin would be 250 calls for the same bytes,
   * and is the single easiest way to burn the monthly credit budget — CoinGecko
   * bills a flat 1 call = 1 credit, so a loop costs 250x what a page costs.
   */
  async markets(limit: number): Promise<CoinMarket[]> {
    const PER_PAGE = 250;
    const out: CoinMarket[] = [];

    // per_page stays CONSTANT while page increments.
    //
    // Shrinking it on the last request looks like a courtesy and is a bug:
    // CoinGecko interprets `page` relative to `per_page`, so page 2 at
    // per_page=50 returns ranks 51-100, not 251-300. UNIVERSE_SIZE=300 came back
    // as 300 rows with only 250 unique — ranks 251-300 never fetched — and
    // fetchUniverse then logged the duplicates as bogus "ticker collisions".
    // The list silently capped at 250 for any non-multiple of 250.
    for (let page = 1; out.length < limit; page++) {
      const rows = await this.get<CgMarketRow[]>('/coins/markets', {
        vs_currency: 'usd',
        order: 'market_cap_desc',
        per_page: PER_PAGE,
        page,
        sparkline: 'false',
        price_change_percentage: '24h',
      });
      if (rows.length === 0) break;
      for (const r of rows) out.push(toCoinMarket(r));
      if (rows.length < PER_PAGE) break;
    }

    return out.slice(0, limit);
  }

  /**
   * Hourly closes and volumes for the signal model.
   *
   * IMPORTANT SEMANTIC DIFFERENCE FROM BINANCE, and it affects the model.
   *
   * Binance's kline volume is the volume traded *within that candle*.
   * CoinGecko's `total_volumes` is the *rolling 24-hour* volume as it stood at
   * that timestamp. They are not the same series, and `signal.ts` feeds volume
   * through `zscore(volumes, 48)`.
   *
   * Differencing the rolling series does not recover per-bar volume — a rolling
   * window's first difference is (new hour - dropped hour), not the new hour. So
   * there is no transformation that makes these equivalent, and pretending
   * otherwise would be a silent model change dressed as a refactor.
   *
   * The rolling series is smoother and less spiky, which will compress the
   * z-score's range and weaken that feature's contribution. THE BACKTEST MUST
   * BE RE-RUN before any of this is published as a signal, and `calibration.json`
   * must stay `enabled: false` until it is. That gate already exists in
   * publish.ts and is doing real work here.
   */
  async signalSeries(id: string, hours: number): Promise<Candle[]> {
    // CoinGecko's hourly granularity is served by day count, not bar count.
    const days = Math.min(90, Math.max(2, Math.ceil(hours / 24)));
    return (await this.candles(id, days, 'hourly')).slice(-hours);
  }

  /**
   * Raw candles at one resolution.
   *
   * `interval` is sent only when given. Its availability on a Demo key is
   * genuinely ambiguous in CoinGecko's own documentation — their changelog says
   * hourly works on all plans, their endpoint reference describes interval
   * overrides as paid-only. So a 4xx that names `interval` is retried once
   * without it rather than failing the coin: degrading to automatic granularity
   * yields a coarser chart, which is far better than no chart.
   */
  async candles(id: string, days: number | 'max', interval?: Interval): Promise<Candle[]> {
    const path = `/coins/${encodeURIComponent(id)}/market_chart`;
    // 'max' means "as far back as this key can reach", not "all of history".
    // Sending a literal max on a capped tier is rejected outright rather than
    // trimmed, so the clamp has to happen here.
    const asked = days === 'max' ? this.maxHistoryDays : Math.min(days, this.maxHistoryDays);
    const params: Record<string, string | number> = { vs_currency: 'usd', days: asked };

    try {
      const chart = await this.get<CgMarketChart>(path, {
        ...params,
        ...(interval ? { interval } : {}),
      });
      return chartToCandles(chart);
    } catch (e) {
      const msg = (e as Error).message;

      // NEVER fall back on an authentication failure.
      //
      // This was a real bug, found by probing with a deliberately invalid key.
      // `interval` is the part of this request that requires authentication —
      // market_chart WITHOUT it answers from CoinGecko's public tier, with no
      // key at all. So a missing or wrong key surfaces here as a 401 on the
      // interval request, and falling back silently produced a working-looking
      // pipeline running unauthenticated on the public tier: coarser bars, and
      // no commercial licence whatsoever. That is the exact failure this
      // migration exists to prevent, so it has to be loud.
      // 10012: the window reaches further back than the plan allows. Retry once
      // at the documented Demo ceiling rather than losing the coin — a shorter
      // chart is a real chart, and the alternative is no long-range series at all.
      if (/10012|allowed time range/i.test(msg) && asked > 365) {
        console.warn(`${id}: ${asked}d exceeds this plan's history window, retrying at 365d`);
        return chartToCandles(
          await this.get<CgMarketChart>(path, {
            ...params,
            days: 365,
            ...(interval ? { interval } : {}),
          }),
        );
      }

      // The guard has to be the WIDE one and the fallback the NARROW one. It
      // was the other way round: auth matched only 401/10002 while the fallback
      // triggered on any 4xx, so two cases leaked straight past it into an
      // unauthenticated public-tier request —
      //
      //   403 / error_code 10011 — how CoinGecko reports a revoked, wrong-host
      //     or over-quota key. The single most likely way a key stops working.
      //   429 after retry exhaustion — the thrown message is
      //     "coingecko 429 after 4 attempts", which /coingecko 4\d\d/ matches.
      //     Rate limiting was being misread as a rejected interval, and the
      //     retry (issued after the throttle gap, often in a fresh minute) could
      //     then SUCCEED — putting automatic-granularity bars for one coin into
      //     a document where every other coin is hourly. Mixed resolution in one
      //     chart set, no error anywhere.
      //
      // Both produce the outcome this whole migration exists to prevent: a
      // pipeline that looks healthy while running with no commercial licence.
      if (/10002|10010|10011|API Key Missing|not authorized|coingecko 40[13]|coingecko 429/i.test(msg)) {
        throw e;
      }

      // Only a genuine "this plan does not offer that granularity" falls back.
      const rejectedInterval = interval && /coingecko 4\d\d/.test(msg);
      if (!rejectedInterval) throw e;

      console.warn(
        `${id}: interval=${interval} rejected, falling back to automatic ` +
          `granularity (coarser bars). This is a PLAN limitation, not an auth ` +
          `problem — adjust RANGE_PLAN in history.ts if it persists.`,
      );
      return chartToCandles(await this.get<CgMarketChart>(path, params));
    }
  }

  /**
   * Candles across an explicit time window, paged.
   *
   * Needed because `market_chart` serves hourly data only for a trailing window
   * — roughly 90 days — while the backtest wants closer to a year. The range
   * endpoint takes explicit bounds, so a long history is assembled from
   * consecutive windows.
   *
   * HOW FAR BACK THIS CAN REACH IS TIER-DEPENDENT, and it is the one place where
   * the data licence sets a research limit rather than a product limit:
   * CoinGecko documents hourly depth as 1 year on Demo and 2 years on Basic.
   * Asking for more silently returns less rather than erroring, so the caller
   * must check what it actually got instead of assuming the window was honoured.
   */
  async candlesRange(
    id: string,
    fromMs: number,
    toMs: number,
    interval: Interval = 'hourly',
    windowDays = 80,
  ): Promise<Candle[]> {
    const path = `/coins/${encodeURIComponent(id)}/market_chart/range`;
    const step = windowDays * 24 * 3_600_000;
    const seen = new Map<number, Candle>();

    for (let start = fromMs; start < toMs; start += step) {
      const end = Math.min(toMs, start + step);
      let chart: CgMarketChart;
      try {
        chart = await this.get<CgMarketChart>(path, {
          vs_currency: 'usd',
          // The range endpoint takes SECONDS, not milliseconds. Passing ms
          // returns an empty series rather than an error, which reads as "this
          // coin has no history" for every coin at once.
          from: Math.floor(start / 1000),
          to: Math.floor(end / 1000),
          interval,
        });
      } catch (e) {
        const msg = (e as Error).message;

        // Auth and rate limiting are never "this window is too old". Swallowing
        // them here reintroduced exactly the degraded-but-working state that
        // candles() was fixed to prevent: with an invalid key this returned []
        // rather than throwing.
        if (/10002|10010|10011|API Key Missing|not authorized|coingecko 40[13]|coingecko 429/i.test(msg)) {
          throw e;
        }

        // CONTINUE, not break.
        //
        // The loop runs OLDEST window first, and the tier-depth limit always
        // rejects the oldest window first — so `break` discarded everything
        // before anything had been collected. A 365-day request against a
        // 90-day plan returned 0 candles when ~2,160 hourly bars were
        // available, and the backtest then reported the entire universe as
        // "too little history".
        console.warn(
          `${id}: window at ${new Date(start).toISOString().slice(0, 10)} ` +
            `unavailable (${msg.slice(0, 70)}) — skipping it, keeping the rest`,
        );
        continue;
      }
      const page = chartToCandles(chart);
      if (page.length === 0) continue;
      // Windows can overlap at their boundaries; dedupe by timestamp rather
      // than concatenating, which would double a bar and shift every indicator.
      for (const c of page) seen.set(c.openTime, c);
    }

    return [...seen.values()].sort((a, b) => a.openTime - b.openTime);
  }

  async global(): Promise<GlobalMarket | null> {
    const res = await this.get<CgGlobal>('/global', {});
    const d = res?.data;
    if (!d) return null;
    return {
      totalMarketCap: num(d.total_market_cap?.usd),
      totalVolume24h: num(d.total_volume?.usd),
      btcDominance: num(d.market_cap_percentage?.btc),
      marketCapChange24hPct: num(d.market_cap_change_percentage_24h_usd),
    };
  }
}

// --- wire shapes -----------------------------------------------------------

type CgMarketRow = {
  id: string;
  symbol: string;
  name: string;
  image?: string | null;
  current_price?: number | null;
  market_cap?: number | null;
  market_cap_rank?: number | null;
  total_volume?: number | null;
  price_change_percentage_24h?: number | null;
  circulating_supply?: number | null;
  total_supply?: number | null;
  max_supply?: number | null;
  ath?: number | null;
  ath_date?: string | null;
  ath_change_percentage?: number | null;
  atl?: number | null;
  atl_date?: string | null;
};

type CgMarketChart = {
  prices?: [number, number][];
  total_volumes?: [number, number][];
};

type CgGlobal = {
  data?: {
    total_market_cap?: { usd?: number };
    total_volume?: { usd?: number };
    market_cap_percentage?: { btc?: number };
    market_cap_change_percentage_24h_usd?: number;
  };
};

function toCoinMarket(r: CgMarketRow): CoinMarket {
  return {
    id: r.id,
    sym: String(r.symbol ?? '').toUpperCase(),
    name: r.name ?? r.id,
    image: r.image ?? null,
    // A row with no price is unusable downstream; surface it rather than
    // publishing a zero that renders as "$0.00" beside a real market cap.
    price: mustNum(r.current_price, `${r.id}: missing current_price`),
    marketCap: num(r.market_cap),
    rank: num(r.market_cap_rank),
    volume24h: num(r.total_volume),
    change24hPct: num(r.price_change_percentage_24h),
    circulating: num(r.circulating_supply),
    totalSupply: num(r.total_supply),
    maxSupply: num(r.max_supply),
    ath: num(r.ath),
    athDate: r.ath_date ?? null,
    athChangePct: num(r.ath_change_percentage),
    atl: num(r.atl),
    atlDate: r.atl_date ?? null,
  };
}

/**
 * Turn a market_chart payload into candles.
 *
 * `prices` and `total_volumes` are independent arrays and are NOT guaranteed to
 * be the same length or to share timestamps. Zipping them by index is the
 * obvious mistake: one missing volume sample shifts every later bar's volume by
 * one hour, which is invisible in a chart and corrupts the z-score feature. So
 * volumes are indexed by timestamp and looked up.
 */
export function chartToCandles(chart: CgMarketChart): Candle[] {
  const prices = (chart.prices ?? []).filter(([, p]) => Number.isFinite(p));
  const vols = (chart.total_volumes ?? [])
    .filter(([, v]) => Number.isFinite(v))
    .sort((a, b) => a[0] - b[0]);

  // NEAREST-WITHIN-TOLERANCE, not exact equality.
  //
  // The premise for matching by timestamp at all is that `prices` and
  // `total_volumes` are sampled independently — and exact equality turns that
  // premise into a trap. A uniform skew of a few seconds makes EVERY lookup miss
  // and every volume 0, which is indistinguishable from genuine zero volume and
  // silently kills both the volume chart and the model's volume feature. A
  // four-second offset was enough to zero the whole series.
  //
  // Two minutes: far above any plausible clock skew, far below the 60-minute
  // spacing of the finest series we request. It must stay well under that
  // spacing, or a bar with a genuinely missing volume sample would silently
  // adopt its neighbour's — trading one wrong number for another.
  const TOLERANCE_MS = 2 * 60_000;
  let vi = 0;
  const out: Candle[] = [];
  let matched = 0;

  for (const [t, p] of prices.slice().sort((a, b) => a[0] - b[0])) {
    // Both series are sorted, so the search pointer only moves forward.
    while (vi + 1 < vols.length && Math.abs(vols[vi + 1]![0] - t) <= Math.abs(vols[vi]![0] - t)) {
      vi += 1;
    }
    const near = vols[vi];
    const ok = near !== undefined && Math.abs(near[0] - t) <= TOLERANCE_MS;
    if (ok) matched += 1;
    out.push({ openTime: t, open: p, high: p, low: p, close: p, volume: ok ? near![1] : 0 });
  }

  // A volume series that mostly fails to match is a shape change, not a market
  // with no trading. Say so rather than publishing a flat volume pane.
  if (vols.length > 0 && out.length > 0 && matched < out.length * 0.5) {
    console.warn(
      `volume matched only ${matched}/${out.length} samples — check whether ` +
        'the provider changed its timestamp alignment',
    );
  }

  return out;
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

function mustNum(v: unknown, msg: string): number {
  const n = num(v);
  if (n === null) throw new Error(msg);
  return n;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Build a provider from the environment. */
export function coinGeckoFromEnv(fetchImpl?: typeof fetch): CoinGecko {
  const key = process.env.COINGECKO_API_KEY ?? '';
  const tier = (process.env.COINGECKO_TIER as 'demo' | 'pro') ?? 'demo';
  return new CoinGecko({ apiKey: key, tier, fetchImpl });
}
