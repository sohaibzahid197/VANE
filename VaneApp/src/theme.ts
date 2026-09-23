// Design tokens lifted straight from the prototype's script block, so the app
// and the design canvas can never drift apart. Nothing else hardcodes a hex.

export const C = {
  bg: '#08090B',
  card: 'rgba(255,255,255,.04)',
  cardBorder: 'rgba(255,255,255,.08)',
  accent: '#4EF0B0',
  down: '#FF5A5F',
  text: '#F2F4F3',
  // 0.55 alpha -> ~5.8:1 against the ground. Passes WCAG AA for body text.
  dim: 'rgba(242,244,243,.55)',
  // Was 0.38, which composites to ~#636564 for a contrast ratio of 3.27:1 —
  // a WCAG failure on the 9-11pt labels it is used for, including the
  // subscription fine print. 0.60 lifts it to ~6.5:1.
  faint: 'rgba(242,244,243,.60)',
} as const;

export const F = {
  head: 'System',
  mono: 'Menlo',
} as const;

/**
 * accent/down at an arbitrary alpha.
 * Only accepts 3- or 6-digit hex; an rgba() string in would silently produce
 * `rgba(NaN,NaN,NaN,a)`, so we fail loudly in development instead.
 */
export function tint(hex: string, a: number) {
  const h = hex.replace('#', '');
  if (!/^([0-9a-f]{3}|[0-9a-f]{6})$/i.test(h)) {
    if (__DEV__) throw new Error(`tint() needs a hex colour, got "${hex}"`);
    return hex;
  }
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
