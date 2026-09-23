// Reads the signals the pipeline publishes.
//
// There are TWO documents. `public/signals_latest` holds the free coins and
// is world-readable. `private/signals_all` holds everything and is readable
// only by a caller whose users/{uid}/entitlement/current document says they
// have a live subscription — the security rules enforce that, so an
// unentitled device never receives the paid payload at all.
//
// That split IS the paywall. The previous design published one world-readable
// document and marked coins `locked` in the client, which labelled data the
// device had already downloaded and left the whole product one curl away.
//
// Uses the Firestore REST API rather than @react-native-firebase, which keeps
// the native surface small; the paid read simply carries a bearer token.

import type { Coin, Horizon } from './signals.ts';
import { appCheckHeader } from './appCheck.ts';
import { idToken } from './firebase.ts';

const PROJECT_ID = 'vane-crypto';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const FREE_URL = `${BASE}/public/signals_latest`;
const PAID_URL = `${BASE}/private/signals_all`;

/** React Native's fetch has no default timeout; a stalled TCP hangs forever. */
const TIMEOUT_MS = 12000;

/** Firestore REST wraps every value in a type tag; unwrap recursively. */
function unwrap(v: any): any {
  if (v == null) return null;
  if ('nullValue' in v) return null;
  // Whole numbers arrive as integerValue — a JSON *string*.
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values ?? []).map(unwrap);
  if ('mapValue' in v) {
    const out: Record<string, any> = {};
    for (const [k, val] of Object.entries(v.mapValue.fields ?? {})) out[k] = unwrap(val);
    return out;
  }
  return null;
}

/**
 * Money formatting by magnitude. The cutoff is deliberately at 1000, not 100:
 * a three-digit asset like SOL at 214.60 rounded to $215 while the percentage
 * beside it came from the unrounded value, so a sub-$0.50 move rendered as an
 * identical price with a non-zero percent next to it.
 */
function money(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1000) return `$${Math.round(n).toLocaleString('en-US')}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

const signed = (n: number) =>
  Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${n.toFixed(1)}%` : '—';

export type Snapshot = {
  coins: Coin[];
  updatedAt: string;
  horizons: Horizon[];
};

/** Crowd tally, aggregated server-side from private per-user votes. */
export type Polls = Record<string, { up: number; total: number } | null>;

const POLLS_URL =
  `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}` +
  `/databases/(default)/documents/public/polls`;

/**
 * Fetch the crowd tally. Returns an empty map on any failure — a missing poll
 * renders as "not enough votes yet", never as a fabricated percentage.
 */
export async function fetchPolls(): Promise<Polls> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(POLLS_URL, {
      signal: ctl.signal,
      headers: await appCheckHeader(),
    });
    if (!res.ok) return {};
    const body = await res.json();
    const raw = unwrap({ mapValue: { fields: body.fields ?? {} } });
    return (raw?.polls ?? {}) as Polls;
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
}

const FALLBACK_HORIZONS: Horizon[] = ['24H', '7D', '30D'];

/**
 * Fetch the signals document.
 *
 * `entitled` is the app's belief about the subscription; the SERVER decides.
 * If the rules disagree — a lapsed or refunded subscriber whose device has
 * not caught up — the paid read returns 403 and we fall back to the free
 * document rather than showing an error, so the app degrades to the shop
 * window instead of breaking.
 */
export async function fetchSignals(entitled = false): Promise<Snapshot> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);

  let body: any;
  try {
    // Attested even for the free document: once App Check is enforced on
    // Firestore, an unattested scraper can no longer burn the 50k/day read
    // quota and take the app offline for real users.
    const headers = await appCheckHeader();

    let res: Response | null = null;
    if (entitled) {
      const token = await idToken();
      if (token) {
        res = await fetch(PAID_URL, {
          signal: ctl.signal,
          headers: { ...headers, Authorization: `Bearer ${token}` },
        });
        // 401/403 means the server does not agree we are entitled. That is
        // the expected path for an expired subscription, not an error.
        if (res.status === 401 || res.status === 403) res = null;
      }
    }

    if (!res) {
      res = await fetch(FREE_URL, { signal: ctl.signal, headers });
    }

    if (!res.ok) throw new Error(`Signals unavailable (${res.status})`);
    body = await res.json();
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new Error('Request timed out');
    throw e;
  } finally {
    clearTimeout(timer);
  }

  const raw = unwrap({ mapValue: { fields: body.fields ?? {} } });
  const horizons: Horizon[] =
    Array.isArray(raw.horizons) && raw.horizons.length ? raw.horizons : FALLBACK_HORIZONS;

  const coins: Coin[] = (raw.coins ?? []).map((c: any) => {
    const targets = {} as Coin['targets'];
    for (const hz of FALLBACK_HORIZONS) {
      const t = c.targets?.[hz];
      targets[hz] = t ? [money(t.price), signed(t.pct)] : ['—', '—'];
    }
    return {
      sym: String(c.sym ?? '?'),
      name: String(c.name ?? c.sym ?? 'Unknown'),
      price: money(c.price),
      priceNum: typeof c.price === 'number' ? c.price : 0,
      up: !!c.up,
      // Null until the model clears the backtest gate. Never coerce to 0.
      conf: typeof c.conf === 'number' ? c.conf : null,
      targets,
      rating: c.up ? 'BUY' : 'SELL',
      // Nothing that arrives here is locked. The server decides what to send:
      // an unentitled device receives only the free document, so every coin
      // in this response is one the caller is allowed to see. This used to
      // read `String(c.sym) !== 'BTC'`, a label on data already downloaded.
      locked: false,
      reasons: Array.isArray(c.reasons) ? c.reasons : [],
      history: Array.isArray(c.history)
        ? c.history.filter((n: unknown): n is number => typeof n === 'number' && Number.isFinite(n))
        : [],
    } satisfies Coin;
  });

  return { coins, updatedAt: raw.updatedAt ?? '', horizons };
}
