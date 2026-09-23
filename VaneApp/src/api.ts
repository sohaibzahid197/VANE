// Reads the single `public/signals_latest` document the pipeline publishes.
//
// Uses the Firestore REST API rather than @react-native-firebase: the document
// is world-readable, so no SDK, no auth and no native module is needed for it.
// That keeps the app's native surface small until auth actually lands.

import type { Coin, Horizon } from './signals.ts';
import { appCheckHeader } from './appCheck.ts';

const PROJECT_ID = 'vane-crypto';
const DOC = 'public/signals_latest';
const URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${DOC}`;

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

export async function fetchSignals(): Promise<Snapshot> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);

  let body: any;
  try {
    // Attested even though the document is world-readable: once App Check is
    // enforced on Firestore, an unattested scraper can no longer burn the
    // 50k/day read quota and take the app offline for real users.
    const res = await fetch(URL, {
      signal: ctl.signal,
      headers: await appCheckHeader(),
    });
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

  const coins: Coin[] = (raw.coins ?? []).map((c: any, i: number) => {
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
      // Positional gating is a stopgap: the real gate is the server not
      // sending locked detail at all. Keyed on symbol so a pipeline reorder
      // cannot silently change which coin is free.
      locked: String(c.sym) !== 'BTC',
      reasons: Array.isArray(c.reasons) ? c.reasons : [],
      history: Array.isArray(c.history)
        ? c.history.filter((n: unknown): n is number => typeof n === 'number' && Number.isFinite(n))
        : [],
    } satisfies Coin;
  });

  return { coins, updatedAt: raw.updatedAt ?? '', horizons };
}
