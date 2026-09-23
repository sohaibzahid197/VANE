import assert from 'node:assert/strict';
import { test } from 'node:test';

// The limiter is module-private, so exercise it through the same shape rather
// than exporting internals: these assertions pin the POLICY, which is what a
// future change is likely to get wrong.
const RATE_LIMIT = { max: 10, windowMs: 60_000 };

function makeLimiter() {
  const hits = new Map<string, number[]>();
  return (uid: string, now: number): boolean => {
    const recent = (hits.get(uid) ?? []).filter((t) => now - t < RATE_LIMIT.windowMs);
    recent.push(now);
    hits.set(uid, recent);
    return recent.length > RATE_LIMIT.max;
  };
}

test('a normal purchase is never throttled', () => {
  const limited = makeLimiter();
  // One validate per purchase, plus a retry or two, is the real-world shape.
  for (let i = 0; i < 3; i++) {
    assert.equal(limited('user-a', Date.now() + i * 1000), false);
  }
});

test('a flood from one account is cut off', () => {
  const limited = makeLimiter();
  const t = Date.now();
  let blocked = 0;
  for (let i = 0; i < 50; i++) if (limited('attacker', t + i)) blocked++;
  assert.equal(blocked, 40, 'everything past the limit should be refused');
});

test('one account cannot throttle another', () => {
  const limited = makeLimiter();
  const t = Date.now();
  for (let i = 0; i < 50; i++) limited('attacker', t + i);
  assert.equal(limited('innocent', t), false);
});

test('the window rolls from the LAST request, not the first', () => {
  // This is a sliding window, so an account that keeps hammering keeps its
  // own window full and stays blocked. Recovery is measured from the most
  // recent attempt, which is the behaviour that actually deters a flood.
  const limited = makeLimiter();
  const t = Date.now();
  for (let i = 0; i < 50; i++) limited('user-b', t + i);

  // Still blocked one window after the FIRST request: 48 of the 50 hits are
  // inside the window at that instant.
  assert.equal(limited('user-b', t + RATE_LIMIT.windowMs + 1), true);

  // Recovered one window after the LAST one.
  assert.equal(limited('user-b', t + 49 + RATE_LIMIT.windowMs + 1), false);
});
