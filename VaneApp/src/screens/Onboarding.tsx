// Screen 1a — onboarding carousel.

import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import Svg, { Polyline } from 'react-native-svg';
import { SafeAreaView } from 'react-native-safe-area-context';
import { C, tint } from '../theme.ts';
import { useScale } from '../responsive.ts';
import { Button, Disclaimer, Text, tapSlop } from '../ui.tsx';
import { MONETIZATION } from '../config.ts';
import { spark, toPath } from '../signals.ts';

// The figures in these cards are ILLUSTRATIVE, not live.
//
// They are frozen sample values used to show the shape of the product before
// a user has signed in or seen real data. Every card is marked "EXAMPLE" on
// screen, because an unlabelled "$126,400" next to a real-looking chart reads
// as a current BTC price and a real forecast — which is the sort of claim
// that makes every honest number in the app less believable.
const SLIDES = [
  {
    title: 'Tomorrow, priced today.',
    body: 'Direction and a price target for every major coin — refreshed through the day.',
    label: 'BTC · 24H SIGNAL', tag: 'UP', big: '$126,400', sub: 'target +2.4%',
  },
  {
    title: 'Read the crowd, then beat it.',
    body: 'See where other traders are leaning and how often the crowd is actually right.',
    label: 'CROWD VS MODEL', tag: 'DIVERGING', big: '64/36', sub: 'up / down votes',
  },
  {
    title: 'Keep score of your calls.',
    body: 'Place your own prediction, get graded automatically, and watch your accuracy compound.',
    label: 'YOUR RECORD', tag: '+4 STREAK', big: '63%', sub: '19 resolved',
  },
];

export default function Onboarding({
  onDone, onSeePlans,
}: {
  onDone: () => void;
  onSeePlans: () => void;
}) {
  const s = useScale();
  const st = useStyles();
  const [i, setI] = useState(0);
  const slide = SLIDES[i];
  const last = i === SLIDES.length - 1;
  const pts = spark(i * 3 + 1, 22, s.w(300), s.h(80), i !== 1);

  return (
    <SafeAreaView style={st.root}>
      <View style={st.head}>
        <Text style={st.brand}>VANE</Text>
        <Pressable
          onPress={onDone}
          hitSlop={tapSlop(60, 18)}
          accessibilityRole="button"
          accessibilityLabel="Skip onboarding">
          <Text style={st.skip}>Skip</Text>
        </Pressable>
      </View>

      <ScrollView
        style={st.body}
        contentContainerStyle={st.bodyContent}
        showsVerticalScrollIndicator={false}>
        <View style={st.card}>
          <View style={st.cardTop}>
            <Text style={st.cardLabel}>{slide.label}</Text>
            <View style={st.exampleTag}>
              <Text style={st.exampleText}>EXAMPLE</Text>
            </View>
            <View style={st.tag}>
              <Text style={st.tagText}>{slide.tag}</Text>
            </View>
          </View>
          <Svg width={s.w(300)} height={s.h(80)} style={{ marginVertical: s.h(10) }}>
            <Polyline points={toPath(pts)} fill="none" stroke={C.accent} strokeWidth={2} />
          </Svg>
          <View style={st.cardBottom}>
            <Text style={st.big}>{slide.big}</Text>
            <Text style={st.sub}>{slide.sub}</Text>
          </View>
        </View>

        <Text style={st.title} accessibilityRole="header">{slide.title}</Text>
        <Text style={st.copy}>{slide.body}</Text>
      </ScrollView>

      <View style={st.foot}>
        <View style={st.dots}>
          {SLIDES.map((_, j) => (
            <View
              key={j}
              style={[
                st.dot,
                j === i
                  ? { width: s.w(22), backgroundColor: C.accent }
                  : { width: s.w(6), backgroundColor: 'rgba(255,255,255,.18)' },
              ]}
            />
          ))}
        </View>
        <Button
          title={last ? (MONETIZATION ? 'See plans' : 'Get started') : 'Continue'}
          onPress={() => (last ? (MONETIZATION ? onSeePlans() : onDone()) : setI(i + 1))}
        />
        <Disclaimer />
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
  brand: { color: C.accent, fontSize: f(15), fontWeight: '700', letterSpacing: 4 },
  skip: { color: C.dim, fontSize: f(14) },

  body: { flex: 1 },
  bodyContent: { flexGrow: 1, justifyContent: 'center' },
  card: {
    backgroundColor: 'rgba(255,255,255,.045)', borderRadius: w(20),
    borderWidth: 1, borderColor: C.cardBorder, padding: w(16),
    marginBottom: h(28),
  },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  exampleTag: {
    borderWidth: 1, borderColor: 'rgba(255,255,255,.22)',
    borderRadius: w(5), paddingHorizontal: w(5), paddingVertical: h(2),
    marginLeft: w(7),
  },
  exampleText: {
    color: C.faint, fontSize: f(8), fontWeight: '700', letterSpacing: 0.8,
  },
  cardLabel: { color: C.faint, fontSize: f(10), letterSpacing: 1.4, fontWeight: '600' },
  tag: {
    backgroundColor: tint(C.accent, 0.16), borderRadius: w(7),
    paddingHorizontal: w(9), paddingVertical: h(4),
  },
  tagText: { color: C.accent, fontSize: f(10), fontWeight: '700', letterSpacing: 0.6 },
  cardBottom: { flexDirection: 'row', alignItems: 'flex-end', gap: w(10) },
  big: { color: C.text, fontSize: f(30), fontWeight: '700' },
  sub: { color: C.dim, fontSize: f(12), paddingBottom: h(5) },

  title: { color: C.text, fontSize: f(31), fontWeight: '700', lineHeight: f(38) },
  copy: { color: C.dim, fontSize: f(15), lineHeight: f(23), marginTop: h(12) },

  foot: { paddingBottom: h(10) },
  dots: { flexDirection: 'row', gap: 6, justifyContent: 'center', marginBottom: h(18) },
  dot: { height: 6, borderRadius: 3 },
}), [width, w, h, f]);
}
