// VANE's own track record.
//
// The app has always graded the USER's calls and never its own, so the one
// question a buyer actually has — does this work — was answered nowhere.
// Every competitor has the same hole and their reviews say so: "must pay $50
// monthly without proof it works". None of them publishes a verified rate.
//
// This shows ours, whatever it is. The honest number is unimpressive, and
// showing it is the point: a measured record can be trusted in a way an
// asserted one cannot, and it is the only claim here a buyer can check.

import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { fetchScorecard, type ScoreRow } from './api.ts';
import { useScale } from './responsive.ts';
import { C } from './theme.ts';
import { Card, Label, Text } from './ui.tsx';

/** Mirrors MIN_GRADED in vane-pipeline/src/scorecard.ts. Stated rather than
 *  vague: "enough calls to mean something" invites the reader to divide the
 *  counts shown beside it and recover the number we withheld. */
const MIN_SHOWN = 200;

type State =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; rows: ScoreRow[] };

export default function ModelRecord({ refreshKey = 0 }: { refreshKey?: number }) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const st = useStyles();

  useEffect(() => {
    let alive = true;
    setState({ kind: 'loading' });
    fetchScorecard()
      .then((rows) => {
        if (!alive) return;
        // null is "could not load"; [] is "nothing published yet". Collapsing
        // them meant the screen showed the same blank for a broken network
        // and for a working app with nothing graded.
        setState(rows === null ? { kind: 'error' } : { kind: 'ready', rows });
      })
      .catch(() => {
        if (alive) setState({ kind: 'error' });
      });
    return () => {
      alive = false;
    };
    // refreshKey changes when the user pulls to refresh, so both halves of the
    // Record screen reload together instead of disagreeing about freshness.
  }, [refreshKey]);

  // Always render the card, never nothing.
  //
  // Returning null left the Record tab completely blank on a fresh install —
  // the one checkable claim this product makes, invisible, with no way for a
  // reviewer or for us to tell "not graded yet" from "broken". Stating the
  // reason is not the same as inventing a number.
  const body = () => {
    if (state.kind === 'loading') return <Text style={st.note}>Loading…</Text>;
    if (state.kind === 'error') {
      return <Text style={st.note}>Couldn't load the record just now.</Text>;
    }
    if (state.rows.length === 0 || state.rows.every((r) => r.graded === 0)) {
      return (
        <Text style={st.note}>
          Grading in progress. Every call is recorded when it is published and
          scored at its horizon; rates appear once {MIN_SHOWN} calls have been
          graded.
        </Text>
      );
    }
    return null;
  };

  const inner = body();

  return (
    <Card style={st.card}>
      <Label>VANE'S OWN RECORD</Label>
      {inner}
      {state.kind === 'ready' && inner === null && (
        <>
          <View style={st.row}>
            {state.rows.map((r) => (
              <View
                key={r.horizon}
                style={st.cell}
                accessible
                accessibilityLabel={
                  r.graded > 0
                    ? `${r.horizon} calls: ${
                        r.hitRate === null
                          ? 'rate not published yet'
                          : `${Math.round(r.hitRate * 100)} percent correct`
                      }, ${r.correct} of ${r.graded} graded`
                    : `${r.horizon} calls: none graded yet`
                }>
                <Text style={st.hz}>{r.horizon}</Text>
                <Text style={st.rate} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
                  {r.hitRate === null ? '—' : `${Math.round(r.hitRate * 100)}%`}
                </Text>
                <Text style={st.count} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
                  {r.graded > 0 ? `${r.correct}/${r.graded}` : 'none yet'}
                </Text>
              </View>
            ))}
          </View>
          <Text style={st.note}>
            {/* Scope stated honestly. Only the DIRECTION is graded — the price
                targets the paywall sells are not scored here, and a reader
                would otherwise take 52% to mean 52% of targets were hit. */}
            Every published direction call, graded on the closing price at its
            horizon. Price targets are not included in this figure.
            {'\n\n'}
            {/* A hit rate near 50% on a two-way call is a coin flip, and a
                reader who does not know that reads 52% as skill. Crypto also
                drifts upward, so "always up" beats 50% over a long horizon —
                which makes the coin flip a floor, not a benchmark. */}
            A two-way call flips at 50%, so anything near that is no better
            than chance — and over longer horizons an always-up guess beats a
            coin. Rates appear after {MIN_SHOWN} graded calls.
          </Text>
        </>
      )}
    </Card>
  );
}

function useStyles() {
  const { w, h, f } = useScale();
  return React.useMemo(
    () =>
      StyleSheet.create({
        card: { marginBottom: h(14) },
        row: { flexDirection: 'row', marginTop: h(10), gap: w(8) },
        cell: { flex: 1, alignItems: 'center' },
        hz: { color: C.dim, fontSize: f(11), letterSpacing: 1 },
        rate: { color: C.text, fontSize: f(24), fontWeight: '700', marginTop: h(4) },
        count: { color: C.faint, fontSize: f(11), marginTop: h(2) },
        note: {
          color: C.faint, fontSize: f(11), lineHeight: f(16), marginTop: h(12),
        },
      }),
    [w, h, f],
  );
}
