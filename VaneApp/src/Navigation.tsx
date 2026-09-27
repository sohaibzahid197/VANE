// Navigation: onboarding -> paywall -> tabs, with coin detail and alerts
// pushed on top and the paywall reachable as a modal from anywhere.

import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { NavigationContainer, DarkTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C } from './theme.ts';
import { useStore } from './store.tsx';
import { MONETIZATION } from './config.ts';
import { useSignals } from './useSignals.ts';
import { ErrorState, Loading, Screen } from './ui.tsx';
import { useScale } from './responsive.ts';
import { TAB_ICONS } from './icons.tsx';
import type { Coin } from './signals.ts';
import type { Polls } from './api.ts';
import type { Market } from './markets.ts';
import Onboarding from './screens/Onboarding.tsx';
import Paywall from './screens/Paywall.tsx';
import Signals from './screens/Signals.tsx';
import Markets from './screens/Markets.tsx';
import CoinChart from './screens/CoinChart.tsx';
import CoinDetail from './screens/CoinDetail.tsx';
import Record from './screens/Record.tsx';
import Alerts from './screens/Alerts.tsx';
import SettingsScreen from './screens/Settings.tsx';

const Stack = createNativeStackNavigator();
const Tabs = createBottomTabNavigator();

const theme = {
  ...DarkTheme,
  colors: { ...DarkTheme.colors, background: C.bg, card: C.bg, border: C.cardBorder },
};

function TabIcon({ route, focused }: { route: string; focused: boolean }) {
  const Icon = TAB_ICONS[route];
  const { w } = useScale();
  const size = w(22);
  if (!Icon) return null;
  return (
    <View style={st.tabIconWrap}>
      <Icon size={size} color={focused ? C.accent : C.faint} active={focused} />
    </View>
  );
}

/**
 * The Predict tab renders BTC from the live feed.
 *
 * It used to render <CoinDetail symbol="BTC" /> with no data props, which fell
 * back to the bundled sample — so the tab showed $123,410 while the Signals
 * tab showed the real price, side by side in one app. Worse, a call placed
 * from here submitted the sample price as a real entry price.
 */
function PredictTab({ onPaywall }: { onPaywall: () => void }) {
  const { data, polls, loading, error, reload } = useSignals();

  if (loading && !data) {
    return (
      <Screen>
        <Loading />
      </Screen>
    );
  }
  if (error && !data) {
    return (
      <Screen>
        <ErrorState message={error} onRetry={reload} />
      </Screen>
    );
  }

  return (
    <CoinDetail
      symbol="BTC"
      coins={data?.coins}
      polls={polls}
      onPaywall={onPaywall}
    />
  );
}

function MainTabs({
  onPaywall, onAlerts, autoPaywall, onPaywallShown,
}: {
  onPaywall: () => void;
  onAlerts: () => void;
  /** Set when onboarding ended on "See plans" — the hard paywall moment. */
  autoPaywall?: boolean;
  onPaywallShown?: () => void;
}) {
  useEffect(() => {
    if (!MONETIZATION || !autoPaywall) return;
    onPaywall();
    // Release the latch. Leaving it set meant the hard paywall would fire
    // again on any remount (Fast Refresh, unmountOnBlur, a presentation
    // change) — the one-shot behaviour was luck, not state.
    onPaywallShown?.();
    // Fires once on mount; onPaywall is recreated each render by design.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Read live rather than at module scope: a fixed height computed once at
  // import survived rotation and swallowed the home-indicator inset.
  const insets = useSafeAreaInsets();
  const sc = useScale();
  const barHeight = sc.h(56) + insets.bottom;

  return (
    <Tabs.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarStyle: [st.tabBar, { height: barHeight, paddingBottom: insets.bottom }],
        tabBarActiveTintColor: C.accent,
        tabBarInactiveTintColor: C.faint,
        tabBarLabelStyle: [st.tabLabel, { fontSize: sc.f(10) }],
        tabBarIcon: ({ focused }) => <TabIcon route={route.name} focused={focused} />,
      })}>
      <Tabs.Screen name="Signals">
        {({ navigation }) => (
          <Signals
            onOpenCoin={(sym, coins, polls) =>
              navigation.navigate('Coin', { sym, coins, polls })
            }
            onPaywall={onPaywall}
          />
        )}
      </Tabs.Screen>
      <Tabs.Screen name="Markets">
        {({ navigation }) => (
          <Markets
            onOpenCoin={(market) => navigation.navigate('Chart', { market })}
            onPaywall={onPaywall}
          />
        )}
      </Tabs.Screen>
      <Tabs.Screen name="Predict">
        {() => <PredictTab onPaywall={onPaywall} />}
      </Tabs.Screen>
      <Tabs.Screen name="Record" component={Record} />
      <Tabs.Screen name="Settings">
        {() => <SettingsScreen onPaywall={onPaywall} onAlerts={onAlerts} />}
      </Tabs.Screen>
    </Tabs.Navigator>
  );
}

export default function Navigation() {
  // `onboarded` lives in the store so signOut can reset it and actually
  // return the user to onboarding.
  const { onboarded, finishOnboarding, hydrated } = useStore();
  const [autoPaywall, setAutoPaywall] = useState(false);

  // Persisted state arrives asynchronously. Rendering the stack before it
  // lands would show onboarding to a user who finished it months ago, then
  // yank it away — so hold on a blank ground for the one frame it takes.
  if (!hydrated) {
    return <View style={st.boot} />;
  }

  return (
    <NavigationContainer theme={theme}>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        {!onboarded ? (
          <Stack.Screen name="Onboarding">
            {() => (
              <Onboarding
                onDone={finishOnboarding}
                onSeePlans={() => {
                  setAutoPaywall(true);
                  finishOnboarding();
                }}
              />
            )}
          </Stack.Screen>
        ) : (
          <>
            <Stack.Screen name="Tabs">
              {({ navigation }) => (
                <MainTabs
                  onPaywall={() => navigation.navigate('Paywall')}
                  onAlerts={() => navigation.navigate('Alerts')}
                  autoPaywall={autoPaywall}
                  onPaywallShown={() => setAutoPaywall(false)}
                />
              )}
            </Stack.Screen>
            <Stack.Screen
              name="Chart"
              // The ONLY screen that disables the swipe-back gesture.
              //
              // This screen's whole interaction is a horizontal drag across the
              // chart to move the crosshair, and the stack's interactive pop
              // recognizer wins that contest every time: dragging on the chart
              // popped straight back to Markets instead of reading a price, which
              // made the crosshair unusable. Found by dragging it on a device;
              // the JS PanResponder claims the gesture correctly and still loses
              // to the native recognizer.
              //
              // Navigation is not lost — BackHeader's arrow is right there, and
              // it is the affordance the rest of the app already uses.
              options={{ gestureEnabled: false }}>
              {({ route, navigation }) => {
                const p = route.params as { market?: Market } | undefined;
                // No sample fallback on purpose: this screen exists because a
                // fabricated price is worse than no screen. Without a real
                // market row there is nothing honest to render, so go back.
                if (!p?.market) {
                  navigation.goBack();
                  return null;
                }
                return (
                  <CoinChart
                    market={p.market}
                    onBack={() => navigation.goBack()}
                    onPaywall={() => navigation.navigate('Paywall')}
                  />
                );
              }}
            </Stack.Screen>
            <Stack.Screen name="Coin">
              {({ route, navigation }) => {
                const p = route.params as
                  | { sym?: string; coins?: Coin[]; polls?: Polls }
                  | undefined;
                return (
                  <CoinDetail
                    symbol={p?.sym ?? 'BTC'}
                    coins={p?.coins}
                    polls={p?.polls}
                    onBack={() => navigation.goBack()}
                    onPaywall={() => navigation.navigate('Paywall')}
                  />
                );
              }}
            </Stack.Screen>
            <Stack.Screen name="Alerts">
              {({ navigation }) => (
                <Alerts
                  onBack={() => navigation.goBack()}
                  onPaywall={() => navigation.navigate('Paywall')}
                />
              )}
            </Stack.Screen>
            {MONETIZATION && (
              <Stack.Screen name="Paywall" options={{ presentation: 'modal' }}>
                {({ navigation }) => <Paywall onClose={() => navigation.goBack()} />}
              </Stack.Screen>
            )}
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}

const st = StyleSheet.create({
  tabBar: {
    backgroundColor: C.bg,
    borderTopColor: C.cardBorder,
    borderTopWidth: 1,
    paddingTop: 6,
  },
  tabLabel: { fontWeight: '600' },
  tabIconWrap: { alignItems: 'center', justifyContent: 'center' },
  boot: { flex: 1, backgroundColor: C.bg },
});
