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

  // Sign handled up front so a negative change never renders as "$-3.0000".
  const neg = n < 0;
  const v = Math.abs(n);
  const sign = neg ? '-' : '';

  if (v >= 1000) return `${sign}$${Math.round(v).toLocaleString('en-US')}`;
  if (v >= 1) return `${sign}$${v.toFixed(2)}`;
  if (v >= 0.01) return `${sign}$${v.toFixed(4)}`;
  if (v === 0) return '$0';

  // BELOW A CENT, FIXED DECIMALS LIE.
  //
  // `toFixed(4)` renders a $0.00002347 memecoin as "$0.0000" — the price
  // disappears entirely, on exactly the assets people open most impulsively.
  // Chart.tsx's own fmt() already carried a comment explaining why this must not
  // happen, and then this function did it anyway one digit further out, so the
  // Markets row and the crosshair on the same screen showed different prices for
  // the same coin. Significant figures, not decimal places, is the only rule
  // that works across eight orders of magnitude of token price.
  return `${sign}$${v.toPrecision(3)}`;
}

/**
 * A signed percentage.
 *
 * One decimal place everywhere EXCEPT near zero, where it lies by rounding.
 * Observed on the live Signals screen: Bitcoin at $84,426 with a 24H target of
 * $84,462 — a real +0.043% move — rendered as "+0.0%" directly beside a target
 * price that visibly differs from the current one. The two numbers contradicted
 * each other on screen, so the app looked broken even though the arithmetic was
 * right: the target is shown at full precision while the move was rounded to a
 * place too coarse to hold it.
 *
 * Below 0.05% the value gets enough decimals to actually be non-zero. A genuine
 * zero still reads "0.0%", because that is true.
 */
export const signed = (n: number): string => {
  if (!Number.isFinite(n)) return '—';
  const sign = n >= 0 ? '+' : '-';
  const v = Math.abs(n);
  if (v === 0) return '0.0%';
  // toFixed(1) would round anything under 0.05 to "0.0".
  if (v < 0.05) return `${sign}${v.toPrecision(1)}%`;
  return `${sign}${v.toFixed(1)}%`;
};

/** Compact magnitude label for caps and volumes: $1.2T, $840.5B, $12.3M. */
export function compact(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  // Below a thousand this is no longer a magnitude label, so hand it to money()
  // rather than repeating a fixed-decimal rule that cannot hold a small number.
  //
  // This was `toFixed(2)`, which is the THIRD place the same mistake was made.
  // compact() is used for market cap and volume, where two decimals are ample —
  // but CoinChart also uses it for the all-time high and low, and XRP's all-time
  // low of about $0.0028 rendered as "$0.00" on screen. On a memecoin it would
  // erase every significant digit.
  return money(n);
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
