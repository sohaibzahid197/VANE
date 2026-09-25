// Screen 1f — alerts. Toggles are real state; PRO rows are gated until the
// entitlement says otherwise. The daily digest is scheduled on-device.

import React, { useEffect, useMemo, useState } from 'react';
import { AppState, Linking, Pressable, StyleSheet, View } from 'react-native';
import { C, tint } from '../theme.ts';
import { useScale } from '../responsive.ts';
import { BackHeader, Button, Card, Disclaimer, MIN_TAP, Screen, Text, tapSlop } from '../ui.tsx';
import { PRO_ALERT, useStore } from '../store.tsx';
import { MONETIZATION, isAlertLocked } from '../config.ts';
import {
  hasPermission, permissionIsBlocked, requestPermission, syncAlerts,
} from '../notifications.ts';

/**
 * Only the daily digest is listed, because only the daily digest exists.
 *
 * The other four rows — signal flips, high conviction, target hit, crowd
 * divergence — were toggles over nothing: no server sends them, nothing reads
 * the stored preference, and three of them were sold as Pro features. A
 * switch that animates and does nothing is worse than an absent feature, so
 * they are gone until there is a sender behind them.
 */
/** Index of the digest within the persisted alerts array. Unchanged so an
 *  existing install's stored preference still maps to the right row. */
const DIGEST_INDEX = 3;

const ALERTS: { title: string; desc: string; index: number }[] = [
  // Back, because there is finally a sender behind it. The pipeline diffs
  // each coin's direction against the previous run and pushes once per user
  // however many coins turned — see vane-pipeline/src/notify.ts. Only
  // watchlisted coins qualify, so the user chose every one of them.
  {
    title: 'Signal flips',
    desc: 'When a coin on your watchlist changes direction',
    index: 1,
  },
  { title: 'Daily digest', desc: 'One summary at 08:00 local', index: DIGEST_INDEX },
];


export default function Alerts({
  onPaywall, onBack,
}: {
  onPaywall?: () => void;
  onBack?: () => void;
}) {
  const { alerts, toggleAlert, isPro } = useStore();
  const s = useScale();
  const st = useStyles();
  const [granted, setGranted] = useState<boolean | null>(null);

  const [blocked, setBlocked] = useState(false);

  // Re-check whenever the app comes back to the foreground. Checking only on
  // mount meant a user who enabled notifications in OS settings and swiped
  // back still saw "Notifications are off" until the screen remounted.
  useEffect(() => {
    const check = () => {
      hasPermission().then(setGranted).catch(() => setGranted(false));
      permissionIsBlocked().then(setBlocked).catch(() => {});
    };
    check();
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active') check();
    });
    return () => sub.remove();
  }, []);

  // Keep the on-device digest in step with the toggle.
  useEffect(() => {
    if (granted) syncAlerts(alerts).catch(() => {});
  }, [alerts, granted]);

  // Derived from the rows actually rendered, not from the full PRO_ALERT
  // table. Indices 1, 2 and 4 are still flagged Pro there but no longer appear
  // in ALERTS, so this was permanently true and rendered an "Unlock all alerts
  // with Pro" button on a screen where nothing was locked — selling something
  // that does not exist.
  // Only the rows that are actually rendered. The digest is the single alert
  // that exists, and it is free, so this is false. It was
  // `PRO_ALERT.some(Boolean)` — permanently true, because indices 1, 2 and 4
  // are still flagged Pro in that table while no longer appearing in ALERTS —
  // which rendered an "Unlock all alerts with Pro" button on a screen where
  // nothing was locked.
  const anyLocked = useMemo(
    () => ALERTS.some((a) => isAlertLocked(PRO_ALERT[a.index] ?? false, isPro)),
    [isPro],
  );

  return (
    <Screen>
      {onBack && <BackHeader onBack={onBack} />}
      <Text style={st.title} accessibilityRole="header">Alerts</Text>
      <Text style={st.sub}>
        Scheduled on this device, so it works without a network connection and
        follows your timezone. Delivery is best-effort and may be delayed by
        your device settings.
      </Text>

      {granted === false && (
        <Card style={st.permCard}>
          <Text style={st.permTitle}>Notifications are off</Text>
          <Text style={st.permSub}>
            {blocked
              ? 'Notifications are blocked for VANE. Turn them on in your device settings.'
              : 'Turn them on to get your daily digest.'}
          </Text>
          <View style={{ marginTop: s.h(12) }}>
            {blocked ? (
              // The OS will not prompt twice. Offering the button again would
              // be a button that provably does nothing.
              <Button
                title="Open device settings"
                onPress={() => Linking.openSettings().catch(() => {})}
              />
            ) : (
              <Button
                title="Enable notifications"
                onPress={async () => {
                  const ok = await requestPermission().catch(() => false);
                  setGranted(ok);
                  if (!ok) setBlocked(await permissionIsBlocked().catch(() => false));
                }}
              />
            )}
          </View>
        </Card>
      )}

      {ALERTS.map(({ title, desc, index: i }) => {
        const pro = PRO_ALERT[i];
        const locked = isAlertLocked(pro, isPro);
        const on = alerts[i] && !locked;

        return (
          <Card key={title} style={st.row}>
            <View style={st.rowMid}>
              <View style={st.rowHead}>
                <Text
                  style={[st.rowTitle, locked && { color: C.dim }]}
                  numberOfLines={1}>
                  {title}
                </Text>
                {MONETIZATION && pro && (
                  <View style={st.proTag}>
                    <Text style={st.proText}>PRO</Text>
                  </View>
                )}
              </View>
              <Text style={st.rowDesc} numberOfLines={2}>{desc}</Text>
            </View>

            <Pressable
              onPress={() => (locked ? onPaywall?.() : toggleAlert(i))}
              hitSlop={tapSlop(s.w(42), s.w(24))}
              accessibilityRole="switch"
              accessibilityLabel={`${title}. ${desc}`}
              accessibilityState={{ checked: on, disabled: locked }}
              accessibilityHint={
                locked ? 'Pro feature. Opens subscription options.' : undefined
              }
              style={[
                st.track,
                {
                  backgroundColor: on ? C.accent : 'rgba(255,255,255,.18)',
                  opacity: locked ? 0.45 : 1,
                },
              ]}>
              <View
                style={[
                  st.knob,
                  { transform: [{ translateX: on ? s.w(18) : 0 }] },
                ]}
              />
            </Pressable>
          </Card>
        );
      })}

      {anyLocked && onPaywall && (
        <View style={{ marginTop: s.h(6) }}>
          <Button
            title="Unlock all alerts with Pro"
            onPress={onPaywall}
            variant="ghost"
          />
        </View>
      )}

      <Disclaimer />
    </Screen>
  );
}

function useStyles() {
  const { w, h, f } = useScale();
  return useMemo(() => {
    // Track and knob share one axis so the knob can never escape the track.
    const trackW = w(42);
    const trackH = w(24);
    const pad = 3;
    const knob = trackH - pad * 2;
    return StyleSheet.create({
      title: { color: C.text, fontSize: f(24), fontWeight: '700', marginTop: h(6) },
      sub: {
        color: C.dim, fontSize: f(12), lineHeight: f(18),
        marginTop: h(6), marginBottom: h(16),
      },

      permCard: {
        backgroundColor: tint(C.accent, 0.07),
        borderColor: tint(C.accent, 0.2),
      },
      permTitle: { color: C.text, fontSize: f(15), fontWeight: '700' },
      permSub: { color: C.dim, fontSize: f(12), marginTop: h(4), lineHeight: f(18) },

      row: { flexDirection: 'row', alignItems: 'center', gap: w(12), minHeight: MIN_TAP },
      rowMid: { flex: 1 },
      rowHead: { flexDirection: 'row', alignItems: 'center', gap: w(7) },
      rowTitle: { color: C.text, fontSize: f(14), fontWeight: '600', flexShrink: 1 },
      proTag: {
        backgroundColor: tint(C.accent, 0.16), borderRadius: w(5),
        paddingHorizontal: w(6), paddingVertical: 2,
      },
      proText: { color: C.accent, fontSize: f(9), fontWeight: '700', letterSpacing: 0.5 },
      rowDesc: { color: C.faint, fontSize: f(11), marginTop: h(3), lineHeight: f(16) },

      track: {
        width: trackW, height: trackH, borderRadius: trackH / 2,
        padding: pad, justifyContent: 'center',
      },
      knob: { width: knob, height: knob, borderRadius: knob / 2, backgroundColor: '#fff' },
    });
  }, [w, h, f]);
}
