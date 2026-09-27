// Tests for the shared formatters.
//
// Both bugs pinned here were found by looking at the running app, not by
// reading code — and both produced a screen that contradicted itself while the
// arithmetic underneath was correct.

import { money, signed, compact, compactUnits } from '../src/format.ts';

describe('signed percentages near zero', () => {
  it('does not round a real move down to zero', () => {
    // Observed live on the Signals screen: Bitcoin at $84,426 with a 24H target
    // of $84,462 — a genuine +0.043% — rendered as "+0.0%" directly beside a
    // target price that visibly differed from the current one. The target is
    // shown at full precision, so rounding the move to a coarser place made the
    // two numbers disagree on screen.
    expect(signed(0.0426)).not.toBe('+0.0%');
    expect(signed(0.0426)).toBe('+0.04%');
    expect(signed(-0.0426)).toBe('-0.04%');
    expect(signed(0.004)).toBe('+0.004%');
  });

  it('keeps one decimal place for ordinary moves', () => {
    expect(signed(1.53)).toBe('+1.5%');
    expect(signed(-4.2)).toBe('-4.2%');
    expect(signed(12)).toBe('+12.0%');
  });

  it('still shows a genuine zero as zero', () => {
    // A real absence of movement should read as one.
    expect(signed(0)).toBe('0.0%');
  });

  it('returns an em dash for non-finite input', () => {
    expect(signed(Number.NaN)).toBe('—');
    expect(signed(Infinity)).toBe('—');
  });
});

describe('money across token magnitudes', () => {
  it('never collapses a sub-cent price to zero', () => {
    // toFixed(4) rendered a $0.00002347 token as "$0.0000" in the Markets row
    // while the chart crosshair on the same screen showed its real price.
    expect(money(0.00002347)).toBe('$0.0000235');
    expect(money(0.0000094)).toBe('$0.00000940');
  });

  it('keeps conventional formatting above a cent', () => {
    expect(money(84560)).toBe('$84,560');
    expect(money(214.6)).toBe('$214.60');
    expect(money(0.2843)).toBe('$0.2843');
  });

  it('puts the sign outside the currency mark', () => {
    expect(money(-3)).toBe('-$3.00');
  });

  it('renders exact zero plainly', () => {
    expect(money(0)).toBe('$0');
  });
});

describe('compact magnitudes', () => {
  it('labels each magnitude', () => {
    expect(compact(2.4e12)).toBe('$2.40T');
    expect(compact(8.4e11)).toBe('$840.00B');
    expect(compact(1.23e7)).toBe('$12.30M');
  });

  it('shows an em dash rather than $0 for missing data', () => {
    expect(compact(null)).toBe('—');
  });

  it('formats supply counts without a currency mark', () => {
    expect(compactUnits(19_500_000)).toBe('19.50M');
  });
});
