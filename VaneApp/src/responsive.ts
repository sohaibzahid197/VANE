// Responsive scaling. The design was drawn at 402x874 (iPhone 17 Pro), so
// every size is expressed relative to that and scaled to the real device —
// from a 320pt iPhone SE to a 1024pt tablet, iOS and Android alike.
//
// IMPORTANT: prefer the `useScale()` hook over the bare w/h/f functions.
// The bare ones read Dimensions at call time, so calling them inside a
// module-scope StyleSheet.create() freezes the value at import and it never
// updates on rotation, fold, or split-screen resize. `useScale()` subscribes
// to dimension changes and re-renders.

import { useMemo } from 'react';
import { useWindowDimensions } from 'react-native';
import { Dimensions, PixelRatio } from 'react-native';

const BASE_W = 402;
// Vertical rhythm deliberately keys off WIDTH (see scaleFrom), so the design
// height is documentation rather than a value anything divides by.
// const BASE_H = 874;
const MAX_RATIO = 1.35;

/** Vertical rhythm keys off width, not height: keying off height collapsed
 *  all spacing in landscape (h(62) became 23pt on a phone on its side). */
function scaleFrom(width: number, size: number) {
  const ratio = Math.min(width / BASE_W, MAX_RATIO);
  return Math.round(PixelRatio.roundToNearestPixel(size * ratio));
}

/**
 * Font scaling, damped. Text scaled linearly looks wrong on small screens,
 * so we move it only a fraction of the way toward the raw ratio.
 * Floor raised to 0.95: at 0.88 a 9pt label rendered 8pt on a 320pt device,
 * below any accessibility floor.
 */
function fontFrom(width: number, size: number) {
  const raw = width / BASE_W;
  const damped = 1 + (raw - 1) * 0.5;
  const clamped = Math.max(0.95, Math.min(damped, 1.2));
  // Absolute floor: nothing in the UI may render below 10pt.
  return Math.max(10, Math.round(PixelRatio.roundToNearestPixel(size * clamped)));
}

export type Scale = {
  w: (n: number) => number;
  h: (n: number) => number;
  f: (n: number) => number;
  width: number;
  height: number;
  isTablet: boolean;
  isSmall: boolean;
  landscape: boolean;
  /**
   * Tablets get a centred column rather than stretched-out rows.
   *
   * Dormant while the app ships iPhone-only and portrait-only — no iPhone is
   * 600pt wide in portrait, so this is always undefined today. Kept rather
   * than deleted because it costs nothing and is exactly what would be needed
   * the day iPad support returns.
   */
  maxWidth: number | undefined;
};

/**
 * The hook every component should use. Re-renders on any size change.
 *
 * Memoized on width and height, so `w`, `h` and `f` keep their identity
 * between renders. That is not a micro-optimisation: every screen builds its
 * StyleSheet inside a `useMemo` keyed on these functions, and while they were
 * re-allocated on each render the dependency array never compared equal, so
 * `StyleSheet.create` re-ran on every render of every component in the app.
 * Stable identities also let those memos list their real dependencies instead
 * of fighting the exhaustive-deps rule.
 */
export function useScale(): Scale {
  const { width, height } = useWindowDimensions();
  return useMemo(() => {
    const isTablet = width >= 600;
    return {
      w: (n: number) => scaleFrom(width, n),
      h: (n: number) => scaleFrom(width, n),
      f: (n: number) => fontFrom(width, n),
      width,
      height,
      isTablet,
      isSmall: width <= 360,
      landscape: width > height,
      maxWidth: isTablet ? contentMaxWidth : undefined,
    };
  }, [width, height]);
}

export const contentMaxWidth = 560;

/**
 * Non-reactive escapes, for the few places outside a component (icon default
 * sizes). Anything inside a component should use useScale().
 */
const win = () => Dimensions.get('window');
export const w = (n: number) => scaleFrom(win().width, n);
export const h = (n: number) => scaleFrom(win().width, n);
export const f = (n: number) => fontFrom(win().width, n);

/** Cap OS font scaling so a 200% setting cannot break fixed-height rows. */
export const MAX_FONT_SCALE = 1.6;
