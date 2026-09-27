// Candlestick chart with a volume pane and a draggable crosshair.
//
// WHY SVG RATHER THAN TRADINGVIEW LIGHTWEIGHT CHARTS
//
// The plan specified Lightweight Charts, and for landscape charting with zoom
// and pan it is still the right answer. It is not the right answer for this
// screen, for one concrete reason: it is a canvas library, so it needs a
// WebView, and react-native-webview is not installed. Adding it means a new
// native module, a pod install and a rebuild of an app whose in-app purchase
// flow is currently working and verified on device — a meaningful risk to take
// for a chart that SVG draws natively.
//
// react-native-svg IS already installed and already draws the sparklines. A
// candlestick is a rectangle and two lines; a volume bar is a rectangle. The
// MVP needs candles, volume, ranges and a crosshair, all of which are here, and
// none of which need a browser.
//
// What this gives up, honestly: pinch-zoom and pan, and the kind of dense
// multi-pane indicator layout Lightweight Charts does well. Those belong with
// landscape charting, which the plan already scheduled for V3. Revisit then.
//
// It also drops an obligation: Lightweight Charts requires attribution. This
// does not.

import React, { useMemo, useRef, useState } from 'react';
import { PanResponder, View } from 'react-native';
import Svg, { G, Line, Path, Rect, Text as SvgText } from 'react-native-svg';
import { Text } from './ui.tsx';
import { C, F, tint } from './theme.ts';
import type { Range, Series } from './markets.ts';

/** Fraction of the plot given to the volume pane. */
const VOLUME_FRACTION = 0.22;
/** Gap between the price pane and the volume pane. */
const PANE_GAP = 10;

export type ChartProps = {
  series: Series;
  width: number;
  height: number;
  range: Range;
  /**
   * Force a mode. Left undefined, the chart CHOOSES based on bar density.
   *
   * Candles need roughly 3pt per bar to read. A 365-bar year on a 320pt chart
   * gives 0.88pt per bar, so a 1pt-minimum body plus a 1pt wick renders as a
   * solid filled band between the high and low envelope — not a chart, just a
   * coloured shape. Drawing a line there is not a downgrade; it is the only
   * honest rendering of that many bars at that width.
   */
  mode?: 'candles' | 'line';
  showVolume?: boolean;
};

/**
 * Points per bar below which candle bodies stop being distinguishable.
 *
 * MEASURED ON A DEVICE, not reasoned about. This was 2.4, derived from an
 * argument that a 68%-of-slot body with a sub-pixel gap would merge into a solid
 * band after rasterization. On an iPhone 17 Pro the 30D chart is 180 bars at
 * ~1.9pt each, and the argument says that should be unreadable — the screenshot
 * says otherwise: clearly separated green and red bodies with visible wicks. The
 * threshold was throwing away the best-looking chart in the app.
 *
 * 1.5 keeps 30D (~1.9) and 90D (~3.9) as candles. Anything denser genuinely does
 * merge, and the ranges that would hit it are close-only anyway, so they take the
 * no-range branch below first.
 */
const MIN_SLOT_FOR_CANDLES = 1.5;

type Geometry = {
  lo: number;
  hi: number;
  priceH: number;
  volH: number;
  volTop: number;
  barW: number;
  slot: number;
  x: (i: number) => number;
  y: (p: number) => number;
  vy: (v: number) => number;
};

export function Chart({
  series,
  width,
  height,
  range,
  mode,
  showVolume = true,
}: ChartProps) {
  const [cursor, setCursor] = useState<number | null>(null);
  const geomRef = useRef<Geometry | null>(null);

  const n = series.c.length;
  const hasVolume = showVolume && series.v.length === n && series.v.some((v) => v > 0);

  /**
   * Do these bars carry any candle information at all?
   *
   * CoinGecko's market_chart is CLOSE-ONLY, so chartToCandles emits every raw
   * sample with open === high === low === close. resample() only synthesizes a
   * real open/high/low when a bucket holds more than one bar — so a range whose
   * source is already at or under its point budget passes through untouched and
   * every "candle" is a single point.
   *
   * On screen that is a 1px dash with no body and no wick. 24H (25 bars into a
   * 96 budget), 7D (168 into 168) and 1Y (365 into 365) all rendered as floating
   * dashes and scattered dots, while 30D and 90D — which genuinely aggregate —
   * drew proper candlesticks. Three of five ranges looked broken, and no amount
   * of code review found it; it took opening the app.
   *
   * A line is the honest rendering of close-only data. You cannot draw a candle
   * from one number.
   */
  const hasBarRange = useMemo(() => {
    for (let i = 0; i < n; i++) {
      if (series.h[i]! > series.l[i]!) return true;
    }
    return false;
  }, [series, n]);

  /**
   * Chosen from the data, not asserted by the caller.
   *
   * `mode` is now advisory: a caller may force line mode, but it cannot force
   * candles onto bars that have no range to draw. CoinChart used to pass an
   * explicit 'candles' for every range, which silently defeated the density
   * check this was added for.
   */
  const drawMode: 'candles' | 'line' =
    !hasBarRange || n === 0 || width / n < MIN_SLOT_FOR_CANDLES ? 'line' : (mode ?? 'candles');

  const geom = useMemo<Geometry | null>(() => {
    if (n === 0 || width <= 0 || height <= 0) return null;

    // Range from highs and lows, not closes — otherwise a wick pokes outside
    // the plot and gets clipped, which reads as a rendering bug.
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < n; i++) {
      if (series.l[i]! < lo) lo = series.l[i]!;
      if (series.h[i]! > hi) hi = series.h[i]!;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;

    // A flat series has no range to normalise against. Give it a nominal one
    // so it draws as a level line rather than dividing by zero.
    if (hi === lo) {
      const nudge = Math.abs(hi) * 0.001 || 1;
      lo -= nudge;
      hi += nudge;
    }

    const pad = (hi - lo) * 0.06;
    lo -= pad;
    hi += pad;

    const volH = hasVolume ? height * VOLUME_FRACTION : 0;
    const priceH = height - volH - (hasVolume ? PANE_GAP : 0);
    const volTop = priceH + PANE_GAP;

    let volMax = 0;
    if (hasVolume) for (const v of series.v) if (v > volMax) volMax = v;

    const slot = width / n;
    // Leave a gap between candles, but never thinner than a hairline — at 365
    // bars on a phone the body is under a pixel and 0.6 of nothing is nothing.
    const barW = Math.max(1, Math.min(slot * 0.68, 14));

    return {
      lo,
      hi,
      priceH,
      volH,
      volTop,
      barW,
      slot,
      x: (i: number) => slot * i + slot / 2,
      y: (p: number) => priceH - ((p - lo) / (hi - lo)) * priceH,
      vy: (v: number) => (volMax === 0 ? volH : volH - (v / volMax) * volH),
    };
  }, [series, width, height, n, hasVolume]);

  geomRef.current = geom;

  /**
   * Crosshair dragging.
   *
   * PanResponder rather than onTouch handlers because a horizontal drag inside a
   * scrolling screen has to claim the gesture, or the parent ScrollView eats it
   * and the crosshair only ever responds to taps.
   *
   * PAGE COORDINATES, NOT locationX — and this is a real iOS bug, not a
   * preference. `locationX` is measured relative to the EVENT TARGET, and in
   * react-native-svg every shape is a real UIView whose hitTest returns itself.
   * So a touch landing on a candle body or wick targets that rect, and
   * locationX arrives in the range 0..barW (at most 14) instead of 0..width.
   * The crosshair therefore jumped back to bar 0 or 1 every time the finger
   * crossed a candle — which, on a dense chart, is most of the time. Android was
   * unaffected because it draws virtual nodes into one canvas, so this looked
   * fine in a simulator on the wrong platform.
   *
   * gestureState.moveX/x0 are page coordinates, so they are immune to whatever
   * the touch happened to land on. They need the chart's own page origin, which
   * is what `originX` measures.
   */
  const wrapRef = useRef<React.ComponentRef<typeof View>>(null);
  const originX = useRef(0);

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > Math.abs(g.dy),
        onPanResponderGrant: (_e, g) => setCursor(indexAt(g.x0 - originX.current)),
        onPanResponderMove: (_e, g) => setCursor(indexAt(g.moveX - originX.current)),
        onPanResponderRelease: () => setCursor(null),
        onPanResponderTerminate: () => setCursor(null),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [n, width],
  );

  function indexAt(x: number): number | null {
    const g = geomRef.current;
    if (!g || n === 0) return null;
    const i = Math.floor(x / g.slot);
    return Math.max(0, Math.min(n - 1, i));
  }

  if (!geom || n === 0) {
    return (
      <View style={{ width, height, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: C.faint, fontSize: 12 }}>No chart data for {range}</Text>
      </View>
    );
  }

  const first = series.c[0]!;
  const last = series.c[n - 1]!;
  // Colour the whole chart by the move ACROSS THE VISIBLE RANGE, which is what
  // the percentage beside it describes. Colouring by the final candle instead
  // makes a chart that fell 20% look green whenever its last bar ticked up.
  const rangeUp = last >= first;
  const lineColor = rangeUp ? C.accent : C.down;

  return (
    <View
      ref={wrapRef}
      // Re-measured on layout rather than once on mount: the chart sits inside a
      // ScrollView, so its page origin moves.
      onLayout={() => {
        wrapRef.current?.measureInWindow((x: number) => {
          originX.current = x;
        });
      }}
      accessibilityRole="image"
      accessibilityLabel={
        n === 0
          ? `No chart data for ${range}`
          : `${range} price chart, ${n} bars, ` +
            `${rangeUp ? 'up' : 'down'} ${Math.abs(((last - first) / first) * 100).toFixed(1)}% ` +
            `over the range, from ${fmt(first)} to ${fmt(last)}`
      }
      style={{ width, height }}
      {...pan.panHandlers}>
      <Svg width={width} height={height}>
        {/* Horizontal guides. Four, unlabelled — the axis labels live outside
            the chart so they never overlap a candle. */}
        <G>
          {[0.25, 0.5, 0.75].map((f) => (
            <Line
              key={f}
              x1={0}
              x2={width}
              y1={geom.priceH * f}
              y2={geom.priceH * f}
              stroke={C.cardBorder}
              strokeWidth={1}
            />
          ))}
        </G>

        {drawMode === 'line' ? (
          <>
            <Path
              d={areaPath(series.c, geom, width)}
              fill={tint(rangeUp ? C.accent : C.down, 0.1)}
            />
            <Path
              d={linePath(series.c, geom)}
              stroke={lineColor}
              strokeWidth={2}
              fill="none"
            />
          </>
        ) : (
          <G>
            {series.c.map((close, i) => {
              const open = series.o[i]!;
              const up = close >= open;
              const color = up ? C.accent : C.down;
              const yHigh = geom.y(series.h[i]!);
              const yLow = geom.y(series.l[i]!);
              const yOpen = geom.y(open);
              const yClose = geom.y(close);
              const top = Math.min(yOpen, yClose);
              // A doji (open === close) has zero body height and would vanish.
              const bodyH = Math.max(1, Math.abs(yClose - yOpen));
              const cx = geom.x(i);
              return (
                <G key={i}>
                  <Line
                    x1={cx}
                    x2={cx}
                    y1={yHigh}
                    y2={yLow}
                    stroke={color}
                    strokeWidth={1}
                  />
                  <Rect
                    x={cx - geom.barW / 2}
                    y={top}
                    width={geom.barW}
                    height={bodyH}
                    fill={color}
                  />
                </G>
              );
            })}
          </G>
        )}

        {hasVolume && (
          <G>
            {series.v.map((v, i) => {
              const up = series.c[i]! >= series.o[i]!;
              const h = geom.volH - geom.vy(v);
              return (
                <Rect
                  key={i}
                  x={geom.x(i) - geom.barW / 2}
                  y={geom.volTop + geom.vy(v)}
                  width={geom.barW}
                  height={Math.max(0.5, h)}
                  fill={tint(up ? C.accent : C.down, 0.35)}
                />
              );
            })}
          </G>
        )}

        {cursor !== null && (
          <G>
            <Line
              x1={geom.x(cursor)}
              x2={geom.x(cursor)}
              y1={0}
              y2={height}
              stroke={C.text}
              strokeWidth={1}
              strokeDasharray="3,3"
              opacity={0.6}
            />
            <Line
              x1={0}
              x2={width}
              y1={geom.y(series.c[cursor]!)}
              y2={geom.y(series.c[cursor]!)}
              stroke={C.text}
              strokeWidth={1}
              strokeDasharray="3,3"
              opacity={0.35}
            />
            {/* Value readout. Flipped to the left of the crosshair once it
                would otherwise run off the right edge. */}
            <SvgText
              x={geom.x(cursor) > width - 90 ? geom.x(cursor) - 8 : geom.x(cursor) + 8}
              y={14}
              fill={C.text}
              fontSize={11}
              fontFamily={F.mono}
              textAnchor={geom.x(cursor) > width - 90 ? 'end' : 'start'}
            >
              {fmt(series.c[cursor]!)}
            </SvgText>
          </G>
        )}
      </Svg>
    </View>
  );
}

/** The timestamp and price under the crosshair, for a caption outside the SVG. */
export function readout(series: Series, i: number | null): { when: string; price: string } | null {
  if (i === null || i < 0 || i >= series.c.length) return null;
  return { when: new Date(series.t[i]!).toLocaleString(), price: fmt(series.c[i]!) };
}

function linePath(values: number[], g: Geometry): string {
  return values
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${g.x(i).toFixed(1)},${g.y(v).toFixed(1)}`)
    .join(' ');
}

function areaPath(values: number[], g: Geometry, width: number): string {
  if (values.length === 0) return '';
  return (
    `${linePath(values, g)} L${width.toFixed(1)},${g.priceH.toFixed(1)} ` +
    `L0,${g.priceH.toFixed(1)} Z`
  );
}

/**
 * Price formatting that keeps significant digits on cheap assets.
 *
 * A fixed 2 decimals renders a $0.00002 memecoin as "$0.00", which is the kind
 * of detail that makes a market app look broken on exactly the assets people
 * check most impulsively.
 */
function fmt(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1000) return `$${Math.round(n).toLocaleString('en-US')}`;
  if (abs >= 1) return `$${n.toFixed(2)}`;
  if (abs >= 0.01) return `$${n.toFixed(4)}`;
  if (abs === 0) return '$0';
  return `$${n.toPrecision(3)}`;
}
