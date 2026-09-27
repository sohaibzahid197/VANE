// Markets — the full coin list.
//
// This is the screen the app did not have. Signals shows a curated 31 with a
// model opinion attached; this shows the market: 250 coins ranked by cap, with
// price, 24h change, cap and volume, searchable and sortable.
//
// PERFORMANCE IS THE WHOLE DESIGN HERE. A 250-row list of composite rows is
// where a React Native app starts dropping frames, so:
//   - FlatList with getItemLayout, so it never measures a row
//   - a fixed row height, which is what makes getItemLayout possible
//   - rows memoised, so typing in the search box does not re-render 250 of them
//   - windowSize trimmed, because the default keeps ~21 screens of rows mounted
//
// Free users receive only the free coins from the server — there is nothing to
// "lock" in the client, because an unentitled device never gets the paid
// document at all. The upsell row at the end says what is missing without
// pretending to hold it.

import React, { useCallback, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { C, tint } from '../theme.ts';
import { useScale } from '../responsive.ts';
import {
  Card,
  Disclaimer,
  EmptyState,
  ErrorState,
  Loading,
  Screen,
  Segmented,
  Text,
} from '../ui.tsx';
import { compact, type Market } from '../markets.ts';
import { useMarkets } from '../useMarkets.ts';
import { useStore } from '../store.tsx';
import { isStale, relativeTime } from '../useSignals.ts';

type SortKey = 'Rank' | 'Change' | 'Volume';

const ROW_H = 64;

const MarketRow = React.memo(function MarketRow({
  coin,
  onPress,
}: {
  coin: Market;
  onPress: () => void;
}) {
  const st = useStyles();
  const dir = coin.up ? C.accent : C.down;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${coin.name}, ${coin.priceLabel}, ${coin.changeLabel} in 24 hours`}
      style={st.row}>
      <Text style={st.rank}>{coin.rank ?? '—'}</Text>
      <View style={[st.badge, { backgroundColor: tint(dir, 0.12) }]}>
        <Text style={[st.badgeText, { color: dir }]} numberOfLines={1}>
          {coin.sym}
        </Text>
      </View>
      <View style={st.nameCol}>
        <Text style={st.name} numberOfLines={1}>
          {coin.name}
        </Text>
        <Text style={st.sub} numberOfLines={1}>
          Vol {compact(coin.volume24h)}
        </Text>
      </View>
      <View style={st.priceCol}>
        <Text style={st.price} numberOfLines={1}>
          {coin.priceLabel}
        </Text>
        <Text style={[st.change, { color: dir }]} numberOfLines={1}>
          {coin.changeLabel}
        </Text>
      </View>
      <View style={st.capCol}>
        <Text style={st.cap} numberOfLines={1}>
          {compact(coin.marketCap)}
        </Text>
      </View>
    </Pressable>
  );
});

export default function Markets({
  onOpenCoin,
  onPaywall,
}: {
  onOpenCoin: (market: Market) => void;
  onPaywall: () => void;
}) {
  const { isPro } = useStore();
  const { data, loading, error, stale, reload } = useMarkets(isPro);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('Rank');
  const st = useStyles();
  const s = useScale();

  const coins = data?.coins ?? [];

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    // Match symbol OR name, so both "btc" and "bitcoin" find Bitcoin.
    const filtered = q
      ? coins.filter(
          (c) => c.sym.toLowerCase().includes(q) || c.name.toLowerCase().includes(q),
        )
      : coins.slice();

    switch (sort) {
      case 'Change':
        // Nulls last regardless of direction — a coin with no 24h data is not
        // the biggest gainer, which is where an undefined sort would put it.
        return filtered.sort(
          (a, b) => (b.change24hPct ?? -Infinity) - (a.change24hPct ?? -Infinity),
        );
      case 'Volume':
        return filtered.sort((a, b) => (b.volume24h ?? -1) - (a.volume24h ?? -1));
      default:
        return filtered.sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));
    }
  }, [coins, query, sort]);

  const renderItem = useCallback(
    ({ item }: { item: Market }) => (
      <MarketRow coin={item} onPress={() => onOpenCoin(item)} />
    ),
    [onOpenCoin],
  );

  const getItemLayout = useCallback(
    (_: unknown, index: number) => ({
      length: s.h(ROW_H),
      offset: s.h(ROW_H) * index,
      index,
    }),
    [s],
  );

  if (loading && coins.length === 0) return <Loading label="Loading markets" />;
  if (error && coins.length === 0) return <ErrorState message={error} onRetry={reload} />;

  // The list owns the scrolling, so Screen must not. A FlatList inside a
  // ScrollView nests two virtualizers: React Native warns about it, the inner
  // list loses its windowing and renders all 250 rows, and momentum scrolling
  // fights between the two.
  const header = (
    <View>
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="Search coins"
        placeholderTextColor={C.faint}
        autoCorrect={false}
        autoCapitalize="none"
        accessibilityLabel="Search coins"
        style={st.search}
      />

      <Segmented
        options={['Rank', 'Change', 'Volume'] as SortKey[]}
        value={sort}
        onChange={setSort}
      />

      {data?.global && (
        <Card>
          <View style={st.globalRow}>
            <Stat label="Market cap" value={compact(data.global.totalMarketCap)} />
            <Stat label="24h volume" value={compact(data.global.totalVolume24h)} />
            <Stat
              label="BTC dominance"
              value={
                data.global.btcDominance === null
                  ? '—'
                  : `${data.global.btcDominance.toFixed(1)}%`
              }
            />
          </View>
        </Card>
      )}

      {stale && data?.updatedAt && isStale(data.updatedAt) ? (
        <Text style={st.staleNote}>Showing saved data from {relativeTime(data.updatedAt)}</Text>
      ) : null}
    </View>
  );

  const footer = (
    <View>
      {!isPro ? (
        <Pressable onPress={onPaywall} accessibilityRole="button" style={st.upsell}>
          <Text style={st.upsellTitle}>{coins.length} of 250 coins shown</Text>
          <Text style={st.upsellSub}>
            Unlock the full market, every chart range and the model's reasoning.
          </Text>
        </Pressable>
      ) : null}

      {/*
        Attribution is a licence term, not a courtesy. CoinGecko's API Terms
        require "Powered by CoinGecko" displayed prominently in a legible font
        no smaller than font size 10, on EVERY tier including paid. The 10pt
        floor in the stylesheet is that requirement — do not shrink it to fit
        a layout.
      */}
      {data?.source ? <Text style={st.attribution}>Powered by CoinGecko</Text> : null}

      <Disclaimer />
    </View>
  );

  return (
    <Screen scroll={false}>
      {visible.length === 0 ? (
        <>
          {header}
          <EmptyState
            title="No coins match"
            sub={query ? `Nothing found for "${query}".` : 'No market data yet.'}
          />
          {footer}
        </>
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(c) => c.sym}
          renderItem={renderItem}
          getItemLayout={getItemLayout}
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          windowSize={7}
          removeClippedSubviews
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={header}
          ListFooterComponent={footer}
          refreshing={loading}
          onRefresh={reload}
        />
      )}
    </Screen>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  const st = useStyles();
  return (
    <View style={st.stat}>
      <Text style={st.statLabel}>{label}</Text>
      <Text style={st.statValue}>{value}</Text>
    </View>
  );
}

function useStyles() {
  const { w, h, f } = useScale();
  return useMemo(
    () =>
      StyleSheet.create({
        search: {
          backgroundColor: C.card,
          borderColor: C.cardBorder,
          borderWidth: 1,
          borderRadius: w(10),
          paddingHorizontal: w(12),
          // 44 is the minimum comfortable touch target for a text field.
          height: h(44),
          color: C.text,
          fontSize: f(14),
          marginBottom: h(10),
        },
        row: {
          flexDirection: 'row',
          alignItems: 'center',
          height: h(ROW_H),
          paddingHorizontal: w(4),
          borderBottomColor: C.cardBorder,
          borderBottomWidth: StyleSheet.hairlineWidth,
        },
        rank: { width: w(26), color: C.faint, fontSize: f(11) },
        badge: {
          width: w(44),
          paddingVertical: h(4),
          borderRadius: w(6),
          alignItems: 'center',
        },
        badgeText: { fontSize: f(10), fontWeight: '700' },
        nameCol: { flex: 1, paddingHorizontal: w(8) },
        name: { color: C.text, fontSize: f(13), fontWeight: '600' },
        sub: { color: C.faint, fontSize: f(10), marginTop: h(2) },
        priceCol: { alignItems: 'flex-end', width: w(82) },
        price: { color: C.text, fontSize: f(13), fontWeight: '600' },
        change: { fontSize: f(11), marginTop: h(2) },
        capCol: { alignItems: 'flex-end', width: w(66), paddingLeft: w(4) },
        cap: { color: C.dim, fontSize: f(11) },
        globalRow: { flexDirection: 'row', justifyContent: 'space-between' },
        stat: { flex: 1 },
        statLabel: { color: C.faint, fontSize: f(10) },
        statValue: { color: C.text, fontSize: f(13), fontWeight: '600', marginTop: h(2) },
        staleNote: { color: C.faint, fontSize: f(10), marginBottom: h(6) },
        upsell: {
          marginTop: h(12),
          padding: w(14),
          borderRadius: w(12),
          borderWidth: 1,
          borderColor: tint(C.accent, 0.3),
          backgroundColor: tint(C.accent, 0.06),
        },
        upsellTitle: { color: C.accent, fontSize: f(13), fontWeight: '700' },
        upsellSub: { color: C.dim, fontSize: f(11), marginTop: h(4) },
        // 10 is a licence floor, not a design choice. See the note at the call site.
        attribution: {
          color: C.faint,
          fontSize: Math.max(10, f(10)),
          textAlign: 'center',
          marginTop: h(10),
        },
      }),
    [w, h, f],
  );
}
