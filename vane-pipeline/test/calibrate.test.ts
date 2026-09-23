// Tests for the calibration layer.
//
// This module decides whether a percentage is ever shown next to a direction,
// and the sign convention is the single easiest thing to get catastrophically
// wrong: P(correct) rendered next to the word "UP" on a bearish call is an
// inverted prediction shown with confidence.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  confidenceCorrect, confidenceUp, newBuckets, observe, reliability, toTable,
} from '../src/calibrate.ts';

const MIN_SAMPLES = 30;

function filled(score: number, wins: number, losses: number) {
  const b = newBuckets();
  for (let i = 0; i < wins; i++) observe(b, score, true);
  for (let i = 0; i < losses; i++) observe(b, score, false);
  return b;
}

test('a thin bucket reports null rather than a number', () => {
  // The whole point of the gate: never invent confidence from three samples.
  const b = filled(0.3, 5, 2);
  assert.equal(confidenceCorrect(b, 0.3), null);
  assert.equal(confidenceUp(b, 0.3), null);
});

test('a bucket exactly at the threshold reports a number', () => {
  const b = filled(0.3, MIN_SAMPLES, 0);
  assert.equal(confidenceCorrect(b, 0.3), 100);
});

test('confidenceUp equals confidenceCorrect for a BULLISH score', () => {
  const b = filled(0.3, 70, 30);
  assert.equal(confidenceCorrect(b, 0.3), 70);
  assert.equal(confidenceUp(b, 0.3), 70);
});

test('confidenceUp INVERTS for a bearish score', () => {
  // Buckets key on |score|, so a -0.3 call lands in the same bucket. Being
  // 70% correct about DOWN means a 30% chance of UP.
  const b = filled(0.3, 70, 30);
  assert.equal(confidenceCorrect(b, -0.3), 70);
  assert.equal(confidenceUp(b, -0.3), 30);
});

test('a score of exactly zero is treated as the bullish side', () => {
  // Must agree with signal.ts, where `up = score >= 0`.
  const b = filled(0, 60, 40);
  assert.equal(confidenceUp(b, 0), confidenceCorrect(b, 0));
});

test('confidenceUp stays within 0..100 for both signs', () => {
  for (const [w, l] of [[30, 0], [0, 30], [45, 55], [99, 1]]) {
    const b = filled(0.3, w, l);
    for (const s of [0.3, -0.3]) {
      const v = confidenceUp(b, s);
      assert.ok(v !== null && v >= 0 && v <= 100, `got ${v}`);
    }
  }
});

test('observe buckets on magnitude, so +s and -s share a bucket', () => {
  const b = newBuckets();
  for (let i = 0; i < 20; i++) observe(b, 0.3, true);
  for (let i = 0; i < 20; i++) observe(b, -0.3, true);
  assert.equal(confidenceCorrect(b, 0.3), 100, 'both signs should fill one bucket');
});

test('an out-of-range score falls into the last bucket rather than throwing', () => {
  const b = filled(5, MIN_SAMPLES, 0);
  assert.equal(confidenceCorrect(b, 5), 100);
  assert.equal(confidenceCorrect(b, -5), 100);
});

test('an empty bucket set is null everywhere, never NaN', () => {
  const b = newBuckets();
  for (const s of [0, 0.01, 0.5, 1, -1]) {
    assert.equal(confidenceCorrect(b, s), null);
    assert.equal(confidenceUp(b, s), null);
  }
});

test('toTable round-trips the shape publish.ts reads', () => {
  const b = filled(0.3, 40, 10);
  const t = toTable(b);
  assert.ok(Array.isArray(t));
  for (const bucket of t) {
    for (const k of ['lo', 'hi', 'wins', 'total'] as const) {
      assert.equal(typeof bucket[k], 'number', `missing ${k}`);
    }
  }
  // A copy, not a live reference — publish must not mutate the backtest's view.
  t[0].wins = 9999;
  assert.notEqual(b[0].wins, 9999);
});

test('reliability renders only populated buckets and flags thin ones', () => {
  const b = filled(0.3, 5, 5);
  const out = reliability(b);
  assert.ok(out.includes('too few'), 'thin buckets must be marked');
  assert.equal(out.split('\n').filter(Boolean).length, 1, 'empty buckets omitted');
});
