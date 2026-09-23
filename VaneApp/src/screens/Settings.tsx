// Screen 1g — settings and subscription management.

import React, { useMemo } from 'react';
import { Alert, Linking, Platform, Pressable, StyleSheet, View } from 'react-native';
import { C, tint } from '../theme.ts';

/** Opening a URL can reject (no handler, malformed link). Unhandled, that is
 *  a silent no-op for the user and a LogBox warning for us. */
function openExternal(url: string) {
  Linking.openURL(url).catch(() => {
    Alert.alert("Couldn't open link", url);
  });
}
import { useScale } from '../responsive.ts';
import { Card, Label, MIN_TAP, Screen, Text } from '../ui.tsx';
import { useStore } from '../store.tsx';
import { IconChevron } from '../icons.tsx';
import { APP_VERSION, MONETIZATION } from '../config.ts';
import { PLAN_LABEL } from '../products.ts';

/** Apple and Google each own subscription management; deep-link out to them. */
const MANAGE_URL = Platform.select({
  ios: 'https://apps.apple.com/account/subscriptions',
  android: 'https://play.google.com/store/account/subscriptions',
  default: 'https://apps.apple.com/account/subscriptions',
});

export default function Settings({
  onPaywall, onAlerts,
}: {
  onPaywall: () => void;
  onAlerts: () => void;
}) {
  const { isPro, plan, alerts, signOut, deleteAccount, watchlist } = useStore();
  const s = useScale();
  const st = useStyles();

  // Derived, not a literal. A hardcoded "3 on" went stale the moment the user
  // touched a toggle, and counted PRO rows a free user cannot even enable.
  // Only the digest is a real notification today, so only it is counted.
  const activeAlerts = alerts[3] ? 1 : 0;

  const rows: [string, string, (() => void) | undefined, string?][] = [
    ['Notifications', `${activeAlerts} on`, onAlerts],
    // Prices are published in USD and no FX rate is fetched, so offering a
    // choice would persist a claim the rest of the app contradicts on every
    // screen. The row states the fact instead of pretending to be a setting.
    ['Currency', 'USD only', undefined],
    ['Watchlist', watchlist.length
      ? `${watchlist.length} coin${watchlist.length === 1 ? '' : 's'}`
      : 'None yet', undefined],
    ['Terms of use', '', () => openExternal('https://sohaibzahid197.github.io/VANE-legal/terms-and-conditions.html')],
    ['Privacy policy', '', () => openExternal('https://sohaibzahid197.github.io/VANE-legal/privacy-policy.html')],
    ['Delete my data', '', () =>
      Alert.alert(
        'Delete my data',
        'This permanently erases your calls, your track record and your votes from the server. It cannot be undone.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete everything',
            style: 'destructive',
            onPress: async () => {
              const res = await deleteAccount();
              Alert.alert(
                res.ok ? 'Deleted' : "Couldn't delete",
                res.ok
                  ? 'Everything stored for this device has been removed.'
                  : res.reason ?? 'Please try again.',
              );
            },
          },
        ],
      ), C.down],
    ['Sign out', '', () =>
      Alert.alert('Sign out', 'This starts a fresh identity on this device. Your existing calls stay on the server but become unreachable — use Delete my data to erase them instead.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Sign out', style: 'destructive', onPress: signOut },
      ]), C.down],
  ];

  return (
    <Screen>
      <Text style={st.title} accessibilityRole="header">Settings</Text>

      {MONETIZATION ? (
      <Card style={st.subCard}>
        <Label>SUBSCRIPTION</Label>
        {isPro ? (
          <>
            <Text style={st.subPlan}>
              {/* The plan NAME only. This line used to add a price, which
                  was a fourth hardcoded figure disagreeing with the paywall
                  and with App Store Connect, and it would still be wrong for
                  anyone billed outside USD. The authoritative amount lives in
                  the system subscription settings, one tap away below. */}
              {PLAN_LABEL[plan]}
            </Text>
            {/* No receipt, no StoreKit query, therefore no renewal date. The
                previous hardcoded "Renews 23 Sep 2027" stated a specific fact
                about the user's billing that nothing in the app knew. */}
            <Text style={st.subRenew}>
              Manage renewal in your device's subscription settings.
            </Text>
            <Pressable
              onPress={() => Linking.openURL(MANAGE_URL)}
              accessibilityRole="button"
              accessibilityLabel="Manage subscription"
              style={st.manageHit}>
              <Text style={st.manage}>Manage subscription →</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Text style={st.subPlan}>Free</Text>
            {/* There is no daily quota and there never was — no counter exists
                anywhere in the app. The free tier is BTC, always. */}
            <Text style={st.subRenew}>Free selection · upgrade for all coins</Text>
            <Pressable
              onPress={onPaywall}
              accessibilityRole="button"
              accessibilityLabel="See Pro plans"
              style={st.manageHit}>
              <Text style={st.manage}>See Pro plans →</Text>
            </Pressable>
          </>
        )}
      </Card>
      ) : null}

      {rows.map(([label, value, onPress, color]) => (
        <Card key={label} style={st.row} onPress={onPress} label={value ? `${label}, ${value}` : label}>
          <Text style={[st.rowLabel, color ? { color } : null]} numberOfLines={1}>
            {label}
          </Text>
          <View style={st.rowRight}>
            {value ? <Text style={st.rowValue}>{value}</Text> : null}
            {onPress ? <IconChevron size={s.w(15)} color={C.faint} /> : null}
          </View>
        </Card>
      ))}

      <Text style={st.version}>VANE {APP_VERSION} · not financial advice</Text>
    </Screen>
  );
}

function useStyles() {
  const { w, h, f } = useScale();
  return useMemo(() => StyleSheet.create({
  title: {
    color: C.text, fontSize: f(24), fontWeight: '700',
    marginTop: h(6), marginBottom: h(16),
  },
  subCard: { backgroundColor: tint(C.accent, 0.07), borderColor: tint(C.accent, 0.2) },
  subPlan: { color: C.text, fontSize: f(17), fontWeight: '700' },
  subRenew: { color: C.dim, fontSize: f(12), marginTop: h(3) },
  manage: { color: C.accent, fontSize: f(13), fontWeight: '600' },
  manageHit: { marginTop: h(10), minHeight: MIN_TAP, justifyContent: 'center' },

  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: MIN_TAP },
  rowLabel: { color: C.text, fontSize: f(14), flex: 1 },
  rowRight: { flexDirection: 'row', alignItems: 'center', gap: w(7) },
  rowValue: { color: C.dim, fontSize: f(13) },

  version: {
    color: C.faint, fontSize: f(11), textAlign: 'center', marginTop: h(18),
  },
}), [w, h, f]);
}
