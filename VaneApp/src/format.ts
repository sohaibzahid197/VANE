// Number and money formatting.
//
// Deliberately free of native imports so it can be unit tested directly. The
// parsing and formatting used to live inside api.ts, which imports App Check and
// Firebase — so touching a pure formatter in a test dragged in the whole native
// module chain and the test died before it ran.

/**
 * Money formatting by magnitude.
 *
 * The cutoff is deliberately at 1000, not 100: a three-digit asset like SOL at
 * 214.60 rounded to $215 while the percentage beside it came from the unrounded
 * value, so a sub-$0.50 move rendered as an identical price with a non-zero
 * percent next to it.
 */
export function money(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1000) return `$${Math.round(n).toLocaleString('en-US')}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

export const signed = (n: number) =>
  Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${n.toFixed(1)}%` : '—';

/** Compact magnitude label for caps and volumes: $1.2T, $840.5B, $12.3M. */
export function compact(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

/** Supply counts are not money; same magnitudes without a currency mark. */
export function compactUnits(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${Math.round(abs).toLocaleString('en-US')}`;
  return abs.toFixed(2);
}

export const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

export const numOr = (v: unknown, fallback: number): number => num(v) ?? fallback;
