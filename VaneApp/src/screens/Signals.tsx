// Screen 1c — today's signals. Tapping a row opens the coin detail.

import React, { useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Svg, { Polyline } from 'react-native-svg';
import { C, tint } from '../theme.ts';
import { useScale } from '../responsive.ts';
import { Card, Disclaimer, ErrorState, Loading, Screen, Segmented, Text, tapSlop } from '../ui.tsx';
import { HORIZONS, type Coin, type Horizon, seriesPath, toPath } from '../signals.ts';
import { useStore } from '../store.tsx';
import { isCoinLocked } from '../config.ts';
import { relativeTime, useSignals } from '../useSignals.ts';
import type { Polls } from '../api.ts';
import { IconLock, IconStar } from '../icons.tsx';

/**
 * One row, memoised.
 *
 * Thirty rows re-rendered together on every horizon tap — 30 sparkline
 * recomputations and ~700 views. Splitting the row out lets React skip the
 * ones whose props did not change.
 */
const CoinRow = React.memo(function CoinRow({
  coin, tf, locked, watched, onPress, onToggleWatch,
}: {
  coin: Coin;
  tf: Horizon;
  locked: boolean;
  watched: boolean;
  onPress: () => void;
  onToggleWatch: () => void;
}) {
  const s = useScale();
  const st = useStyles();
  const dir = coin.up ? C.accent : C.down;
  const [target, pct] = coin.targets[tf];
  // Real closes from the pipeline. No history means no line — better a blank
  // space than a made-up shape beside a real price.
  const pts = useMemo(
    () => seriesPath(coin.history ?? [], s.w(84), s.h(32)),
    [coin.history, s],
  );

  return (
    <Card
      label={
        locked
          ? `${coin.name}, locked. Unlock with Pro.`
          : `${coin.name}, ${coin.price}, ${tf} target ${target}, ${pct}`
      }
      onPress={onPress}>
      <View style={locked ? st.dimmed : undefined}>
        <View style={st.cardTop}>
          <View style={st.symWrap}>
            <View style={[st.symBadge, { backgroundColor: tint(dir, 0.12) }]}>
              <Text style={[st.symText, { color: dir }]}>{coin.sym}</Text>
            </View>
            <View style={st.nameWrap}>
              <Text style={st.coinName} numberOfLines={1}>{coin.name}</Text>
              <Text style={st.coinPrice}>{coin.price}</Text>
            </View>
          </View>
          <View style={st.rowRight}>
            <Svg width={s.w(84)} height={s.h(32)}>
              {pts.length > 1 && (
                <Polyline points={toPath(pts)} fill="none" stroke={dir} strokeWidth={1.8} />
              )}
            </Svg>
            <Pressable
              onPress={onToggleWatch}
              hitSlop={tapSlop(s.w(22), s.w(22))}
              accessibilityRole="button"
              accessibilityLabel={
                watched ? `Remove ${coin.name} from watchlist` : `Add ${coin.name} to watchlist`
              }
              accessibilityState={{ selected: watched }}>
              <IconStar size={s.w(18)} color={watched ? C.accent : C.faint} filled={watched} />
            </Pressable>
          </View>
        </View>

        <View style={st.cardBottom}>
          <View>
            <Text style={st.metricLabel}>{tf} TARGET</Text>
            <Text style={st.metricValue}>{target}</Text>
          </View>
          <View>
            <Text style={st.metricLabel}>MOVE</Text>
            <Text style={[st.metricValue, { color: dir }]}>{pct}</Text>
          </View>
          <View style={[st.rating, { backgroundColor: tint(dir, 0.14) }]}>
            <Text style={[st.ratingText, { color: dir }]}>{coin.rating}</Text>
          </View>
        </View>
      </View>

      {locked && (
        <View style={st.lock}>
          <IconLock size={s.w(19)} color={C.dim} />
          <Text style={st.lockText}>Unlock with Pro</Text>
        </View>
      )}
    </Card>
  );
});

export default function Signals({
  onOpenCoin, onPaywall,
}: {
  onOpenCoin: (sym: string, coins: Coin[], polls: Polls) => void;
  onPaywall: () => void;
}) {
  const { tf, setTf, isPro, watchlist, toggleWatch } = useStore();
  const s = useScale();
  const st = useStyles();
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

  const coins = data?.coins ?? [];
  const updated = relativeTime(data?.updatedAt ?? '');

  return (
    <Screen onRefresh={reload} refreshing={loading}>
      <View style={st.head}>
        <View>
          <Text style={st.brand} accessibilityRole="header">VANE</Text>
          <Text style={st.date}>
            {updated ? `Updated ${updated}` : 'Live signals'}
          </Text>
        </View>
        <View style={st.tierPill}>
          <Text style={st.tierText}>{isPro ? 'PRO' : 'FREE'}</Text>
        </View>
      </View>

      {/* Tappable again: MONETIZATION is on, so Navigation registers the
          Paywall route and this no longer dead-ends. The label states what
          the free tier actually is — the old one advertised "1 of 1 free
          signals used", a quota that never existed. */}
      {!isPro && (
        <Pressable
          onPress={onPaywall}
          accessibilityRole="button"
          accessibilityLabel="Free plan, BTC only. See Pro plans.">
          <View style={st.quota}>
            {/* Was "1 of 1 free signals used" / "Resets in 9h 12m" — both
                literals, with no counter and no timer behind them. The free
                tier is actually "BTC only, always", so say that. */}
            <Text style={st.quotaTitle}>BTC free · unlock all 30 coins</Text>
            <Text style={st.quotaSub}>
              Signals refresh through the day · not financial advice
            </Text>
          </View>
        </Pressable>
      )}

      {error && data ? (
        <View style={st.staleBanner} accessibilityLiveRegion="polite">
          <Text style={st.staleText}>
            Offline — showing the last signals received{updated ? ` (${updated})` : ''}.
            Prices may have moved.
          </Text>
        </View>
      ) : null}

      <Segmented options={HORIZONS} value={tf} onChange={setTf} label="Forecast horizon" />

      {coins.map((c) => (
        <CoinRow
          key={c.sym}
          coin={c}
          tf={tf}
          locked={isCoinLocked(c.locked, isPro)}
          watched={watchlist.includes(c.sym)}
          onToggleWatch={() => toggleWatch(c.sym)}
          onPress={() =>
            isCoinLocked(c.locked, isPro) ? onPaywall() : onOpenCoin(c.sym, coins, polls)
          }
        />
      ))}

      <Disclaimer />
    </Screen>
  );
}

function useStyles() {
  const { w, h, f, width } = useScale();
  return useMemo(() => StyleSheet.create({
  head: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'flex-start', marginTop: h(6), marginBottom: h(16),
  },
  brand: { color: C.accent, fontSize: f(15), fontWeight: '700', letterSpacing: 4 },
  date: { color: C.faint, fontSize: f(12), marginTop: h(4) },
  tierPill: {
    borderWidth: 1, borderColor: C.cardBorder, borderRadius: w(20),
    paddingHorizontal: w(10), paddingVertical: h(4),
  },
  tierText: { color: C.dim, fontSize: f(10), fontWeight: '700', letterSpacing: 1 },

  quota: {
    backgroundColor: tint(C.accent, 0.07), borderRadius: w(14),
    borderWidth: 1, borderColor: tint(C.accent, 0.18),
    padding: w(14), marginBottom: h(14),
  },
  quotaTitle: { color: C.text, fontSize: f(14), fontWeight: '600' },
  quotaSub: { color: C.dim, fontSize: f(12), marginTop: h(3) },

  // No CSS filter in RN, so locked rows dim. The real gate is server-side:
  // locked detail should never reach the device at all.
  dimmed: { opacity: 0.12 },

  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  symWrap: { flexDirection: 'row', alignItems: 'center', gap: w(10), flex: 1 },
  nameWrap: { flex: 1 },
  rowRight: { flexDirection: 'row', alignItems: 'center', gap: w(8) },
  symBadge: { borderRadius: w(9), paddingHorizontal: w(8), paddingVertical: h(5) },
  symText: { fontSize: f(12), fontWeight: '700' },
  coinName: { color: C.text, fontSize: f(14), fontWeight: '600' },
  coinPrice: { color: C.dim, fontSize: f(12), marginTop: h(2) },

  cardBottom: {
    flexDirection: 'row', alignItems: 'flex-end',
    justifyContent: 'space-between', marginTop: h(13),
  },
  metricLabel: { color: C.faint, fontSize: f(9), letterSpacing: 0.8, marginBottom: h(3) },
  metricValue: { color: C.text, fontSize: f(13), fontWeight: '600' },
  rating: { borderRadius: w(7), paddingHorizontal: w(9), paddingVertical: h(5) },
  ratingText: { fontSize: f(10), fontWeight: '700', letterSpacing: 0.5 },

  lock: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center', gap: h(4),
  },
  lockText: { color: C.dim, fontSize: f(12), fontWeight: '600' },

  staleBanner: {
    backgroundColor: tint(C.down, 0.1), borderColor: tint(C.down, 0.28),
    borderWidth: 1, borderRadius: w(12),
    paddingVertical: h(10), paddingHorizontal: w(12), marginBottom: h(12),
  },
  staleText: { color: '#FF9EA1', fontSize: f(12), lineHeight: f(17) },
}), [width, w, h, f]);
}
