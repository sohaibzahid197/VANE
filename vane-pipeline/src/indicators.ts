// Plain-TS technical indicators. Shared by the backtest and the live refresh,
// so a signal can never be computed one way offline and another way in production.

/** Exponential moving average. Returns an array aligned to the input. */
export function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values[0];
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

/** Wilder's RSI, 0-100. Values before `period` are filled with 50 (neutral). */
export function rsi(closes: number[], period = 14): number[] {
  const out = new Array(closes.length).fill(50);
  let gain = 0;
  let loss = 0;

  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = Math.max(0, d);
    const l = Math.max(0, -d);

    if (i <= period) {
      gain += g / period;
      loss += l / period;
      if (i === period) out[i] = rsiFrom(gain, loss);
      continue;
    }

    gain = (gain * (period - 1) + g) / period;
    loss = (loss * (period - 1) + l) / period;
    out[i] = rsiFrom(gain, loss);
  }
  return out;
}

function rsiFrom(gain: number, loss: number): number {
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

/** Realized volatility: stdev of log returns over a trailing window. */
export function realizedVol(closes: number[], window = 24): number[] {
  const out = new Array(closes.length).fill(0);
  const rets: number[] = [0];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));

  for (let i = window; i < closes.length; i++) {
    const slice = rets.slice(i - window + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    const varr = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / slice.length;
    out[i] = Math.sqrt(varr);
  }
  return out;
}

/** Trailing z-score of a series — how unusual the latest value is. */
export function zscore(values: number[], window: number): number[] {
  const out = new Array(values.length).fill(0);
  for (let i = window; i < values.length; i++) {
    const slice = values.slice(i - window + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    const sd = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / slice.length);
    out[i] = sd === 0 ? 0 : (values[i] - mean) / sd;
  }
  return out;
}
