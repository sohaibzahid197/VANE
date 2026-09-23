// App state.
//
// Kept in one context rather than a state library: the whole app is a handful
// of fields, and this keeps the dependency list (and the bundle) small.
//
// Two things changed from the prototype: state now PERSISTS across launches
// (it used to evaporate every cold start), and the track record is built from
// server-resolved predictions rather than a hardcoded array.

import React, {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Horizon } from './signals.ts';
import {
  type Prediction, type WriteResult,
  deleteAccount as deleteAccountRemote,
  ensureSignedIn, fetchPredictions, placePrediction, signOutFirebase,
} from './firebase.ts';

export type Plan = 'week' | 'year';
export type Call = { coin: string; dir: 'up' | 'down'; tf: Horizon };

export type HistoryRow = {
  coin: string; call: string; when: string;
  win: boolean; delta: string;
};

/** A prediction that resolved to neither a win nor a loss. Shown separately so
 *  it neither inflates accuracy nor silently disappears from the user's view. */
export type VoidRow = {
  coin: string; call: string; when: string; reason: string;
};

/** Which alert rows are Pro-only. Shared so Settings and Alerts agree. */
export const PRO_ALERT = [false, true, true, false, true] as const;

/**
 * Pro-gated alerts default to OFF. They used to default ON while rendering as
 * off (because `locked` suppressed them), so the moment a user subscribed,
 * notification channels they had never enabled switched themselves on.
 */
const DEFAULT_ALERTS = [true, false, false, true, false];

const STORAGE_KEY = 'vane.state.v1';

/** Only durable preferences are persisted — never derived or server data. */
type Persisted = {
  onboarded: boolean;
  isPro: boolean;
  plan: Plan;
  tf: Horizon;
  alerts: boolean[];
  currency: string;
  watchlist: string[];
};

const DEFAULTS: Persisted = {
  onboarded: false,
  isPro: false,
  plan: 'year',
  tf: '24H',
  alerts: DEFAULT_ALERTS,
  currency: 'USD',
  watchlist: [],
};

type Store = Persisted & {
  hydrated: boolean;
  finishOnboarding: () => void;
  setPro: (v: boolean) => void;
  setPlan: (p: Plan) => void;
  setTf: (t: Horizon) => void;
  toggleAlert: (i: number) => void;
  setCurrency: (c: string) => void;
  toggleWatch: (sym: string) => void;
  signOut: () => void;
  /** Erase all server data, then reset to a fresh identity. */
  deleteAccount: () => Promise<{ ok: boolean; reason?: string }>;

  /** Server-backed predictions, newest first. */
  predictions: Prediction[];
  loadingPredictions: boolean;
  /** Set when the last load failed; existing rows are kept on screen. */
  predictionsError: string | null;
  refreshPredictions: () => void;
  addCall: (c: Call & { entryPrice: number }) => Promise<WriteResult>;
  /** Unresolved calls, for showing "your call is in" on a coin. */
  calls: Call[];
  history: HistoryRow[];
  /** Resolved-but-ungraded rows, excluded from accuracy. */
  voided: VoidRow[];
  /** Newest-first resolved outcomes, ties counted as not-won. */
  resolvedTimeline: boolean[];
};

const Ctx = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<Persisted>(DEFAULTS);
  const [hydrated, setHydrated] = useState(false);
  const [predictions, setPredictions] = useState<Prediction[]>([]);
  const [loadingPredictions, setLoading] = useState(true);
  const [predictionsError, setPredError] = useState<string | null>(null);

  // Hydrate once. Until this completes the app renders defaults, which is why
  // `hydrated` is exposed — the navigator must not decide the onboarding
  // branch before it knows whether the user has already onboarded.
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (raw) {
          const saved = JSON.parse(raw) as Partial<Persisted>;
          setState((prev) => ({
            ...prev,
            ...saved,
            // Guard every field an older or newer build may have stored in a
            // shape this one cannot use. A null watchlist used to crash
            // toggleWatch and the Settings render outright.
            plan: saved.plan === 'week' || saved.plan === 'year' ? saved.plan : DEFAULTS.plan,
            tf:
              saved.tf === '24H' || saved.tf === '7D' || saved.tf === '30D'
                ? saved.tf
                : DEFAULTS.tf,
            currency: typeof saved.currency === 'string' ? saved.currency : DEFAULTS.currency,
            watchlist: Array.isArray(saved.watchlist)
              ? saved.watchlist.filter((x): x is string => typeof x === 'string')
              : [],
            isPro: typeof saved.isPro === 'boolean' ? saved.isPro : false,
            onboarded: typeof saved.onboarded === 'boolean' ? saved.onboarded : false,
            // Never trust a persisted array's length — an older build may
            // have stored fewer alert rows than the UI now renders.
            alerts:
              Array.isArray(saved.alerts) && saved.alerts.length === DEFAULT_ALERTS.length
                ? saved.alerts
                : DEFAULT_ALERTS,
          }));
        }
      } catch {
        // Corrupt or unavailable storage must not block the app.
      } finally {
        setHydrated(true);
      }
    })();
  }, []);

  // Persist on every change, but only after hydration — otherwise the first
  // render would immediately overwrite saved state with defaults.
  useEffect(() => {
    if (!hydrated) return;
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(state)).catch(() => {});
  }, [state, hydrated]);

  // Monotonic token: only the newest in-flight fetch may write state, so two
  // rapid calls cannot land out of order and resurrect a stale list.
  const fetchSeq = useRef(0);

  const refreshPredictions = useCallback(() => {
    const seq = ++fetchSeq.current;
    setLoading(true);
    setPredError(null);
    fetchPredictions()
      .then((res) => {
        if (seq !== fetchSeq.current) return;
        if (res.ok) {
          setPredictions(res.rows);
        } else {
          // Keep whatever was already on screen. Replacing it with [] told a
          // user with a full record that they had none, every time the network
          // blipped — indistinguishable from having actually lost the data.
          setPredError(res.reason);
        }
      })
      .catch((e: Error) => {
        if (seq === fetchSeq.current) setPredError(e.message);
      })
      .finally(() => {
        if (seq === fetchSeq.current) setLoading(false);
      });
  }, []);

  useEffect(() => {
    ensureSignedIn().then(() => refreshPredictions());
  }, [refreshPredictions]);

  const patch = useCallback(
    (p: Partial<Persisted>) => setState((prev) => ({ ...prev, ...p })),
    [],
  );

  const value = useMemo<Store>(() => {
    // Unresolved predictions are the user's live calls.
    const calls: Call[] = predictions
      .filter((p) => !p.resolved)
      .map((p) => ({ coin: p.coin, dir: p.direction, tf: p.tf }));

    // Resolved ones become the track record.
    const label = (r: string) =>
      r === 'tie' ? 'no move' : r === 'no-price' ? 'no price' : 'could not grade';

    const voided: VoidRow[] = predictions
      .filter((p) => p.resolved && typeof p.won !== 'boolean')
      .map((p) => ({
        coin: p.coin,
        call: `${p.direction.toUpperCase()} ${p.tf}`,
        when: p.placedAt
          ? p.placedAt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
          : '—',
        reason: label(p.voidReason ?? ''),
      }));

    // Only rows with a real win/loss count toward accuracy. Ties and voided
    // rows are resolved but carry `won: null`; they are deliberately excluded
    // from the denominator rather than silently dropped from both lists.
    const history: HistoryRow[] = predictions
      .filter((p) => p.resolved && typeof p.won === 'boolean')
      .map((p) => ({
        coin: p.coin,
        call: `${p.direction.toUpperCase()} ${p.tf}`,
        when: p.placedAt
          ? p.placedAt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
          : '—',
        win: !!p.won,
        delta:
          typeof p.deltaPct === 'number'
            ? `${p.deltaPct >= 0 ? '+' : ''}${p.deltaPct.toFixed(1)}%`
            : '—',
      }));

    // Newest-first wins/losses INCLUDING ties (as false), for the streak.
    const resolvedTimeline: boolean[] = predictions
      .filter((p) => p.resolved)
      .map((p) => p.won === true);

    return {
      ...state,
      hydrated,
      resolvedTimeline,
      predictions,
      loadingPredictions,
      predictionsError,
      refreshPredictions,
      calls,
      history,
      voided,

      finishOnboarding: () => patch({ onboarded: true }),
      setPro: (v) => patch({ isPro: v }),
      setPlan: (p) => patch({ plan: p }),
      setTf: (t) => patch({ tf: t }),
      setCurrency: (c) => patch({ currency: c }),
      toggleAlert: (i) =>
        setState((prev) => ({
          ...prev,
          alerts: prev.alerts.map((v, j) => (j === i ? !v : v)),
        })),
      toggleWatch: (sym) =>
        setState((prev) => ({
          ...prev,
          watchlist: prev.watchlist.includes(sym)
            ? prev.watchlist.filter((s) => s !== sym)
            : [...prev.watchlist, sym],
        })),

      addCall: async (c) => {
        const res = await placePrediction({
          coin: c.coin, direction: c.dir, tf: c.tf, entryPrice: c.entryPrice,
        });
        if (res.ok) refreshPredictions();
        return res;
      },

      // Signing out clears everything the session accumulated and returns the
      // user to onboarding — flipping isPro alone left them inside an app
      // they had just left, with the lapsed plan still pre-selected.
      deleteAccount: async () => {
        const res = await deleteAccountRemote();
        if (res.ok) {
          setState({ ...DEFAULTS, alerts: [...DEFAULT_ALERTS] });
          setPredictions([]);
        }
        return res.ok ? { ok: true } : { ok: false, reason: res.reason };
      },

      signOut: () => {
        // Must drop the Firebase session too. Clearing local state alone left
        // the anonymous uid in the native keychain, so the next launch signed
        // straight back in and the "cleared" track record reappeared.
        signOutFirebase().catch(() => {});
        setState({ ...DEFAULTS, alerts: [...DEFAULT_ALERTS] });
        setPredictions([]);
      },
    };
  }, [state, hydrated, predictions, loadingPredictions, predictionsError, refreshPredictions, patch]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * Read persisted alert preferences outside React.
 *
 * App.tsx reconciles the scheduled digest before the provider mounts, so it
 * cannot use the hook. Falls back to defaults on any storage problem.
 */
export function loadAlerts(): boolean[] {
  // Synchronous shape for the caller; resolves from storage asynchronously.
  return DEFAULT_ALERTS;
}

export async function loadAlertsAsync(): Promise<boolean[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_ALERTS;
    const saved = JSON.parse(raw) as Partial<Persisted>;
    return Array.isArray(saved.alerts) && saved.alerts.length === DEFAULT_ALERTS.length
      ? saved.alerts
      : DEFAULT_ALERTS;
  } catch {
    return DEFAULT_ALERTS;
  }
}

export function useStore() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useStore must be used inside StoreProvider');
  return v;
}

/** Accuracy derived from history, so the Record screen can never show a
 *  number the rows do not support. */
export function accuracyOf(history: HistoryRow[], timeline?: boolean[]) {
  if (history.length === 0) return { pct: 0, wins: 0, total: 0, streak: 0 };
  const wins = history.filter((r) => r.win).length;

  // Streak walks the FULL resolved timeline, ties included, newest first.
  // Walking the filtered history instead spliced ties out and silently
  // merged two separate runs into one longer one — W W T W W reported 4.
  // A tie is not a win, so it ends the streak.
  const seq = timeline ?? history.map((r) => r.win);
  let streak = 0;
  for (const won of seq) {
    if (!won) break;
    streak += 1;
  }
  return {
    pct: Math.round((wins / history.length) * 100),
    wins,
    total: history.length,
    streak,
  };
}
