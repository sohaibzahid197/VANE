// The signals feed.
//
// ONE shared fetch, not one per caller. Signals and the Predict tab both use
// this hook; when each held its own state they issued duplicate requests,
// raced on the same cache key, and could show DIFFERENT prices for the same
// coin at the same moment in two tabs of one app.

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { fetchPolls, fetchSignals, type Polls, type Snapshot } from './api.ts';

export type SignalsState = {
  data: Snapshot | null;
  polls: Polls;
  loading: boolean;
  error: string | null;
  /** True when `data` came from disk and no successful fetch has landed since. */
  stale: boolean;
  reload: () => void;
};

const CACHE_KEY = 'vane.signals.v1';

/** A fetch younger than this is reused rather than repeated. */
const FRESH_MS = 60_000;

type Store = {
  data: Snapshot | null;
  polls: Polls;
  loading: boolean;
  error: string | null;
  stale: boolean;
  fetchedAt: number;
};

let store: Store = {
  data: null, polls: {}, loading: true, error: null, stale: false, fetchedAt: 0,
};

const listeners = new Set<() => void>();
let inFlight: Promise<void> | null = null;
let hydrated = false;

function setStore(next: Partial<Store>) {
  store = { ...store, ...next };
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Load the last good payload from disk, once per app run. */
async function hydrate() {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    if (!raw) return;
    const cached = JSON.parse(raw) as Snapshot;
    // Never overwrite a live payload that landed while we were reading disk.
    if (!store.data) setStore({ data: cached, stale: true });
  } catch {
    // A corrupt cache is not worth surfacing; the network path still runs.
  }
}

async function load(force: boolean): Promise<void> {
  if (!force && Date.now() - store.fetchedAt < FRESH_MS && store.data) return;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    setStore({ loading: true, error: null });
    await hydrate();

    // Polls are best-effort and must never block the signals render.
    fetchPolls()
      .then((p) => setStore({ polls: p }))
      .catch(() => {});

    try {
      const snap = await fetchSignals();
      // An empty document is a pipeline failure, not an empty state.
      if (snap.coins.length === 0) throw new Error('No signals published yet');
      setStore({ data: snap, stale: false, error: null, fetchedAt: Date.now() });
      AsyncStorage.setItem(CACHE_KEY, JSON.stringify(snap)).catch(() => {});
    } catch (e) {
      setStore({ error: (e as Error).message || 'Could not reach the signals service' });
      // No mock fallback: sample prices during a real outage look like live
      // data. The disk cache above covers "offline but seen before", and
      // `stale` stays true so the UI can say so.
    } finally {
      setStore({ loading: false });
      inFlight = null;
    }
  })();

  return inFlight;
}

export function useSignals(): SignalsState {
  const snapshot = useSyncExternalStore(subscribe, () => store);

  useEffect(() => {
    load(false).catch(() => {});
  }, []);

  const reload = useCallback(() => {
    load(true).catch(() => {});
  }, []);

  return {
    data: snapshot.data,
    polls: snapshot.polls,
    loading: snapshot.loading,
    error: snapshot.error,
    stale: snapshot.stale,
    reload,
  };
}

/** "Updated 4 minutes ago" — staleness has to be visible on a live feed. */
export function relativeTime(iso: string): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}
