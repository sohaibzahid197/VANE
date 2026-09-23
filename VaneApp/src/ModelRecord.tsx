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

export default function ModelRecord() {
  const [rows, setRows] = useState<ScoreRow[] | null>(null);
  const st = useStyles();

  useEffect(() => {
    let alive = true;
    void fetchScorecard().then((r) => {
      if (alive) setRows(r);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Nothing published yet, or the fetch failed. Render nothing rather than a
  // placeholder: an empty slot is honest, a "—%" reads as a real measurement.
  if (!rows || rows.length === 0) return null;

  const anyGraded = rows.some((r) => r.graded > 0);
  if (!anyGraded) return null;

  return (
    <Card style={st.card}>
      <Label>VANE'S OWN RECORD</Label>
      <View style={st.row}>
        {rows.map((r) => (
          <View key={r.horizon} style={st.cell}>
            <Text style={st.hz}>{r.horizon}</Text>
            <Text style={st.rate}>
              {r.hitRate === null ? '—' : `${Math.round(r.hitRate * 100)}%`}
            </Text>
            <Text style={st.count}>
              {r.graded > 0 ? `${r.correct}/${r.graded}` : 'no calls yet'}
            </Text>
          </View>
        ))}
      </View>
      <Text style={st.note}>
        {/* Said plainly rather than buried. A hit rate near 50% on a two-way
            call is the same as a coin flip, and a reader who does not know
            that will read 52% as skill. */}
        Every published call, graded at close. A two-way call flips at 50%, so
        anything near that is no better than chance. Rates appear once there
        are enough graded calls to mean something.
      </Text>
    </Card>
  );
}

function useStyles() {
  const { h, f } = useScale();
  return React.useMemo(
    () =>
      StyleSheet.create({
        card: { marginBottom: h(14) },
        row: { flexDirection: 'row', marginTop: h(10) },
        cell: { flex: 1, alignItems: 'center' },
        hz: { color: C.dim, fontSize: f(11), letterSpacing: 1 },
        rate: { color: C.text, fontSize: f(24), fontWeight: '700', marginTop: h(4) },
        count: { color: C.faint, fontSize: f(11), marginTop: h(2) },
        note: {
          color: C.faint, fontSize: f(11), lineHeight: f(16), marginTop: h(12),
        },
      }),
    [h, f],
  );
}
