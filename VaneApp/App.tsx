import React, { useEffect } from 'react';
import { StatusBar } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StoreProvider } from './src/store.tsx';
import { ErrorBoundary } from './src/ErrorBoundary.tsx';
import Navigation from './src/Navigation.tsx';
import { ensureChannel, registerForPush, syncAlerts } from './src/notifications.ts';
import { ensureSignedIn } from './src/firebase.ts';
import { initAppCheck } from './src/appCheck.ts';
import { complete, connect, loadOffers, onPurchaseRecovered, transactionIdOf } from './src/purchases.ts';
import { validatePurchase } from './src/entitlement.ts';
import { hasPermission } from './src/notifications.ts';
import { loadAlertsAsync } from './src/store.tsx';

export default function App() {
  useEffect(() => {
    // Android needs the channel to exist before anything can post to it.
    // Permission itself is requested later, in context, from the Alerts
    // screen — a cold prompt on first launch gets declined by most users.
    // Attestation first: the anonymous sign-in that follows is the call most
    // worth protecting, so its token should already be available.
    initAppCheck().catch(() => {});

    // Dev-only StoreKit probe. An empty result is the single most confusing
    // failure in IAP — it means "a product is missing price or localization",
    // not "the code is broken" — so say which of the three came back.
    if (__DEV__) {
      loadOffers()
        .then((offers) => {
          console.log(
            `[VANE][iap] ${offers.length}/3 products loaded` +
              (offers.length
                ? ': ' + offers.map((o) => `${o.plan}=${o.price}`).join(', ')
                : ' — check prices and localizations in App Store Connect, ' +
                  'or run with the VANE.storekit configuration'),
          );
        })
        .catch((e) => console.log('[VANE][iap] load failed:', e?.message));
    }

    ensureChannel().catch(() => {});

    // Reconcile the scheduled digest on every launch. It used to be scheduled
    // only from the Alerts screen, so a user who never opened that screen got
    // no digest at all — while Settings cheerfully reported it as on. This
    // also re-anchors the repeat, which Android's fixed 24h interval drifts
    // by an hour at each DST boundary.
    (async () => {
      if (await hasPermission()) await syncAlerts(await loadAlertsAsync());
    })().catch(() => {});

    // Recover transactions that arrive with no paywall on screen.
    //
    // StoreKit replays an unfinished transaction on every launch, and an
    // "Ask to Buy" purchase is approved long after the sheet has gone. Until
    // now nothing was listening for either: the user was charged, the
    // transaction was never finished, and it was re-queued forever.
    // The StoreKit listener that replays unfinished transactions is started by
    // initConnection, NOT by registering a JS callback. Without this the
    // recovery below was inert in release builds — loadOffers is the only
    // other caller and it runs under __DEV__ — so an "Ask to Buy" approval or
    // a validator outage was never recovered until the user happened to open
    // the paywall.
    connect().catch(() => {});

    const offPurchase = onPurchaseRecovered(async (transaction) => {
      const txId = transactionIdOf(transaction);
      if (!txId) return;
      const verdict = await validatePurchase(txId);
      // Only finish once the server has recorded entitlement. A failure here
      // leaves the transaction queued so the next launch tries again.
      if (verdict?.active) await complete(transaction);
    });

    let off: (() => void) | undefined;
    // Anonymous sign-in first: the FCM token is stored against the uid, so
    // registering before auth would write it nowhere.
    ensureSignedIn()
      .then(() => registerForPush())
      .then((unsub) => {
        off = unsub;
      })
      .catch(() => {});

    return () => {
      off?.();
      offPurchase();
    };
  }, []);

  return (
    <ErrorBoundary>
      <SafeAreaProvider>
        <StatusBar barStyle="light-content" />
        <StoreProvider>
          <Navigation />
        </StoreProvider>
      </SafeAreaProvider>
    </ErrorBoundary>
  );
}
