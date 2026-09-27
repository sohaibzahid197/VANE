// The markets feed.
//
// Cached on disk so the list paints instantly on launch instead of showing a
// spinner for a round trip. Two cache keys, never one — the same discipline the
// signals cache had to learn the hard way: a single key persisted the last Pro
// session's full dataset, and the next launch rendered it from disk for a user
// whose subscription had lapsed, indefinitely if the device was offline.
//
// The key is chosen by which document ACTUALLY SERVED the response, not by
// which one was requested. An expired subscriber asks for the paid document,
// gets 403 and falls back to free; keying on the request would write free data
// into the paid slot and then serve 3 coins to a paying user.

import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { fetchMarkets, type MarketsSnapshot } from './markets.ts';

const CACHE_FREE = 'vane.markets.free.v1';
const CACHE_PAID = 'vane.markets.paid.v1';
const ALL_KEYS = [CACHE_FREE, CACHE_PAID];
const cacheKey = (paid: boolean) => (paid ? CACHE_PAID : CACHE_FREE);

/** A snapshot younger than this is reused rather than re-fetched. */
const FRESH_MS = 60_000;

/** Drop every cached snapshot. Call on sign-out and on losing entitlement. */
export async function clearMarketsCache(): Promise<void> {
  try {
    await Promise.all(ALL_KEYS.map((k) => AsyncStorage.removeItem(k)));
  } catch {
    // A cache we cannot clear is still never rendered stale past its check.
  }
}

export type MarketsState = {
  data: MarketsSnapshot | null;
  loading: boolean;
  error: string | null;
  /** True when `data` came from disk and no successful fetch has landed since. */
  stale: boolean;
  reload: () => void;
};

export function useMarkets(entitled: boolean): MarketsState {
  const [data, setData] = useState<MarketsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [fetchedAt, setFetchedAt] = useState(0);
  const [tick, setTick] = useState(0);
  // Which tier the data currently in state belongs to. Compared against
  // `entitled` to detect that the snapshot on screen is now the wrong one.
  const [dataTier, setDataTier] = useState<boolean | null>(null);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      // An entitlement change must bypass the freshness gate.
      //
      // Without this, a subscriber whose subscription was just refunded keeps
      // all 250 coins on screen: the effect re-runs with entitled=false, the
      // free cache is empty so nothing replaces the data, and then the 60-second
      // freshness check early-returns because `fetchedAt` is seconds old. The
      // thing that forced the reload — entitlement changing — is exactly what
      // the cached snapshot got wrong, so it cannot satisfy it.
      const tierChanged = dataTier !== null && dataTier !== entitled;
      if (tierChanged) {
        // Drop the wrong-tier snapshot from memory immediately rather than
        // leaving it on screen until the network answers — or forever, offline.
        setData(null);
        setStale(false);
        setLoading(true);
        if (!entitled) void clearMarketsCache();
      }

      // Serve the cache for the tier we are ASKING for, so a paying user does
      // not flash three coins before the paid document lands.
      try {
        const raw = await AsyncStorage.getItem(cacheKey(entitled));
        if (!cancelled && raw) {
          const cached = JSON.parse(raw) as MarketsSnapshot;
          if (cached?.coins?.length) {
            setData(cached);
            setStale(true);
            setLoading(false);
            setDataTier(cached.paid);
          }
        }
      } catch {
        // A corrupt cache is not an error worth surfacing; the fetch follows.
      }

      if (!tierChanged && Date.now() - fetchedAt < FRESH_MS && data) {
        setLoading(false);
        return;
      }

      try {
        const snap = await fetchMarkets(entitled);
        if (cancelled) return;
        setData(snap);
        setStale(false);
        setError(null);
        setFetchedAt(Date.now());
        setDataTier(snap.paid);
        // Keyed on what SERVED it, not what was asked for.
        await AsyncStorage.setItem(cacheKey(snap.paid), JSON.stringify(snap)).catch(() => {});
      } catch (e: any) {
        if (cancelled) return;
        // Keep whatever is on screen. A failed refresh over a working cache is
        // a stale badge, not an error screen.
        setError(e?.message ?? 'Markets unavailable');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entitled, tick]);

  // Refresh when the app comes back to the foreground. Prices go stale while
  // backgrounded and a market app showing yesterday's price is worse than one
  // showing a spinner.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') reload();
    });
    return () => sub.remove();
  }, [reload]);

  return { data, loading, error, stale, reload };
}
