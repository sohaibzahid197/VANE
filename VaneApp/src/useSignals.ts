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

// Two caches, never one.
//
// A single key leaked the paid dataset straight past the server gate: the
// last Pro session persisted all 30 coins, and the next launch rendered them
// from disk for a user whose subscription had lapsed — indefinitely, if the
// device was offline. It also showed one user's paid snapshot to the next
// person to sign in on the same device.
const CACHE_KEY_FREE = 'vane.signals.free.v1';
const CACHE_KEY_PAID = 'vane.signals.paid.v1';
const cacheKey = () => (entitled ? CACHE_KEY_PAID : CACHE_KEY_FREE);

/** Every key this module has ever written, for a thorough clear. */
const ALL_CACHE_KEYS = [CACHE_KEY_FREE, CACHE_KEY_PAID, 'vane.signals.v1'];

/** Drop every cached snapshot. Called on sign-out and on losing entitlement. */
export async function clearSignalsCache(): Promise<void> {
  setStore({ data: null, stale: false, fetchedAt: 0 });
  try {
    await Promise.all(ALL_CACHE_KEYS.map((k) => AsyncStorage.removeItem(k)));
  } catch {
    // A cache we cannot clear is still never rendered: `data` is null above.
  }
}

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

/**
 * Whether to ask for the entitlement-gated document.
 *
 * Module-level rather than a hook argument: this store is shared by every
 * tab, and a per-caller flag would let one screen request the paid document
 * while another requested the free one, so which payload won would depend on
 * render order. `setEntitled` is called from the store provider when
 * entitlement resolves, and forces a reload when it changes.
 */
let entitled = false;

export function setEntitled(next: boolean): void {
  if (entitled === next) return;
  const lost = entitled && !next;
  entitled = next;
  // Losing entitlement must drop the paid snapshot immediately, from memory
  // and from disk. Re-fetching alone is not enough: the old 30 coins stay on
  // screen until the network answers, and forever if it never does.
  if (lost) void clearSignalsCache();
  // The cached snapshot belongs to the old entitlement. Re-fetch rather than
  // showing 30 coins to someone who just lapsed, or 1 to someone who just paid.
  void load(true).catch(() => {});
}
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
    const raw = await AsyncStorage.getItem(cacheKey());
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
  if (inFlight) {
    // A forced load must not be satisfied by a fetch that is already running,
    // because the thing that forced it — entitlement changing — is exactly
    // what that fetch got wrong. On a Pro user's cold start the first load
    // begins before AsyncStorage has hydrated, so it asks for the FREE
    // document; returning it here left a paying subscriber looking at one
    // coin until they manually pulled to refresh.
    if (!force) return inFlight;
    return inFlight.then(() => load(true));
  }

  inFlight = (async () => {
    setStore({ loading: true, error: null });
    await hydrate();

    // Polls are best-effort and must never block the signals render.
    fetchPolls()
      .then((p) => setStore({ polls: p }))
      .catch(() => {});

    try {
      const snap = await fetchSignals(entitled);
      // An empty document is a pipeline failure, not an empty state.
      if (snap.coins.length === 0) throw new Error('No signals published yet');
      setStore({ data: snap, stale: false, error: null, fetchedAt: Date.now() });
      AsyncStorage.setItem(cacheKey(), JSON.stringify(snap)).catch(() => {});
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
