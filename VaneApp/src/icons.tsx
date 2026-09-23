// Vector icons, drawn as SVG paths on a 24x24 grid.
//
// These replace the Unicode glyphs (◈ ◎ ◍ ◌ ✓ ✕ ▲ ▼ 🔒) the prototype used.
// Glyphs were a liability: they render differently on iOS and Android, the
// emoji ones are full-colour bitmaps that ignore the theme, and none of them
// scale cleanly or accept a stroke weight.

import React from 'react';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { C } from './theme.ts';

export type IconProps = {
  size?: number;
  color?: string;
  /** Filled variant for active tab states. */
  active?: boolean;
};

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
});

/** Tab: signals — a candlestick chart. */
export function IconSignals({ size = 22, color = C.faint, active }: IconProps) {
  return (
    <Svg {...base(size)}>
      <Path
        d="M5 14v5M5 8v2M12 5v3M12 16v3M19 10v4M19 3.5v3.5M19 17v3.5"
        stroke={color}
        strokeWidth={1.7}
        strokeLinecap="round"
      />
      <Rect
        x={3} y={10} width={4} height={4} rx={1}
        stroke={color} strokeWidth={1.7}
        fill={active ? color : 'none'}
      />
      <Rect
        x={10} y={8} width={4} height={8} rx={1}
        stroke={color} strokeWidth={1.7}
        fill={active ? color : 'none'}
      />
      <Rect
        x={17} y={7} width={4} height={10} rx={1}
        stroke={color} strokeWidth={1.7}
        fill={active ? color : 'none'}
      />
    </Svg>
  );
}

/** Tab: predict — a target with a forecast arc. */
export function IconPredict({ size = 22, color = C.faint, active }: IconProps) {
  return (
    <Svg {...base(size)}>
      <Circle cx={12} cy={12} r={8.5} stroke={color} strokeWidth={1.7} fill="none" />
      <Circle cx={12} cy={12} r={4} stroke={color} strokeWidth={1.7} fill="none" />
      <Circle cx={12} cy={12} r={1.6} fill={active ? color : 'none'} stroke={color} strokeWidth={1.4} />
    </Svg>
  );
}

/** Tab: record — a rising trend line. */
export function IconRecord({ size = 22, color = C.faint, active }: IconProps) {
  return (
    <Svg {...base(size)}>
      <Path
        d="M4 16.5l4.5-4.5 3.2 3.2L20 7"
        stroke={color}
        strokeWidth={1.9}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <Path d="M15.5 7H20v4.5" stroke={color} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      {active && <Circle cx={8.5} cy={12} r={1.8} fill={color} />}
    </Svg>
  );
}

/** Tab: settings — sliders. */
export function IconSettings({ size = 22, color = C.faint, active }: IconProps) {
  return (
    <Svg {...base(size)}>
      {/* Rails drawn as segments that stop either side of each knob, so the
          icon never needs an opaque fill to mask them — it stays correct on
          cards and tinted surfaces, not just on the page background. */}
      <Path
        d="M4 7h2.7M11.3 7H20M4 12h8.7M17.3 12H20M4 17h1.7M10.3 17H20"
        stroke={color}
        strokeWidth={1.7}
        strokeLinecap="round"
      />
      <Circle cx={9} cy={7} r={2.3} fill={active ? color : 'none'} stroke={color} strokeWidth={1.7} />
      <Circle cx={15} cy={12} r={2.3} fill={active ? color : 'none'} stroke={color} strokeWidth={1.7} />
      <Circle cx={8} cy={17} r={2.3} fill={active ? color : 'none'} stroke={color} strokeWidth={1.7} />
    </Svg>
  );
}

/** A closed padlock, for gated content. */
export function IconLock({ size = 18, color = C.dim }: IconProps) {
  return (
    <Svg {...base(size)}>
      <Rect x={5} y={10.5} width={14} height={9.5} rx={2.2} stroke={color} strokeWidth={1.8} fill="none" />
      <Path d="M8 10.5V7.8a4 4 0 118 0v2.7" stroke={color} strokeWidth={1.8} strokeLinecap="round" fill="none" />
      <Circle cx={12} cy={15} r={1.5} fill={color} />
    </Svg>
  );
}

/** Direction arrows for calls and signal rows. */
export function IconUp({ size = 16, color = C.accent }: IconProps) {
  return (
    <Svg {...base(size)}>
      <Path d="M12 19V6M6 11.5L12 5l6 6.5" stroke={color} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </Svg>
  );
}

export function IconDown({ size = 16, color = C.down }: IconProps) {
  return (
    <Svg {...base(size)}>
      <Path d="M12 5v13M6 12.5L12 19l6-6.5" stroke={color} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </Svg>
  );
}

/** Win / loss marks on the track record. */
export function IconCheck({ size = 16, color = C.accent }: IconProps) {
  return (
    <Svg {...base(size)}>
      <Path d="M5 12.5l4.5 4.5L19 7" stroke={color} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </Svg>
  );
}

export function IconCross({ size = 16, color = C.down }: IconProps) {
  return (
    <Svg {...base(size)}>
      <Path d="M6.5 6.5l11 11M17.5 6.5l-11 11" stroke={color} strokeWidth={2.4} strokeLinecap="round" fill="none" />
    </Svg>
  );
}

/** An open, not-yet-resolved call. */
export function IconPending({ size = 16, color = C.accent }: IconProps) {
  return (
    <Svg {...base(size)}>
      <Circle cx={12} cy={12} r={8.5} stroke={color} strokeWidth={1.8} fill="none" />
      <Path d="M12 7.5V12l3 2" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </Svg>
  );
}

/** Watchlist toggle. */
export function IconStar({ size = 18, color = C.faint, filled }: IconProps & { filled?: boolean }) {
  return (
    <Svg {...base(size)}>
      <Path
        d="M12 3.6l2.6 5.3 5.8.85-4.2 4.1 1 5.75L12 16.9l-5.2 2.7 1-5.75-4.2-4.1 5.8-.85z"
        stroke={color}
        strokeWidth={1.7}
        strokeLinejoin="round"
        fill={filled ? color : 'none'}
      />
    </Svg>
  );
}

/** Close control on the paywall. */
export function IconClose({ size = 16, color = C.dim }: IconProps) {
  return (
    <Svg {...base(size)}>
      <Path d="M6.5 6.5l11 11M17.5 6.5l-11 11" stroke={color} strokeWidth={2} strokeLinecap="round" fill="none" />
    </Svg>
  );
}

/** Back chevron for pushed screens. */
export function IconBack({ size = 20, color = C.text }: IconProps) {
  return (
    <Svg {...base(size)}>
      <Path d="M14.5 5.5L8 12l6.5 6.5" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </Svg>
  );
}

/** Row chevron. */
export function IconChevron({ size = 16, color = C.faint }: IconProps) {
  return (
    <Svg {...base(size)}>
      <Path d="M9.5 5.5L16 12l-6.5 6.5" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </Svg>
  );
}

/** Perk ticks on the paywall. */
export function IconTick({ size = 14, color = C.accent }: IconProps) {
  return (
    <Svg {...base(size)}>
      <Circle cx={12} cy={12} r={9.5} fill="none" stroke={color} strokeWidth={1.6} />
      <Path d="M7.5 12.4l3.1 3.1L16.5 9.5" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </Svg>
  );
}

/** Empty / error states. */
export function IconEmpty({ size = 26, color = C.faint }: IconProps) {
  return (
    <Svg {...base(size)}>
      <Circle cx={12} cy={12} r={9} stroke={color} strokeWidth={1.6} fill="none" strokeDasharray="3 3" />
    </Svg>
  );
}

export function IconWarning({ size = 26, color = C.faint }: IconProps) {
  return (
    <Svg {...base(size)}>
      <Path d="M12 3.5L21.5 20H2.5L12 3.5z" stroke={color} strokeWidth={1.6} strokeLinejoin="round" fill="none" />
      <Path d="M12 9.5v4.5" stroke={color} strokeWidth={1.9} strokeLinecap="round" />
      <Circle cx={12} cy={16.8} r={1.1} fill={color} />
    </Svg>
  );
}

export const TAB_ICONS: Record<string, React.FC<IconProps>> = {
  Signals: IconSignals,
  Predict: IconPredict,
  Record: IconRecord,
  Settings: IconSettings,
};
