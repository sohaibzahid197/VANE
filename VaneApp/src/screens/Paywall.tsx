// Screen 1b — the paywall.
//
// No purchase wiring yet (IAP comes last), but the disclosure copy is already
// laid out the way App Store guideline 3.1.2 requires: price, period, renewal
// and the Terms/Privacy links adjacent to the button, not buried.

import React, { useMemo } from 'react';
import { Alert, Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { C, tint } from '../theme.ts';

/** Opening a URL can reject (no handler, malformed link). Unhandled, that is
 *  a silent no-op for the user and a LogBox warning for us. */
function openExternal(url: string) {
  Linking.openURL(url).catch(() => {
    Alert.alert("Couldn't open link", url);
  });
}
import { useScale } from '../responsive.ts';
import { Button, MIN_TAP, Text, tapSlop } from '../ui.tsx';
import { useStore } from '../store.tsx';
import { IconClose, IconTick } from '../icons.tsx';


const PERKS = [
  'Unlimited signals across 100 coins',
  'Model reasoning for every call',
  '24h, 7d and 30d price targets',
  'Push alerts when a signal flips',
  'Full history and accuracy stats',
];

export default function Paywall({ onClose }: { onClose: () => void }) {
  const { plan, setPlan, setPro } = useStore();
  const s = useScale();
  const st = useStyles();
  const yearly = plan === 'year';

  return (
    <SafeAreaView style={st.root}>
      <View style={st.head}>
        <Text style={st.brand}>VANE PRO</Text>
        <Pressable
          onPress={onClose}
          hitSlop={14}
          accessibilityRole="button"
          accessibilityLabel="Close"
          style={st.close}>
          <IconClose size={s.w(15)} color={C.dim} />
        </Pressable>
      </View>

      <ScrollView
        style={st.body}
        contentContainerStyle={st.bodyContent}
        showsVerticalScrollIndicator={false}>
        <Text style={st.title} accessibilityRole="header">Every signal, unlocked.</Text>

        <View style={st.perks}>
          {PERKS.map((p) => (
            <View key={p} style={st.perkRow}>
              <IconTick size={s.w(16)} color={C.accent} />
              <Text style={st.perkText}>{p}</Text>
            </View>
          ))}
        </View>

        <Pressable
          onPress={() => setPlan('year')}
          accessibilityRole="radio"
          accessibilityLabel="Yearly, 49 dollars 99 per year, save 86 percent"
          accessibilityState={{ selected: yearly }}
          style={[st.plan, yearly ? st.planOn : st.planOff]}>
          <View style={st.planLeft}>
            <Text style={st.planName}>Yearly</Text>
            <Text style={st.planSub}>$49.99 / year · $4.16 per month</Text>
          </View>
          <View style={st.saveTag}>
            <Text style={st.saveText}>SAVE 86%</Text>
          </View>
        </Pressable>

        <Pressable
          onPress={() => setPlan('week')}
          accessibilityRole="radio"
          accessibilityLabel="Weekly, 6 dollars 99 per week"
          accessibilityState={{ selected: !yearly }}
          style={[st.plan, !yearly ? st.planOn : st.planOff]}>
          <View style={st.planLeft}>
            <Text style={st.planName}>Weekly</Text>
            <Text style={st.planSub}>$6.99 / week</Text>
          </View>
        </Pressable>
      </ScrollView>

      <View style={st.foot}>
        <Button
          title={yearly ? 'Subscribe yearly' : 'Subscribe weekly'}
          onPress={() => {
            // Purchases are not wired up yet. In a release build this must
            // never grant entitlement — otherwise tapping the button is a
            // free Pro unlock for every user.
            if (!__DEV__) {
              Alert.alert(
                'Not available yet',
                'Subscriptions are not enabled in this build.',
              );
              return;
            }
            setPro(true);
            onClose();
          }}
        />

        <Text style={st.fine}>
          {yearly ? '$79.99 per year. ' : '$4.99 per week. '}
          Your subscription renews automatically unless cancelled at least 24
          hours before the period ends. Manage or cancel in your device's
          subscription settings.
        </Text>

        <View style={st.links}>
          <Pressable
            onPress={() => openExternal('https://sohaibzahid197.github.io/VANE-legal/terms-and-conditions.html')}
            hitSlop={tapSlop(80, 14)}
            accessibilityRole="link"
            accessibilityLabel="Terms of Use">
            <Text style={st.link}>Terms of Use</Text>
          </Pressable>
          <Text style={st.linkDot}>·</Text>
          <Pressable
            onPress={() => openExternal('https://sohaibzahid197.github.io/VANE-legal/privacy-policy.html')}
            hitSlop={tapSlop(80, 14)}
            accessibilityRole="link"
            accessibilityLabel="Privacy Policy">
            <Text style={st.link}>Privacy Policy</Text>
          </Pressable>
          <Text style={st.linkDot}>·</Text>
          <Pressable
            onPress={() =>
              Alert.alert('Restore purchases', 'Available once in-app purchases are wired up.')
            }
            hitSlop={tapSlop(80, 14)}
            accessibilityRole="button"
            accessibilityLabel="Restore purchases">
            <Text style={st.link}>Restore</Text>
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  );
}

function useStyles() {
  const { w, h, f, width } = useScale();
  return useMemo(() => StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg, paddingHorizontal: w(18) },
  head: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'center', paddingTop: h(6),
  },
  brand: { color: C.accent, fontSize: f(13), fontWeight: '700', letterSpacing: 3 },
  close: {
    width: w(30), height: w(30), borderRadius: w(15),
    backgroundColor: 'rgba(255,255,255,.08)',
    alignItems: 'center', justifyContent: 'center',
  },

  body: { flex: 1 },
  bodyContent: { flexGrow: 1, justifyContent: 'center', paddingVertical: h(10) },
  title: {
    color: C.text, fontSize: f(29), fontWeight: '700',
    lineHeight: f(35), marginBottom: h(20),
  },
  perks: { gap: h(10), marginBottom: h(24) },
  perkRow: { flexDirection: 'row', alignItems: 'center', gap: w(10) },
  perkText: { color: C.dim, fontSize: f(14), flex: 1 },

  plan: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    borderRadius: w(16), padding: w(15), marginBottom: h(10), minHeight: MIN_TAP,
  },
  planOn: {
    borderWidth: 1.5, borderColor: C.accent,
    backgroundColor: tint(C.accent, 0.08),
  },
  planOff: {
    borderWidth: 1.5, borderColor: 'rgba(255,255,255,.09)',
    backgroundColor: 'rgba(255,255,255,.03)',
  },
  planLeft: { flex: 1 },
  planName: { color: C.text, fontSize: f(16), fontWeight: '700' },
  planSub: { color: C.dim, fontSize: f(12), marginTop: h(3) },
  saveTag: {
    backgroundColor: C.accent, borderRadius: w(7),
    paddingHorizontal: w(8), paddingVertical: h(4),
  },
  saveText: { color: C.bg, fontSize: f(9), fontWeight: '700', letterSpacing: 0.5 },

  foot: { paddingBottom: h(8) },
  fine: {
    color: C.faint, fontSize: f(11), lineHeight: f(16),
    textAlign: 'center', marginTop: h(12),
  },
  links: {
    flexDirection: 'row', justifyContent: 'center',
    alignItems: 'center', gap: w(8), marginTop: h(10),
  },
  link: { color: C.dim, fontSize: f(11), textDecorationLine: 'underline' },
  linkDot: { color: C.faint, fontSize: f(11) },
}), [width, w, h, f]);
}
