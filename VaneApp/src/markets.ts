// Reads the market data and chart history the pipeline publishes.
//
// Same two-document pattern as signals, and for the same reason: the split IS
// the paywall. `public/markets_latest` carries the free coins and is
// world-readable; `private/markets_all` carries all 250 and is readable only by
// a caller the security rules judge entitled. An unentitled device never
// receives the paid payload at all, so there is nothing for the client to
// "lock" — a `locked` flag is a label on data already downloaded.
//
// Chart history follows the same rule, one document per coin:
//   public/hist_BTC     free coins
//   private/hist_XRP    everything else
//
// One document per coin holds ALL SEVEN ranges. Firestore bills per document
// read, so this makes opening a coin one read and makes switching 24H -> 1Y
// instant and free rather than a fresh network round trip per tap.

import { BASE, TIMEOUT_MS, unwrap } from './api.ts';
import { appCheckHeader } from './appCheck.ts';
import { idToken } from './firebase.ts';
import { toGlobal, toHistory, toMarket } from './marketsParse.ts';
import type { GlobalMarket, History, Market } from './marketsParse.ts';

// Types and pure parsing live in marketsParse.ts, which has no native imports
// and is therefore unit-testable. This module is transport only, and re-exports
// so callers have one import site for "market data".
export { RANGES, compact, compactUnits } from './marketsParse.ts';
export type {
  GlobalMarket,
  History,
  Market,
  Range,
  Series,
} from './marketsParse.ts';

export type MarketsSnapshot = {
  /** True when the PAID document served this snapshot, not when it was asked for. */
  paid: boolean;
  coins: Market[];
  global: GlobalMarket | null;
  updatedAt: string;
  /** Provider name, for the attribution line the licence requires. */
  source: string;
};

/**
 * KNOWN LIMITATION — paid responses persist in the OS HTTP cache.
 *
 * Firestore REST sends no Cache-Control header at all, so iOS applies heuristic
 * caching and writes every response to the app's Cache.db — `private/` documents
 * included. Confirmed on a device: with AsyncStorage wiped and the network off,
 * the app still rendered paid data straight out of that store.
 *
 * This is NOT a paywall bypass. An unentitled app never requests the paid URL,
 * and a revoke test correctly downgraded 50 coins to 3 with no leak. It is a
 * data-hygiene gap: clearMarketsCache() and clearSignalsCache() empty
 * AsyncStorage but cannot reach the OS cache, so a paid payload outlives
 * sign-out, account deletion, and the CoinGecko obligation to delete all stored
 * Data on termination.
 *
 * It is NOT fixable from JavaScript here. React Native's fetch does not forward
 * a `cache` option — RCTNetworking never reads one — so `cache: 'no-store'`
 * compiles away to nothing and would only look like a fix. The real remedy is
 * native: install a zero-capacity URLCache, or call removeAllCachedResponses()
 * from the sign-out path, in AppDelegate. Left undone deliberately rather than
 * papered over.
 */

/**
 * Fetch one document, preferring the paid copy when entitled.
 *
 * Shared by markets and history because the fallback rule is subtle and must
 * not be written twice: `entitled` is the APP's belief, and the SERVER decides.
 * A lapsed or refunded subscriber whose device has not caught up asks for the
 * paid document, gets 401/403, and falls back to the free one — degrading to the
 * shop window rather than showing an error. The returned `paid` flag reports
 * which document actually answered, which is what the cache must be keyed on;
 * keying on what was requested writes free data into the paid slot.
 */
async function fetchDoc(
  freePath: string,
  paidPath: string,
  entitled: boolean,
): Promise<{ raw: any; paid: boolean } | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    // Attested even for the free document: once App Check is enforced, an
    // unattested scraper can no longer burn the 50k/day read quota and take the
    // app offline for real users.
    const headers = await appCheckHeader();

    let res: Response | null = null;
    let servedPaid = false;

    if (entitled) {
      const token = await idToken();
      if (token) {
        res = await fetch(`${BASE}/${paidPath}`, {
          signal: ctl.signal,
          headers: { ...headers, Authorization: `Bearer ${token}` },
        });
        // 401/403 — the server disagrees that we are entitled. Expected for a
        // lapsed subscription, not an error.
        //
        // 404 — the paid document does not exist. ALSO a fallback, and leaving
        // it out was a real bug: free coins were published only to `public/`,
        // so an entitled reader asking for `private/hist_BTC` got a 404 and the
        // request ended there. Every paying user saw "No chart yet" on the three
        // most-opened coins, while non-paying users saw the charts fine. The
        // publisher now writes free coins to both sides, and this is the second
        // lock — a missing paid document should always degrade to the free one
        // rather than to nothing.
        if (res.status === 401 || res.status === 403 || res.status === 404) res = null;
        else servedPaid = true;
      }
    }

    if (!res) {
      res = await fetch(`${BASE}/${freePath}`, { signal: ctl.signal, headers });
      servedPaid = false;
    }

    // 404 is a real answer — the pipeline has not published this yet — and is
    // different from a failure to reach the network. Collapsing both to null
    // would leave the screen unable to tell "nothing yet" from "broken".
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Unavailable (${res.status})`);

    const body = await res.json();
    return { raw: unwrap({ mapValue: { fields: body.fields ?? {} } }), paid: servedPaid };
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new Error('Request timed out');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchMarkets(entitled = false): Promise<MarketsSnapshot> {
  const got = await fetchDoc('public/markets_latest', 'private/markets_all', entitled);
  if (!got) {
    return { paid: false, coins: [], global: null, updatedAt: '', source: '' };
  }
  const { raw, paid } = got;

  const coins: Market[] = (Array.isArray(raw.coins) ? raw.coins : []).map(toMarket);

  return {
    paid,
    coins,
    global: raw.global ? toGlobal(raw.global) : null,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
    source: typeof raw.source === 'string' ? raw.source : '',
  };
}

export async function fetchHistory(
  sym: string,
  entitled = false,
): Promise<History | null> {
  const got = await fetchDoc(`public/hist_${sym}`, `private/hist_${sym}`, entitled);
  if (!got) return null;
  return toHistory(got.raw, sym);
}
