// App Check — proves a request came from a genuine build of this app.
//
// WHY THIS MATTERS HERE
//
// VANE has no sign-up: anyone can mint an anonymous account with nothing but
// the API key, which ships in every binary. Without attestation that meant
// two open doors:
//
//   1. Poll stuffing. One vote per uid per coin is only meaningful if uids
//      are expensive. Scripted signups made the crowd figure whatever an
//      attacker wanted it to be.
//   2. Read-quota exhaustion. `public/signals_latest` is world-readable, and
//      the free tier allows 50,000 reads a day — about 83 minutes of a single
//      laptop hammering it, after which the app is down for real users.
//
// App Check does not authenticate a PERSON. It attests that the request came
// from an unmodified build of this app on a genuine device: App Attest on
// iOS, Play Integrity on Android.
//
// Because the app talks to Firestore over REST rather than the native SDK,
// the token is not attached automatically — it goes on the
// `X-Firebase-AppCheck` header, which is what `appCheckHeader()` below is for.

import {
  ReactNativeFirebaseAppCheckProvider,
  getToken,
  initializeAppCheck,
  type AppCheck,
} from '@react-native-firebase/app-check';
import { getApp } from '@react-native-firebase/app';

let ready: Promise<AppCheck | null> | null = null;

/**
 * Initialise attestation. Safe to call more than once.
 *
 * In development the debug provider is used, because App Attest and Play
 * Integrity both refuse to attest a simulator or an unsigned build. The debug
 * token has to be registered in the Firebase console once per machine.
 */
export function initAppCheck(): Promise<AppCheck | null> {
  if (ready) return ready;

  ready = (async () => {
    try {
      const provider = new ReactNativeFirebaseAppCheckProvider();
      provider.configure({
        android: { provider: __DEV__ ? 'debug' : 'playIntegrity' },
        apple: { provider: __DEV__ ? 'debug' : 'appAttest' },
      });

      return initializeAppCheck(getApp(), {
        provider,
        // Refresh before expiry so a request never carries a dead token.
        isTokenAutoRefreshEnabled: true,
      });
    } catch {
      // Attestation being unavailable must not take the app down. Requests
      // simply go without the header, which is how the app behaved before
      // App Check existed — enforcement is a server-side choice.
      return null;
    }
  })();

  return ready;
}

/**
 * Header to attach to a Firestore or Identity Toolkit REST call.
 *
 * Returns an empty object rather than throwing when a token cannot be
 * obtained, so a device that fails attestation degrades to unattested rather
 * than to broken.
 */
export async function appCheckHeader(): Promise<Record<string, string>> {
  try {
    const instance = await initAppCheck();
    if (!instance) return {};
    const { token } = await getToken(instance, /* forceRefresh */ false);
    return token ? { 'X-Firebase-AppCheck': token } : {};
  } catch {
    return {};
  }
}
