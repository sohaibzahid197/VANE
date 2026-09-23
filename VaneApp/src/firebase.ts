// Firebase access over REST.
//
// WHY REST RATHER THAN THE NATIVE SDK
//
// This app needs exactly two things from Firebase: an anonymous identity, and
// per-user reads/writes on a handful of small documents. The native
// @react-native-firebase/auth + /firestore pods bring in the whole Firebase
// Apple SDK to do that, and on iOS under static linkage they fail to build:
// the `Firebase` umbrella header imports `FirebaseAuth/FirebaseAuth-Swift.h`,
// a Swift-generated header that is not produced where the umbrella expects
// it, and @react-native-firebase/firestore imports that umbrella.
//
// The REST API needs no native module, no linkage flags, and is the same
// wire protocol the SDK uses. Signals are already fetched this way. The only
// native Firebase module left is messaging, for FCM.
//
// Auth state is a refresh token in AsyncStorage. Anonymous accounts have no
// credential to re-enter, so losing it would silently orphan a user's whole
// track record — it is the only thing standing between them and their history.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { FIREBASE_API_KEY, FIREBASE_PROJECT_ID } from './firebaseConfig.ts';
import { appCheckHeader } from './appCheck.ts';
import type { Horizon } from './signals.ts';

export type Direction = 'up' | 'down';

export type Prediction = {
  id: string;
  coin: string;
  direction: Direction;
  tf: Horizon;
  placedAt: Date | null;
  resolved: boolean;
  won?: boolean;
  deltaPct?: number;
  entryPrice?: number;
  /** Set by the resolver when a prediction graded to neither a win nor a
   *  loss — a tie, or a row it could not grade at all. */
  voidReason?: string;
};

export type WriteResult = { ok: true } | { ok: false; reason: string };

const IDENTITY = 'https://identitytoolkit.googleapis.com/v1';
const SECURETOKEN = 'https://securetoken.googleapis.com/v1';
const DOCS =
  `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}` +
  `/databases/(default)/documents`;

const TOKEN_KEY = 'vane.auth.v1';
const TIMEOUT_MS = 15000;

type Session = { uid: string; idToken: string; refreshToken: string; expiresAt: number };

let session: Session | null = null;
let inFlight: Promise<Session | null> | null = null;
/** Bumped on sign-out so an in-flight sign-in cannot resurrect the identity. */
let generation = 0;

async function post(
  url: string,
  body: unknown,
  bearer?: string,
  classifyAuth = false,
): Promise<any> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    // App Check attests that this request came from a real build of the app.
    // The native SDK attaches it automatically; over REST we must do it
    // ourselves, and it must be on the auth calls too — unattested anonymous
    // signup is exactly the abuse vector this closes.
    const attest = await appCheckHeader();
    const res = await fetch(url, {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        'Content-Type': 'application/json',
        ...attest,
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = json?.error?.message ?? `HTTP ${res.status}`;
      // Only a 4xx with one of these codes means the credential itself is
      // finished. Anything else — 5xx, timeout, DNS, captive portal — is
      // transient and must never cost the user their account.
      if (
        classifyAuth &&
        res.status >= 400 &&
        res.status < 500 &&
        /TOKEN_EXPIRED|USER_DISABLED|USER_NOT_FOUND|INVALID_REFRESH_TOKEN|INVALID_GRANT_TYPE|MISSING_REFRESH_TOKEN/i.test(
          String(message),
        )
      ) {
        throw new AuthRejected(message);
      }
      throw new Error(message);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

async function persist(s: Session, gen = generation) {
  // A sign-out that lands while this request was in flight must win.
  if (gen !== generation) return;
  session = s;
  try {
    await AsyncStorage.setItem(
      TOKEN_KEY,
      JSON.stringify({ uid: s.uid, refreshToken: s.refreshToken }),
    );
  } catch {
    // A user whose storage is unavailable gets a new identity next launch.
    // Not fatal, but it does cost them their history — hence the try.
  }
}

/** Thrown when the server positively rejected the credential, as opposed to
 *  the request simply failing to arrive. */
class AuthRejected extends Error {}

/** Exchange a refresh token for a fresh id token. */
async function refresh(refreshToken: string): Promise<Session> {
  const r = await post(
    `${SECURETOKEN}/token?key=${FIREBASE_API_KEY}`,
    { grant_type: 'refresh_token', refresh_token: refreshToken },
    undefined,
    // Distinguish "this token is dead" from "the network is down". Treating
    // the second as the first silently minted a new anonymous identity and
    // overwrote the only handle on the user's entire history.
    true,
  );
  return {
    uid: r.user_id,
    idToken: r.id_token,
    refreshToken: r.refresh_token,
    expiresAt: Date.now() + Number(r.expires_in ?? 3600) * 1000,
  };
}

async function signUpAnonymously(): Promise<Session> {
  const r = await post(`${IDENTITY}/accounts:signUp?key=${FIREBASE_API_KEY}`, {
    returnSecureToken: true,
  });
  return {
    uid: r.localId,
    idToken: r.idToken,
    refreshToken: r.refreshToken,
    expiresAt: Date.now() + Number(r.expiresIn ?? 3600) * 1000,
  };
}

/**
 * Current session, signing in anonymously if needed.
 *
 * Returns null when Firebase is unreachable so callers fall back to
 * local-only behaviour. A failure is NOT memoized — caching it meant one
 * cold start in airplane mode disabled auth for the whole process lifetime.
 */
async function getSession(): Promise<Session | null> {
  // Still valid, with a minute of slack so a call cannot expire mid-flight.
  if (session && session.expiresAt - 60_000 > Date.now()) return session;
  if (inFlight) return inFlight;

  const gen = generation;
  inFlight = (async () => {
    try {
      if (session?.refreshToken) {
        const s = await refresh(session.refreshToken);
        await persist(s, gen);
        return s;
      }

      const raw = await AsyncStorage.getItem(TOKEN_KEY).catch(() => null);
      if (raw) {
        const saved = JSON.parse(raw) as { refreshToken?: string };
        if (saved?.refreshToken) {
          try {
            const s = await refresh(saved.refreshToken);
            await persist(s, gen);
            return s;
          } catch (e) {
            if (!(e instanceof AuthRejected)) {
              // Transient. Keep the stored token and report "no session" so
              // the caller retries later. Signing up here would orphan the
              // user's predictions permanently for a momentary blip.
              return null;
            }
            // Genuinely rejected — fall through to a new identity.
          }
        }
      }

      const s = await signUpAnonymously();
      await persist(s, gen);
      return s;
    } catch {
      return null;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/**
 * A bearer token for direct Firestore REST reads, or null when signed out.
 *
 * Exposed so api.ts can read the entitlement-gated signals document without
 * duplicating the refresh-and-retry logic that lives in this module.
 */
export async function idToken(): Promise<string | null> {
  const s = await getSession();
  return s?.idToken ?? null;
}

export async function ensureSignedIn(): Promise<string | null> {
  return (await getSession())?.uid ?? null;
}

export function currentUid(): string | null {
  return session?.uid ?? null;
}

/** Drop the session so a sign-out really does start a new identity. */
export async function signOutFirebase(): Promise<void> {
  generation += 1;
  session = null;
  inFlight = null;
  try {
    await AsyncStorage.removeItem(TOKEN_KEY);
  } catch {
    // Nothing to undo.
  }
}

/**
 * Authenticated POST that survives a token expiring mid-flight.
 *
 * The 60s expiry slack only covers the gap between checking and sending; a
 * request already in flight, or a device with a skewed clock, still hit a 401
 * and failed outright — surfacing a raw Firestore error to the user.
 */
async function authedPost(path: string, body: unknown): Promise<any> {
  const s1 = await getSession();
  if (!s1) throw new Error('Not signed in');

  try {
    return await post(path, body, s1.idToken);
  } catch (e) {
    const msg = String((e as Error)?.message ?? '');
    if (!/401|UNAUTHENTICATED|invalid auth|Missing or invalid/i.test(msg)) throw e;

    // Force a refresh and replay exactly once.
    session = null;
    const s2 = await getSession();
    if (!s2) throw e;
    return post(path, body, s2.idToken);
  }
}

// ---------------------------------------------------------------- Firestore

/** Firestore REST tags every value by type; unwrap recursively. */
function unwrap(v: any): any {
  if (v == null) return null;
  if ('nullValue' in v) return null;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return new Date(v.timestampValue);
  if ('stringValue' in v) return v.stringValue;
  if ('arrayValue' in v) return (v.arrayValue.values ?? []).map(unwrap);
  if ('mapValue' in v) {
    const out: Record<string, any> = {};
    for (const [k, val] of Object.entries(v.mapValue.fields ?? {})) out[k] = unwrap(val);
    return out;
  }
  return null;
}

/**
 * Record a prediction.
 *
 * `placedAt` is written as a server-timestamp TRANSFORM, not a client value —
 * the rules require `placedAt == request.time`, so a client-supplied date is
 * rejected. That is what stops anyone backdating a call whose outcome they
 * already know and manufacturing a perfect record.
 */
/**
 * Stable id for one logical call.
 *
 * Deriving it from Date.now() meant a retry after a timeout — where the first
 * write may well have succeeded — produced a SECOND prediction with a later
 * timestamp and a stale entry price. Both then graded, double-counting in the
 * track record. Bucketing to the minute keeps the id stable across a retry
 * while still allowing a genuinely new call later.
 */
function predictionId(coin: string, tf: Horizon, dir: Direction): string {
  const minute = Math.floor(Date.now() / 60_000);
  return `${coin}-${tf}-${dir}-${minute}`;
}

export async function placePrediction(p: {
  coin: string;
  direction: Direction;
  tf: Horizon;
  entryPrice: number;
}): Promise<WriteResult> {
  // A zero or non-finite entry price divides by zero in the resolver and
  // yields Infinity, which Firestore refuses — taking the whole grading
  // batch down with it, for every user.
  if (!Number.isFinite(p.entryPrice) || p.entryPrice <= 0) {
    return { ok: false, reason: 'That coin has no price right now — try again in a moment.' };
  }

  const s = await getSession();
  if (!s) return { ok: false, reason: 'Could not reach the server. Check your connection.' };

  const id = predictionId(p.coin, p.tf, p.direction);
  const name =
    `projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents` +
    `/users/${s.uid}/predictions/${id}`;

  try {
    await authedPost(
      `${DOCS}:commit`,
      {
        writes: [
          {
            update: {
              name,
              fields: {
                coin: { stringValue: p.coin },
                direction: { stringValue: p.direction },
                tf: { stringValue: p.tf },
                entryPrice: { doubleValue: p.entryPrice },
                resolved: { booleanValue: false },
              },
            },
            updateTransforms: [
              { fieldPath: 'placedAt', setToServerValue: 'REQUEST_TIME' },
            ],
            currentDocument: { exists: false },
          },
        ],
      },
    );
    return { ok: true };
  } catch (e) {
    const msg = String((e as Error)?.message ?? '');
    // The idempotency key did its job: the first attempt landed after all.
    if (/ALREADY_EXISTS|already exists/i.test(msg)) return { ok: true };
    return { ok: false, reason: msg || 'Could not save your call.' };
  }
}

export type PredictionsResult =
  | { ok: true; rows: Prediction[] }
  | { ok: false; reason: string };

/**
 * Newest-first, the order the Record screen's streak logic expects.
 *
 * Returns a discriminated result rather than a bare array: returning [] for
 * both "no predictions" and "request failed" told a user with forty graded
 * calls that they had none, every time Firestore hiccupped.
 *
 * The limit covers resolved AND open calls, so it is generous enough that the
 * accuracy figure is a real lifetime record for any plausible user.
 */
export async function fetchPredictions(limit = 300): Promise<PredictionsResult> {
  const s = await getSession();
  if (!s) return { ok: false, reason: 'Not signed in' };

  try {
    const rows = await post(
      `${DOCS}/users/${s.uid}:runQuery`,
      {
        structuredQuery: {
          from: [{ collectionId: 'predictions' }],
          orderBy: [{ field: { fieldPath: 'placedAt' }, direction: 'DESCENDING' }],
          limit,
        },
      },
      s.idToken,
    );

    const parsed = (Array.isArray(rows) ? rows : [])
      .filter((r: any) => r?.document)
      .map((r: any) => {
        const f = unwrap({ mapValue: { fields: r.document.fields ?? {} } });
        const placed = f.placedAt instanceof Date ? f.placedAt : null;
        return {
          id: String(r.document.name).split('/').pop() ?? '',
          coin: String(f.coin ?? '?'),
          direction: (f.direction === 'down' ? 'down' : 'up') as Direction,
          tf: (f.tf ?? '24H') as Horizon,
          placedAt: placed,
          resolved: !!f.resolved,
          won: typeof f.won === 'boolean' ? f.won : undefined,
          deltaPct: typeof f.deltaPct === 'number' ? f.deltaPct : undefined,
          entryPrice: typeof f.entryPrice === 'number' ? f.entryPrice : undefined,
          voidReason: typeof f.voidReason === 'string' ? f.voidReason : undefined,
        };
      });
    return { ok: true, rows: parsed };
  } catch (e) {
    return { ok: false, reason: (e as Error)?.message ?? 'Could not load your calls.' };
  }
}

/** One vote per coin per user; writing again replaces the previous vote. */
export async function castVote(coin: string, direction: Direction): Promise<boolean> {
  const s = await getSession();
  if (!s) return false;

  const name =
    `projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents` +
    `/users/${s.uid}/votes/${coin}`;

  try {
    await post(
      `${DOCS}:commit`,
      {
        writes: [
          {
            update: { name, fields: { direction: { stringValue: direction } } },
            updateTransforms: [{ fieldPath: 'at', setToServerValue: 'REQUEST_TIME' }],
          },
        ],
      },
      s.idToken,
    );
    return true;
  } catch {
    return false;
  }
}

export async function fetchMyVote(coin: string): Promise<Direction | null> {
  const s = await getSession();
  if (!s) return null;

  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${DOCS}/users/${s.uid}/votes/${coin}`, {
        signal: ctl.signal,
        headers: { ...(await appCheckHeader()), Authorization: `Bearer ${s.idToken}` },
      });
      if (!res.ok) return null;
      const body = await res.json();
      const f = unwrap({ mapValue: { fields: body.fields ?? {} } });
      return f?.direction === 'down' ? 'down' : f?.direction === 'up' ? 'up' : null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/**
 * Erase everything this user has stored, then drop the identity.
 *
 * Required by App Store guideline 5.1.1(v) — anonymous auth still creates an
 * account — and by GDPR Art. 17. There are no Cloud Functions on the Spark
 * plan, so the client walks its own subcollections; the rules permit exactly
 * this and nothing wider.
 *
 * Deletes predictions and votes first: if the run dies partway, the user doc
 * is still reachable next launch and the sweep can be retried. Doing it the
 * other way round would orphan the subcollections permanently.
 */
export async function deleteAccount(): Promise<WriteResult> {
  const s = await getSession();
  if (!s) return { ok: false, reason: 'Could not reach the server. Try again when you are online.' };

  const base = `projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

  try {
    for (const sub of ['predictions', 'votes'] as const) {
      // Page through rather than assuming everything fits one response.
      for (let page = 0; page < 20; page++) {
        const rows = await post(
          `${DOCS}/users/${s.uid}:runQuery`,
          { structuredQuery: { from: [{ collectionId: sub }], limit: 300 } },
          s.idToken,
        );
        const names: string[] = (Array.isArray(rows) ? rows : [])
          .filter((r: any) => r?.document?.name)
          .map((r: any) => r.document.name as string);
        if (names.length === 0) break;

        await post(
          `${DOCS}:commit`,
          { writes: names.map((name) => ({ delete: name })) },
          s.idToken,
        );
        if (names.length < 300) break;
      }
    }

    await post(
      `${DOCS}:commit`,
      { writes: [{ delete: `${base}/users/${s.uid}` }] },
      s.idToken,
    );

    await signOutFirebase();
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error)?.message ?? 'Could not delete your data.' };
  }
}

/** Store the FCM token where the notification sender looks for it. */
export async function saveFcmToken(token: string): Promise<void> {
  const s = await getSession();
  if (!s) return;

  const name =
    `projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${s.uid}`;

  try {
    // updateMask keeps this a merge: the rules' hasOnly() is evaluated against
    // the MERGED document, so replacing it wholesale would drop other fields
    // and a blind write would fail once anything else lives here.
    await post(
      `${DOCS}:commit`,
      {
        writes: [
          {
            update: { name, fields: { fcmToken: { stringValue: token } } },
            updateMask: { fieldPaths: ['fcmToken'] },
          },
        ],
      },
      s.idToken,
    );
  } catch {
    // Non-fatal: the user simply does not receive pushes.
  }
}
