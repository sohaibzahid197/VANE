// Screen 1e — my track record. Every figure is derived from history, so it
// cannot show an accuracy the rows don't support.

import React, { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { C, tint } from '../theme.ts';
import { useScale } from '../responsive.ts';
import { Card, Disclaimer, EmptyState, ErrorState, Label, Loading, Screen, Segmented, Text } from '../ui.tsx';
import { accuracyOf, useStore } from '../store.tsx';
import { IconCheck, IconCross, IconEmpty, IconPending } from '../icons.tsx';

const FILTERS = ['All', 'Wins', 'Losses'] as const;
type Filter = (typeof FILTERS)[number];

export default function Record() {
  const {
    history, calls, voided, resolvedTimeline,
    loadingPredictions, predictionsError, refreshPredictions,
  } = useStore();
  const s = useScale();
  const st = useStyles();
  const [filter, setFilter] = useState<Filter>('All');
  const stats = accuracyOf(history, resolvedTimeline);

  const rows = history.filter(
    (r) => filter === 'All' || (filter === 'Wins' ? r.win : !r.win),
  );

  if (loadingPredictions && history.length === 0 && calls.length === 0) {
    return (
      <Screen>
        <Text style={st.title} accessibilityRole="header">My record</Text>
        <Loading label="Loading your calls" />
      </Screen>
    );
  }

  if (predictionsError && history.length === 0 && calls.length === 0) {
    return (
      <Screen onRefresh={refreshPredictions} refreshing={loadingPredictions}>
        <Text style={st.title} accessibilityRole="header">My record</Text>
        <ErrorState message={predictionsError} onRetry={refreshPredictions} />
      </Screen>
    );
  }

  if (history.length === 0) {
    return (
      <Screen>
        <Text style={st.title} accessibilityRole="header">My record</Text>
        {calls.length > 0 ? (
          <>
            <Card style={st.pendingCard}>
              <Label>WAITING TO RESOLVE</Label>
              <Text style={st.pendingBig}>
                {calls.length} open call{calls.length === 1 ? '' : 's'}
              </Text>
              <Text style={st.pendingSub}>
                Each grades automatically once its horizon closes.
              </Text>
            </Card>
            {calls.map((c) => (
              <View
                key={`${c.coin}-${c.tf}`}
                accessible
                accessibilityLabel={`${c.coin} ${c.dir} ${c.tf}, pending`}>
                <Card style={st.row}>
                  <View style={[st.mark, { backgroundColor: tint(C.accent, 0.08) }]}>
                    <IconPending size={s.w(15)} color={C.accent} />
                  </View>
                  <View style={st.rowMid}>
                    <Text style={st.rowCoin}>
                      {c.coin} · {c.dir.toUpperCase()} {c.tf}
                    </Text>
                    <Text style={st.rowWhen}>pending</Text>
                  </View>
                </Card>
              </View>
            ))}
            <Disclaimer />
          </>
        ) : (
          <EmptyState
            title="No resolved calls yet"
            sub="Place a call on any coin and it will appear here once it grades at close."
          />
        )}
      </Screen>
    );
  }

  return (
    <Screen onRefresh={refreshPredictions} refreshing={loadingPredictions}>
      <Text style={st.title} accessibilityRole="header">My record</Text>

      <View style={st.stats}>
        <View style={st.stat}>
          <Label>ACCURACY</Label>
          <Text style={st.statBig}>{stats.pct}%</Text>
          <Text style={st.statSub}>
            {stats.total} graded{voided.length ? ` · ${voided.length} not graded` : ''}
          </Text>
        </View>
        <View style={st.stat}>
          <Label>WINS</Label>
          <Text style={[st.statBig, { color: C.accent }]}>{stats.wins}</Text>
          <Text style={st.statSub}>of {stats.total}</Text>
        </View>
        <View style={st.stat}>
          <Label>STREAK</Label>
          <Text style={st.statBig}>{stats.streak > 0 ? `+${stats.streak}` : '—'}</Text>
          <Text style={st.statSub}>{stats.streak > 0 ? 'current' : 'no streak'}</Text>
        </View>
      </View>

      {calls.length > 0 && (
        <Card style={st.pendingCard}>
          <Label>WAITING TO RESOLVE</Label>
          <Text style={st.pendingBig}>
            {calls.length} open call{calls.length === 1 ? '' : 's'}
          </Text>
          <Text style={st.pendingSub} numberOfLines={2}>
            {calls.slice(0, 6).map((c) => `${c.coin} ${c.dir.toUpperCase()} ${c.tf}`).join(' · ')}
            {calls.length > 6 ? ` · +${calls.length - 6} more` : ''}
          </Text>
        </Card>
      )}

      <Segmented options={FILTERS} value={filter} onChange={setFilter} label="Filter results" />

      {rows.length === 0 ? (
        <EmptyState
          title={`No ${filter.toLowerCase()} yet`}
          sub="Try a different filter."
        />
      ) : (
        rows.map((r, i) => (
          <Card
            key={`${r.coin}-${r.when}-${i}`}
            style={st.row}
            label={`${r.coin} ${r.call}, ${r.win ? 'won' : 'lost'}, ${r.delta}, ${r.when}`}>
            <View
              style={[
                st.mark,
                { backgroundColor: tint(r.win ? C.accent : C.down, 0.12) },
              ]}>
              {r.win
                ? <IconCheck size={s.w(16)} color={C.accent} />
                : <IconCross size={s.w(16)} color={C.down} />}
            </View>
            <View style={st.rowMid}>
              <Text style={st.rowCoin}>
                {r.coin} · {r.call}
              </Text>
              <Text style={st.rowWhen}>{r.when} · resolved</Text>
            </View>
            <Text style={[st.rowDelta, { color: r.win ? C.accent : C.down }]}>
              {r.delta}
            </Text>
          </Card>
        ))
      )}

      {voided.length > 0 && (
        <>
          <Label>NOT GRADED</Label>
          {voided.map((v, i) => (
            <View
              key={`${v.coin}-${v.when}-${i}`}
              accessible
              accessibilityLabel={`${v.coin} ${v.call}, not graded, ${v.reason}`}>
              <Card style={st.row}>
                <View style={[st.mark, { backgroundColor: 'rgba(255,255,255,.06)' }]}>
                  <IconEmpty size={s.w(15)} color={C.faint} />
                </View>
                <View style={st.rowMid}>
                  <Text style={st.rowCoin}>
                    {v.coin} · {v.call}
                  </Text>
                  <Text style={st.rowWhen}>
                    {v.when} · {v.reason}
                  </Text>
                </View>
              </Card>
            </View>
          ))}
        </>
      )}

      <Disclaimer />
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
  stats: { flexDirection: 'row', gap: w(8), marginBottom: h(16) },
  stat: {
    flex: 1, backgroundColor: C.card, borderRadius: w(14),
    borderWidth: 1, borderColor: C.cardBorder, padding: w(12),
  },
  statBig: { color: C.text, fontSize: f(21), fontWeight: '700' },
  statSub: { color: C.faint, fontSize: f(10), marginTop: h(2) },

  row: { flexDirection: 'row', alignItems: 'center', gap: w(12) },
  mark: {
    width: w(32), height: w(32), borderRadius: w(10),
    alignItems: 'center', justifyContent: 'center',
  },
  rowMid: { flex: 1 },
  rowCoin: { color: C.text, fontSize: f(14), fontWeight: '600', flexShrink: 1 },
  rowWhen: { color: C.faint, fontSize: f(11), marginTop: h(2) },
  rowDelta: { fontSize: f(14), fontWeight: '700' },
  pendingCard: { backgroundColor: tint(C.accent, 0.06), borderColor: tint(C.accent, 0.18) },
  pendingBig: { color: C.text, fontSize: f(17), fontWeight: '700' },
  pendingSub: { color: C.dim, fontSize: f(12), marginTop: h(3) },
}), [w, h, f]);
}
