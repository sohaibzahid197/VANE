// Coin chart — price history across seven ranges.
//
// A SEPARATE SCREEN FROM CoinDetail, deliberately.
//
// CoinDetail takes an optional `coins` array and falls back to the bundled
// sample when it is absent. That fallback is load-bearing for the Signals tab
// and it has already caused one real bug: the Predict tab rendered
// <CoinDetail symbol="BTC" /> with no data and showed $123,410 beside the real
// price in another tab, and a prediction placed from there submitted the sample
// price as a real entry price. Routing the Markets tab into the same screen
// would reintroduce exactly that, because Markets carries market rows rather
// than signal rows.
//
// So this screen takes the real market row it was opened with and fetches its
// own history. Nothing here can fall back to sample data, because there is no
// sample to fall back to.

import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { C, tint } from '../theme.ts';
import { useScale } from '../responsive.ts';
import { BackHeader, Card, Disclaimer, ErrorState, Label, Loading, Screen, Text } from '../ui.tsx';
import { Chart } from '../Chart.tsx';
import {
  RANGES,
  compact,
  compactUnits,
  fetchHistory,
  type History,
  type Market,
  type Range,
} from '../markets.ts';
import { useStore } from '../store.tsx';

/** Line rather than candles for 1H: too few bars for bodies to read. */
const LINE_RANGES: Range[] = ['1H'];

export default function CoinChart({
  market,
  onBack,
  onPaywall,
}: {
  market: Market;
  onBack: () => void;
  onPaywall: () => void;
}) {
  const { isPro } = useStore();
  const st = useStyles();
  const s = useScale();

  const [history, setHistory] = useState<History | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<Range>('24H');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchHistory(market.sym, isPro)
      .then((h) => {
        if (cancelled) return;
        setHistory(h);
        // A coin whose stored document has no 24H series still has SOMETHING.
        // Land on a range that exists rather than an empty chart.
        if (h && !h.ranges['24H']) {
          const first = RANGES.find((r) => h.ranges[r]);
          if (first) setRange(first);
        }
      })
      .catch((e: any) => {
        if (!cancelled) setError(e?.message ?? 'Chart unavailable');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [market.sym, isPro]);

  const available = useMemo(
    () => RANGES.filter((r) => history?.ranges[r]),
    [history],
  );
  const series = history?.ranges[range] ?? null;

  const dir = market.up ? C.accent : C.down;
  const chartW = s.w(320);
  const chartH = s.h(240);

  return (
    <Screen scroll={false}>
      <BackHeader title={market.name} onBack={onBack} />

      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={st.head}>
          <View style={[st.badge, { backgroundColor: tint(dir, 0.12) }]}>
            <Text style={[st.badgeText, { color: dir }]}>{market.sym}</Text>
          </View>
          <View style={st.headText}>
            <Text style={st.price}>{market.priceLabel}</Text>
            <Text style={[st.change, { color: dir }]}>
              {market.changeLabel} · 24h
              {market.rank ? ` · rank #${market.rank}` : ''}
            </Text>
          </View>
        </View>

        {/* Range selector. Only ranges the document actually carries are
            offered — an enabled tab that yields a blank chart reads as a bug,
            and a newly listed coin genuinely has no 1Y series. */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={st.rangeBar}
          contentContainerStyle={st.rangeBarInner}>
          {RANGES.map((r) => {
            const enabled = available.includes(r);
            const active = r === range;
            return (
              <Pressable
                key={r}
                disabled={!enabled}
                onPress={() => setRange(r)}
                accessibilityRole="button"
                accessibilityState={{ selected: active, disabled: !enabled }}
                accessibilityLabel={`${r} range${enabled ? '' : ', unavailable'}`}
                style={[
                  st.rangeTab,
                  active && { backgroundColor: tint(C.accent, 0.14), borderColor: C.accent },
                  !enabled && st.rangeTabOff,
                ]}>
                <Text
                  style={[
                    st.rangeText,
                    active && { color: C.accent },
                    !enabled && { color: C.faint },
                  ]}>
                  {r}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>

        {loading ? (
          <Loading label="Loading chart" />
        ) : error ? (
          <ErrorState message={error} />
        ) : !series ? (
          <Card>
            <Label>No chart yet</Label>
            <Text style={st.muted}>
              {isPro
                ? 'The pipeline has not published history for this coin yet.'
                : 'Chart history for this coin is part of Pro.'}
            </Text>
            {!isPro && (
              <Pressable onPress={onPaywall} accessibilityRole="button" style={st.unlock}>
                <Text style={st.unlockText}>Unlock charts</Text>
              </Pressable>
            )}
          </Card>
        ) : (
          <Card>
            <Chart
              series={series}
              width={chartW}
              height={chartH}
              range={range}
              mode={LINE_RANGES.includes(range) ? 'line' : 'candles'}
            />
            <Text style={st.hint}>Touch and drag the chart to read exact values</Text>
          </Card>
        )}

        <Card>
          <Label>Market</Label>
          <Stat label="Market cap" value={compact(market.marketCap)} />
          <Stat label="24h volume" value={compact(market.volume24h)} />
          <Stat label="Circulating supply" value={compactUnits(market.circulating)} />
          <Stat label="Total supply" value={compactUnits(market.totalSupply)} />
          <Stat
            label="Max supply"
            // A coin with no cap is not a coin with a cap of zero. ETH has no
            // max supply; printing "0" there is simply false.
            value={market.maxSupply === null ? 'No cap' : compactUnits(market.maxSupply)}
          />
        </Card>

        <Card>
          <Label>All-time</Label>
          <Stat
            label="High"
            value={
              market.ath === null
                ? '—'
                : `${compact(market.ath)}${
                    market.athChangePct === null ? '' : ` (${market.athChangePct.toFixed(1)}%)`
                  }`
            }
          />
          <Stat label="High date" value={dateLabel(market.athDate)} />
          <Stat label="Low" value={market.atl === null ? '—' : compact(market.atl)} />
          <Stat label="Low date" value={dateLabel(market.atlDate)} />
        </Card>

        {/*
          Two honest labels, not garnish.

          "Powered by CoinGecko" is a licence term — CoinGecko's API Terms require
          it prominently at font size >= 10 on every tier, paid included.

          The resolution note matters because these are NOT exchange candles.
          Open/high/low are derived by resampling closes into buckets, so a wick
          that reversed inside the source resolution is invisible. Saying so is
          cheaper than having someone discover it by comparing against an
          exchange.
        */}
        <Text style={st.attribution}>Powered by CoinGecko</Text>
        {history ? (
          <Text style={st.resolution}>
            Bars aggregated from closing prices, not exchange open/high/low.
          </Text>
        ) : null}

        <Disclaimer />
      </ScrollView>
    </Screen>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  const st = useStyles();
  return (
    <View style={st.statRow}>
      <Text style={st.statLabel}>{label}</Text>
      <Text style={st.statValue}>{value}</Text>
    </View>
  );
}

function dateLabel(iso: string | null): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString() : '—';
}

function useStyles() {
  const { w, h, f } = useScale();
  return useMemo(
    () =>
      StyleSheet.create({
        head: { flexDirection: 'row', alignItems: 'center', marginBottom: h(12) },
        badge: { paddingHorizontal: w(10), paddingVertical: h(6), borderRadius: w(8) },
        badgeText: { fontSize: f(12), fontWeight: '700' },
        headText: { marginLeft: w(10), flex: 1 },
        price: { color: C.text, fontSize: f(22), fontWeight: '700' },
        change: { fontSize: f(11), marginTop: h(2) },
        rangeBar: { marginBottom: h(10) },
        rangeBarInner: { gap: w(6) },
        rangeTab: {
          paddingHorizontal: w(12),
          // 36 keeps the tab tappable without crowding seven of them on a phone.
          height: h(36),
          justifyContent: 'center',
          borderRadius: w(8),
          borderWidth: 1,
          borderColor: C.cardBorder,
          backgroundColor: C.card,
        },
        rangeTabOff: { opacity: 0.4 },
        rangeText: { color: C.dim, fontSize: f(11), fontWeight: '600' },
        hint: { color: C.faint, fontSize: f(10), marginTop: h(8), textAlign: 'center' },
        muted: { color: C.dim, fontSize: f(12), marginTop: h(4) },
        unlock: {
          marginTop: h(10),
          paddingVertical: h(10),
          borderRadius: w(8),
          alignItems: 'center',
          backgroundColor: tint(C.accent, 0.14),
          borderWidth: 1,
          borderColor: C.accent,
        },
        unlockText: { color: C.accent, fontSize: f(12), fontWeight: '700' },
        statRow: {
          flexDirection: 'row',
          justifyContent: 'space-between',
          paddingVertical: h(6),
        },
        statLabel: { color: C.faint, fontSize: f(11) },
        statValue: { color: C.text, fontSize: f(12), fontWeight: '600' },
        // 10 is a licence floor, not a design choice.
        attribution: {
          color: C.faint,
          fontSize: Math.max(10, f(10)),
          textAlign: 'center',
          marginTop: h(12),
        },
        resolution: {
          color: C.faint,
          fontSize: Math.max(10, f(9)),
          textAlign: 'center',
          marginTop: h(4),
        },
      }),
    [w, h, f],
  );
}
