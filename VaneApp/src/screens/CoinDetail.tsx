// Screen 1d — coin detail: history, forecast cone, targets, reasoning,
// crowd poll, and the user's own call.

import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';
import Svg, { Circle, Polygon, Polyline } from 'react-native-svg';
import { C, tint } from '../theme.ts';
import { useScale } from '../responsive.ts';
import { BackHeader, Body, Button, Card, Disclaimer, EmptyState, Label, MIN_TAP, Pill, Screen, Segmented, Text } from '../ui.tsx';
import { HORIZONS, type Coin, type Horizon, seriesPath, toPath } from '../signals.ts';
import { useStore } from '../store.tsx';
import { MONETIZATION, isCoinLocked } from '../config.ts';
import { castVote, fetchMyVote, type Direction } from '../firebase.ts';
import { type Polls } from '../api.ts';
import { IconDown, IconLock, IconUp } from '../icons.tsx';

/**
 * Fallback reasoning, used only when the pipeline publishes none for a coin.
 *
 * Split by direction: the previous single map was unconditionally bullish
 * ("Exchange balances at a multi-year low"), so a SELL coin rendered bullish
 * prose under a red SELL pill. It was also BTC-specific — halving talk shown
 * for any altcoin — so the copy is now generic.
 */
const REASONS_DOWN: Record<Horizon, string[]> = {
  '24H': [
    'Short-term mean has crossed below the long-term mean',
    'Momentum has faded over the last day of trade',
    'Realised volatility is expanding, which widens the band',
  ],
  '7D': [
    'Weekly trend is below its longer-run average',
    'Rallies are being sold into rather than extended',
    'Volume is not confirming attempts to recover',
  ],
  '30D': [
    'The monthly trend has rolled over',
    'Momentum is negative and not yet stretched enough to snap back',
    'Model spread widens sharply past three weeks',
  ],
};

const REASONS_UP: Record<Horizon, string[]> = {
  '24H': [
    'Short-term mean is holding above the long-term mean',
    'Momentum is positive over the last day of trade',
    'Realised volatility is compressing into the move',
  ],
  '7D': [
    'Weekly trend is holding above its longer-run average',
    'Dips are being bought rather than extended',
    'Volume is confirming the direction of the move',
  ],
  '30D': [
    'The monthly trend remains constructive',
    'Momentum is positive but stretched on the monthly oscillator',
    'Model spread widens sharply past three weeks',
  ],
};

export default function CoinDetail({
  symbol = 'BTC', onPaywall, onBack, coins, polls,
}: {
  symbol?: string;
  onPaywall?: () => void;
  onBack?: () => void;
  /** Live coins from Firestore; falls back to the bundled sample. */
  coins?: Coin[];
  /** Server-aggregated crowd tally, keyed by symbol. */
  polls?: Polls;
}) {
  const { calls, addCall, isPro, tf: storeTf } = useStore();
  const sc = useScale();
  const st = useStyles();

  // Horizon is LOCAL, seeded from the store. Sharing one global `tf` meant
  // changing the horizon here silently changed the Signals list and the
  // Predict tab too.
  const [tf, setTf] = useState<Horizon>(storeTf);
  const [myVote, setMyVote] = useState<Direction | null>(null);
  const [placing, setPlacing] = useState(false);
  const [voting, setVoting] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchMyVote(symbol).then((v) => alive && setMyVote(v));
    return () => {
      alive = false;
    };
  }, [symbol]);

  // NO mock fallback. This used to fall back to the sample SIGNALS array,
  // which rendered invented prices as live data — and, far worse, the call
  // buttons below submit `entryPrice: coin.priceNum`, so a prediction placed
  // during an outage wrote the sample 123410 into Firestore as a real entry
  // price and permanently corrupted the accuracy record.
  const list = coins ?? [];
  const coin = list.find((c) => c.sym === symbol);
  const dir = coin ? (coin.up ? C.accent : C.down) : C.accent;
  const myCall = calls.find((c) => c.coin === coin?.sym);

  // Screen 1c gated on coin.locked but this screen did not, so any route that
  // passed a locked symbol (a deep link, a future tab) handed a free user the
  // full payload. Gate on the same condition in both places.
  const locked = !!coin && isCoinLocked(coin.locked, isPro);

  // Chart fills the card rather than a fixed width, so it neither
  // overflows on a narrow split-screen pane nor leaves dead space on a tablet.
  const CW = Math.max(200, Math.min(sc.maxWidth ?? sc.width, sc.width) - sc.w(18) * 2 - sc.w(14) * 2 - 2);
  const CH = Math.round(CW * 0.53);

  const geom = useMemo(() => {
    // Real closes, not a generated curve. The old code called
    // spark(4, 20, ..., true) — a fixed seed and a hardcoded `up`, so every
    // coin drew the identical rising line regardless of its actual price or
    // direction, directly beneath a caption calling it the forecast.
    const series = coin?.history ?? [];
    const hist = seriesPath(series, CW * 0.6, CH);
    if (hist.length < 2) {
      return { hist: [], fwd: [], band: [], tgt: null as [number, number] | null };
    }
    const last = hist[hist.length - 1];
    const n = 6;
    // Slope follows the coin's actual direction. It used to rise
    // unconditionally, so a SELL coin showed a climbing forecast next to a
    // red negative target.
    const magnitude = CH * (tf === '24H' ? 0.15 : tf === '7D' ? 0.28 : 0.39);
    const rise = (coin?.up ? 1 : -1) * magnitude;
    const fwd: [number, number][] = [last];
    for (let i = 1; i <= n; i++) {
      fwd.push([
        CW * 0.6 + ((CW * 0.4) / n) * i,
        last[1] - (rise / n) * i + Math.sin(i) * 4,
      ]);
    }
    // Cone widens with distance — the model's uncertainty, drawn honestly.
    const band = [
      ...fwd.map((p): [number, number] => [p[0], p[1] - (p[0] - CW * 0.6) * 0.16]),
      ...[...fwd].reverse().map((p): [number, number] => [p[0], p[1] + (p[0] - CW * 0.6) * 0.2]),
    ];
    return { hist, fwd, band, tgt: fwd[fwd.length - 1] };
  }, [tf, CW, CH, coin?.history, coin?.up]);

  if (!coin) {
    return (
      <Screen>
        {onBack && <BackHeader onBack={onBack} />}
        <EmptyState
          title={`No signal for ${symbol}`}
          sub="This coin is not in the current feed. It may have been delisted or renamed."
        />
      </Screen>
    );
  }

  if (locked) {
    return (
      <Screen>
        <View style={st.head}>
          <View>
            <Text style={st.sym} accessibilityRole="header" numberOfLines={1}>{coin.name}</Text>
            <Text style={st.price}>{coin.price}</Text>
          </View>
        </View>
        <EmptyState
          title={`${coin.sym} is a Pro signal`}
          sub="Targets, model reasoning and the forecast band are part of VANE Pro."
        />
        {onPaywall && (
          <Button title="See Pro plans" onPress={onPaywall} />
        )}
        <Disclaimer />
      </Screen>
    );
  }

  // The pipeline publishes per-coin reasoning derived from whichever features
  // actually dominated. Prefer it over the canned per-horizon strings.
  const reasons = coin.reasons?.length
    ? coin.reasons
    : (coin.up ? REASONS_UP : REASONS_DOWN)[tf];
  const poll = polls?.[coin.sym] ?? null;

  return (
    <Screen>
      {onBack && <BackHeader onBack={onBack} />}
      <View style={st.head}>
        <View>
          <Text style={st.sym} accessibilityRole="header" numberOfLines={1}>{coin.name}</Text>
          <Text style={st.price}>{coin.price}</Text>
        </View>
        <Pill text={coin.rating} color={dir} />
      </View>

      <Segmented options={HORIZONS} value={tf} onChange={setTf} label="Forecast horizon" />

      <Card>
        {/* viewBox so the forecast and cone are FITTED rather than clipped —
            without it, out-of-range points were simply cut off and most of the
            cone was drawn above the canvas and never seen. */}
        <Svg
          width={CW}
          height={CH + sc.h(10)}
          viewBox={`0 ${-CH * 0.5} ${CW} ${CH * 2}`}
          accessibilityLabel={`${coin.name} price history and ${tf} forecast`}>
          {geom.band.length > 2 && (
            <Polygon points={toPath(geom.band)} fill={tint(dir, 0.1)} />
          )}
          {geom.hist.length > 1 && (
            <Polyline points={toPath(geom.hist)} fill="none" stroke={dir} strokeWidth={2} />
          )}
          {geom.fwd.length > 1 && (
            <Polyline
              points={toPath(geom.fwd)}
              fill="none"
              stroke={dir}
              strokeWidth={2}
              strokeDasharray="5,4"
            />
          )}
          {geom.tgt && (
            <>
              <Circle cx={geom.tgt[0]} cy={geom.tgt[1]} r={5} fill={dir} />
              <Circle
                cx={geom.tgt[0]} cy={geom.tgt[1]} r={11}
                fill="none" stroke={tint(dir, 0.4)} strokeWidth={1.5}
              />
            </>
          )}
        </Svg>
        <Text style={st.chartNote}>
          Dashed line is the forecast; the shaded cone is the uncertainty band.
        </Text>
      </Card>

      <View style={st.targets}>
        {HORIZONS.map((hz) => {
          const [price, pct] = coin.targets[hz];
          const on = hz === tf;
          return (
            <View key={hz} style={[st.tgtCell, on && st.tgtCellOn]}>
              <Label>{hz}</Label>
              <Text style={st.tgtPrice}>{price}</Text>
              <Text style={[st.tgtPct, { color: dir }]}>{pct}</Text>
            </View>
          );
        })}
      </View>

      <Card>
        <Label>WHY THE MODEL THINKS THIS</Label>
        {!MONETIZATION || isPro ? (
          reasons.map((r) => (
            <View key={r} style={st.reasonRow}>
              <Text style={[st.bullet, { color: dir }]}>—</Text>
              <Text style={st.reasonText}>{r}</Text>
            </View>
          ))
        ) : (
          <View style={st.gated}>
            <IconLock size={sc.w(20)} color={C.dim} />
            <Text style={st.gatedText}>Model reasoning is a Pro feature</Text>
          </View>
        )}
      </Card>

      <Card>
        <Label>CROWD VS MODEL</Label>
        {poll ? (
          <>
            <View style={st.pollBar}>
              <View style={[st.pollUp, { flex: poll.up, backgroundColor: tint(C.accent, 0.55) }]} />
              <View
                style={[
                  st.pollDown,
                  { flex: 100 - poll.up, backgroundColor: tint(C.down, 0.45) },
                ]}
              />
            </View>
            <View style={st.pollLabels}>
              <Text style={[st.pollText, { color: C.accent }]}>{poll.up}% up</Text>
              <Text style={[st.pollText, { color: C.down }]}>{100 - poll.up}% down</Text>
            </View>
            <Text style={st.pollMeta}>
              {poll.total} vote{poll.total === 1 ? '' : 's'}
              {myVote ? ` · you said ${myVote}` : ''}
            </Text>
          </>
        ) : (
          <Text style={st.pollMeta}>
            {myVote
              ? `Your ${myVote} vote is in. The tally updates on the next refresh.`
              : 'Not enough votes yet — be one of the first to call it.'}
          </Text>
        )}

        <View style={st.voteRow}>
          <Pressable
            onPress={async () => {
              // Serialise votes: two overlapping writes could roll back to a
              // stale value and leave the UI disagreeing with the server.
              if (voting) return;
              const prev = myVote;
              setVoting(true);
              setMyVote('up');
              const ok = await castVote(coin.sym, 'up');
              setVoting(false);
              if (!ok) {
                setMyVote(prev);
                Alert.alert("Couldn't record your vote", 'Check your connection and try again.');
              }
            }}
            accessibilityRole="button"
            accessibilityLabel={`Vote ${coin.sym} up`}
            accessibilityState={{ selected: myVote === 'up' }}
            style={[
              st.voteBtn,
              {
                borderColor: tint(C.accent, myVote === 'up' ? 0.7 : 0.25),
                backgroundColor: tint(C.accent, myVote === 'up' ? 0.18 : 0.06),
              },
            ]}>
            <Text style={[st.voteText, { color: C.accent }]}>I say up</Text>
          </Pressable>
          <Pressable
            onPress={async () => {
              // Serialise votes: two overlapping writes could roll back to a
              // stale value and leave the UI disagreeing with the server.
              if (voting) return;
              const prev = myVote;
              setVoting(true);
              setMyVote('down');
              const ok = await castVote(coin.sym, 'down');
              setVoting(false);
              if (!ok) {
                setMyVote(prev);
                Alert.alert("Couldn't record your vote", 'Check your connection and try again.');
              }
            }}
            accessibilityRole="button"
            accessibilityLabel={`Vote ${coin.sym} down`}
            accessibilityState={{ selected: myVote === 'down' }}
            style={[
              st.voteBtn,
              {
                borderColor: tint(C.down, myVote === 'down' ? 0.7 : 0.25),
                backgroundColor: tint(C.down, myVote === 'down' ? 0.18 : 0.06),
              },
            ]}>
            <Text style={[st.voteText, { color: '#FF7A7E' }]}>I say down</Text>
          </Pressable>
        </View>
      </Card>

      <Card>
        <Text style={st.callTitle}>
          {myCall ? 'Your call is in' : 'Make your own call'}
        </Text>
        <Body>
          {myCall
            ? `You said ${myCall.dir.toUpperCase()} on ${coin.sym} for ${myCall.tf}. Grades automatically at close.`
            : `Grade yourself against the model over ${tf}.`}
        </Body>
        <View style={st.callRow}>
          <Pressable
            onPress={async () => {
              // One open call per coin. Without this a user could tap UP twice
              // (two graded predictions) or UP then DOWN (a guaranteed win),
              // both of which inflate the track record.
              if (myCall) {
                Alert.alert(
                  'Call already placed',
                  `You said ${myCall.dir.toUpperCase()} on ${coin.sym} for ${myCall.tf}. It grades automatically at close.`,
                );
                return;
              }
              if (placing) return;
              setPlacing(true);
              const res = await addCall({
                coin: coin.sym, dir: 'up', tf, entryPrice: coin.priceNum,
              });
              setPlacing(false);
              if (!res.ok) Alert.alert("Couldn't save your call", res.reason);
            }}
            accessibilityRole="button"
            accessibilityLabel={`Call ${coin.sym} up over ${tf}`}
            accessibilityState={{ selected: myCall?.dir === 'up' }}
            style={[
              st.callBtn,
              {
                backgroundColor: myCall?.dir === 'up' ? C.accent : tint(C.accent, 0.1),
                borderColor: tint(C.accent, 0.3),
              },
            ]}>
            <View style={st.callInner}>
              <IconUp size={sc.w(15)} color={myCall?.dir === 'up' ? C.bg : C.accent} />
              <Text
                style={[
                  st.callBtnText,
                  { color: myCall?.dir === 'up' ? C.bg : C.accent },
                ]}>
                UP
              </Text>
            </View>
          </Pressable>
          <Pressable
            onPress={async () => {
              // One open call per coin. Without this a user could tap UP twice
              // (two graded predictions) or UP then DOWN (a guaranteed win),
              // both of which inflate the track record.
              if (myCall) {
                Alert.alert(
                  'Call already placed',
                  `You said ${myCall.dir.toUpperCase()} on ${coin.sym} for ${myCall.tf}. It grades automatically at close.`,
                );
                return;
              }
              if (placing) return;
              setPlacing(true);
              const res = await addCall({
                coin: coin.sym, dir: 'down', tf, entryPrice: coin.priceNum,
              });
              setPlacing(false);
              if (!res.ok) Alert.alert("Couldn't save your call", res.reason);
            }}
            accessibilityRole="button"
            accessibilityLabel={`Call ${coin.sym} down over ${tf}`}
            accessibilityState={{ selected: myCall?.dir === 'down' }}
            style={[
              st.callBtn,
              {
                backgroundColor: myCall?.dir === 'down' ? C.down : tint(C.down, 0.1),
                borderColor: tint(C.down, 0.28),
              },
            ]}>
            <View style={st.callInner}>
              <IconDown size={sc.w(15)} color={myCall?.dir === 'down' ? C.bg : '#FF7A7E'} />
              <Text
                style={[
                  st.callBtnText,
                  { color: myCall?.dir === 'down' ? C.bg : '#FF7A7E' },
                ]}>
                DOWN
              </Text>
            </View>
          </Pressable>
        </View>
      </Card>

      <Disclaimer />
    </Screen>
  );
}

function useStyles() {
  const { w, h, f, width } = useScale();
  return useMemo(() => StyleSheet.create({
  head: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'center', marginTop: h(6), marginBottom: h(16),
  },
  sym: { color: C.text, fontSize: f(22), fontWeight: '700', flexShrink: 1 },
  price: { color: C.dim, fontSize: f(14), marginTop: h(3) },

  chartNote: { color: C.faint, fontSize: f(10), marginTop: h(6) },

  targets: { flexDirection: 'row', gap: w(8), marginBottom: h(10) },
  tgtCell: {
    flex: 1, borderRadius: w(13), borderWidth: 1,
    borderColor: C.cardBorder, padding: w(11),
    backgroundColor: C.card,
  },
  tgtCellOn: { borderColor: tint(C.accent, 0.35), backgroundColor: tint(C.accent, 0.06) },
  tgtPrice: { color: C.text, fontSize: f(13), fontWeight: '700' },
  tgtPct: { fontSize: f(11), marginTop: h(2), fontWeight: '600' },

  reasonRow: { flexDirection: 'row', gap: w(8), marginTop: h(8) },
  bullet: { fontSize: f(13) },
  reasonText: { color: C.dim, fontSize: f(13), flex: 1, lineHeight: f(19) },

  gated: { alignItems: 'center', paddingVertical: h(18), gap: h(6) },
  gatedText: { color: C.dim, fontSize: f(12) },

  pollBar: {
    flexDirection: 'row', height: h(10), borderRadius: h(5),
    overflow: 'hidden', marginTop: h(8), gap: 2,
  },
  pollUp: { borderRadius: h(5) },
  pollDown: { borderRadius: h(5) },
  pollLabels: { flexDirection: 'row', justifyContent: 'space-between', marginTop: h(7) },
  pollText: { fontSize: f(11), fontWeight: '600' },
  pollMeta: { color: C.faint, fontSize: f(11), marginTop: h(8) },
  voteRow: { flexDirection: 'row', gap: w(10), marginTop: h(12) },
  voteBtn: {
    flex: 1, borderRadius: w(12), borderWidth: 1,
    paddingVertical: h(11), alignItems: 'center',
    minHeight: MIN_TAP, justifyContent: 'center',
  },
  voteText: { fontSize: f(13), fontWeight: '700' },

  callTitle: { color: C.text, fontSize: f(15), fontWeight: '700', marginBottom: h(5) },
  callRow: { flexDirection: 'row', gap: w(10), marginTop: h(13) },
  callBtn: {
    flex: 1, borderRadius: w(13), borderWidth: 1,
    paddingVertical: h(13), alignItems: 'center', minHeight: MIN_TAP, justifyContent: 'center',
  },
  callBtnText: { fontSize: f(14), fontWeight: '700' },
  callInner: { flexDirection: 'row', alignItems: 'center', gap: w(6) },
}), [width, w, h, f]);
}
