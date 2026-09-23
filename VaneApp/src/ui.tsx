// Shared primitives every screen builds from, so spacing, radii and states
// stay identical across the app instead of being re-guessed per screen.
//
// Every style here is built inside useMemo against the live window size, so
// rotation, fold and split-screen resize all reflow. Accessibility props are
// baked in rather than left to each call site.

import React, { useMemo } from 'react';
import {
  ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet,
  Text as RNText, View, type TextProps, type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { C, tint } from './theme.ts';
import { MAX_FONT_SCALE, useScale } from './responsive.ts';
import { IconBack, IconEmpty, IconWarning } from './icons.tsx';

/** Every Text in the app caps OS font scaling, so 200% cannot break rows. */
export function Text(props: TextProps) {
  return <RNText maxFontSizeMultiplier={MAX_FONT_SCALE} {...props} />;
}

/** Minimum tap area. Apple asks 44x44pt, Android 48x48dp. */
export const MIN_TAP = 48;

/** Expands a small control's touch area without changing its visual size. */
export function tapSlop(visibleW: number, visibleH: number) {
  return {
    top: Math.max(0, (MIN_TAP - visibleH) / 2),
    bottom: Math.max(0, (MIN_TAP - visibleH) / 2),
    left: Math.max(0, (MIN_TAP - visibleW) / 2),
    right: Math.max(0, (MIN_TAP - visibleW) / 2),
  };
}

export function Screen({
  children, scroll = true, pad = true, onRefresh, refreshing = false,
}: {
  children: React.ReactNode;
  scroll?: boolean;
  pad?: boolean;
  /** Enables pull-to-refresh. Without it a loaded screen had no way at all to
   *  fetch again short of force-quitting the app. */
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  const s = useScale();
  const st = useStyles();

  const inner = (
    <View
      style={[
        st.column,
        { maxWidth: s.maxWidth },
        pad && { paddingHorizontal: s.w(18) },
      ]}>
      {children}
    </View>
  );

  return (
    <SafeAreaView style={st.root} edges={['top', 'left', 'right']}>
      {scroll ? (
        <ScrollView
          contentContainerStyle={{ paddingBottom: s.h(28) }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            onRefresh ? (
              <RefreshControl
                refreshing={refreshing}
                onRefresh={onRefresh}
                tintColor={C.accent}
                colors={[C.accent]}
              />
            ) : undefined
          }>
          {inner}
        </ScrollView>
      ) : (
        inner
      )}
    </SafeAreaView>
  );
}

export function H1({ children }: { children: React.ReactNode }) {
  const st = useStyles();
  return <Text style={st.h1} accessibilityRole="header">{children}</Text>;
}

export function Body({ children }: { children: React.ReactNode }) {
  const st = useStyles();
  return <Text style={st.body}>{children}</Text>;
}

export function Label({ children }: { children: React.ReactNode }) {
  const st = useStyles();
  return <Text style={st.label}>{children}</Text>;
}

export function Card({
  children, style, onPress, label, hint,
}: {
  children: React.ReactNode;
  style?: ViewStyle;
  onPress?: () => void;
  /** Screen-reader name when the card is tappable. */
  label?: string;
  /** What activating it will do, when that is not obvious from the name. */
  hint?: string;
}) {
  const st = useStyles();
  // A non-pressable card with a label still needs to be ONE screen-reader
  // node. Returning a bare View dropped the label entirely, so every history
  // row was read out as three disconnected fragments.
  const content = (
    <View
      style={[st.card, style]}
      accessible={label ? true : undefined}
      accessibilityLabel={label}>
      {children}
    </View>
  );
  if (!onPress) return content;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      style={({ pressed }) => (pressed ? st.pressed : undefined)}>
      {content}
    </Pressable>
  );
}

export function Button({
  title, onPress, variant = 'primary', disabled, label,
}: {
  title: string; onPress?: () => void;
  variant?: 'primary' | 'ghost'; disabled?: boolean; label?: string;
}) {
  const st = useStyles();
  const primary = variant === 'primary';
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label ?? title}
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => [
        st.btn,
        primary ? st.btnPrimary : st.btnGhost,
        pressed && { opacity: 0.82 },
        disabled && { opacity: 0.45 },
      ]}>
      <Text style={[st.btnText, { color: primary ? C.bg : C.text }]}>{title}</Text>
    </Pressable>
  );
}

export function Segmented<T extends string>({
  options, value, onChange, label,
}: {
  options: readonly T[]; value: T; onChange: (v: T) => void; label?: string;
}) {
  const st = useStyles();
  return (
    <View style={st.seg} accessibilityRole="tablist" accessibilityLabel={label}>
      {options.map((o) => {
        const on = o === value;
        return (
          <Pressable
            key={o}
            onPress={() => onChange(o)}
            accessibilityRole="tab"
            accessibilityLabel={o}
            accessibilityState={{ selected: on }}
            style={[st.segOpt, on && st.segOptOn]}>
            <Text style={[st.segText, on && st.segTextOn]}>{o}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Pill({ text, color }: { text: string; color: string }) {
  const st = useStyles();
  return (
    <View style={[st.pill, { backgroundColor: tint(color, 0.14) }]}>
      <Text style={[st.pillText, { color }]}>{text}</Text>
    </View>
  );
}

/** The states the prototype never had. */
export function Loading({ label = 'Loading signals' }: { label?: string }) {
  const st = useStyles();
  return (
    <View style={st.centered} accessibilityRole="progressbar" accessibilityLabel={label}>
      <ActivityIndicator color={C.accent} />
      <Text style={st.stateText}>{label}</Text>
    </View>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const s = useScale();
  const st = useStyles();
  return (
    <View style={st.centered} accessibilityLiveRegion="polite">
      <IconWarning size={s.w(26)} color={C.faint} />
      <Text style={st.stateTitle} accessibilityRole="header">Couldn't load</Text>
      <Text style={st.stateText}>{message}</Text>
      {onRetry && (
        <View style={{ marginTop: s.h(14), minWidth: s.w(160) }}>
          <Button title="Try again" onPress={onRetry} variant="ghost" />
        </View>
      )}
    </View>
  );
}

export function EmptyState({ title, sub }: { title: string; sub: string }) {
  const s = useScale();
  const st = useStyles();
  return (
    <View style={st.centered}>
      <IconEmpty size={s.w(26)} color={C.faint} />
      <Text style={st.stateTitle} accessibilityRole="header">{title}</Text>
      <Text style={st.stateText}>{sub}</Text>
    </View>
  );
}

/**
 * Back affordance for pushed screens. headerShown is false navigator-wide, so
 * without this the only way out of Coin/Alerts is the OS gesture — invisible
 * on iOS and a dead end for anyone who does not know it.
 */
export function BackHeader({ title, onBack }: { title?: string; onBack: () => void }) {
  const s = useScale();
  const st = useStyles();
  return (
    <View style={st.backRow}>
      <Pressable
        onPress={onBack}
        hitSlop={tapSlop(s.w(30), s.w(30))}
        accessibilityRole="button"
        accessibilityLabel="Go back"
        style={st.backBtn}>
        <IconBack size={s.w(20)} color={C.text} />
      </Pressable>
      {title ? (
        <Text style={st.backTitle} numberOfLines={1}>
          {title}
        </Text>
      ) : null}
    </View>
  );
}

export function Disclaimer() {
  const st = useStyles();
  return (
    <Text style={st.disclaimer}>
      Signals are probabilistic and are often wrong. VANE does not provide
      financial advice. Never invest more than you can afford to lose.
    </Text>
  );
}

/** Styles rebuilt whenever the window size changes. */
export function useStyles() {
  const { w, h, f } = useScale();
  return useMemo(
    () =>
      StyleSheet.create({
        root: { flex: 1, backgroundColor: C.bg },
        column: { width: '100%', alignSelf: 'center' },

        h1: { color: C.text, fontSize: f(28), fontWeight: '700', lineHeight: f(34) },
        body: { color: C.dim, fontSize: f(14), lineHeight: f(21) },
        label: {
          color: C.faint, fontSize: f(11), letterSpacing: 0.9,
          marginBottom: h(4), fontWeight: '600',
        },

        card: {
          backgroundColor: C.card, borderRadius: w(16), borderWidth: 1,
          borderColor: C.cardBorder, padding: w(14), marginBottom: h(10),
          overflow: 'hidden',
        },
        pressed: { opacity: 0.85 },

        btn: {
          borderRadius: w(14), paddingVertical: h(15),
          minHeight: MIN_TAP,
          alignItems: 'center', justifyContent: 'center',
        },
        btnPrimary: { backgroundColor: C.accent },
        btnGhost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: C.cardBorder },
        btnText: { fontSize: f(15), fontWeight: '700' },

        seg: {
          flexDirection: 'row', backgroundColor: 'rgba(255,255,255,.05)',
          borderRadius: w(11), padding: 3, marginBottom: h(14),
        },
        segOpt: {
          flex: 1, paddingVertical: h(9), borderRadius: w(9),
          minHeight: MIN_TAP, alignItems: 'center', justifyContent: 'center',
        },
        segOptOn: { backgroundColor: 'rgba(255,255,255,.1)' },
        segText: { color: C.faint, fontSize: f(12), fontWeight: '600' },
        segTextOn: { color: C.text },

        pill: { borderRadius: w(7), paddingHorizontal: w(9), paddingVertical: h(5) },
        pillText: { fontSize: f(10), fontWeight: '700', letterSpacing: 0.5 },

        centered: {
          alignItems: 'center', justifyContent: 'center',
          paddingVertical: h(60), gap: h(6),
        },
        stateTitle: { color: C.text, fontSize: f(16), fontWeight: '600' },
        stateText: {
          color: C.dim, fontSize: f(13), textAlign: 'center',
          paddingHorizontal: w(30),
        },

        backRow: {
          flexDirection: 'row', alignItems: 'center',
          gap: w(8), marginTop: h(4), marginBottom: h(6),
        },
        backBtn: {
          width: MIN_TAP, height: MIN_TAP,
          alignItems: 'flex-start', justifyContent: 'center',
        },
        backTitle: { color: C.dim, fontSize: f(14), flexShrink: 1 },

        disclaimer: {
          color: C.dim, fontSize: f(11), textAlign: 'center',
          marginTop: h(16), lineHeight: f(16),
        },
      }),
    [w, h, f],
  );
}
