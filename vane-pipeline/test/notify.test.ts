import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flipMessage, flips } from '../src/notify.ts';

test('a coin that did not change is not a flip', () => {
  const out = flips({ BTC: true, ETH: false }, [
    { sym: 'BTC', up: true },
    { sym: 'ETH', up: false },
  ]);
  assert.deepEqual(out, []);
});

test('a direction change is a flip, both ways', () => {
  const out = flips({ BTC: true, ETH: false }, [
    { sym: 'BTC', up: false },
    { sym: 'ETH', up: true },
  ]);
  assert.deepEqual(out.sort(), ['BTC', 'ETH']);
});

test('a coin we have never seen is not a flip', () => {
  // The first run after a deploy, or a new listing, would otherwise notify
  // every user about every coin at once.
  assert.deepEqual(flips({}, [{ sym: 'NEW', up: true }]), []);
  assert.deepEqual(flips({ BTC: true }, [
    { sym: 'BTC', up: true },
    { sym: 'NEW', up: false },
  ]), []);
});

test('one flipped coin names it and its new direction', () => {
  const m = flipMessage(['BTC'], { BTC: false });
  assert.equal(m.title, 'BTC signal flipped');
  assert.match(m.body, /reads BTC as down/);
  // The disclaimer travels with the notification, not just the app.
  assert.match(m.body, /often wrong/);
});

test('many flips are one message, not many', () => {
  const syms = ['BTC', 'ETH', 'SOL', 'XRP', 'ADA'];
  const m = flipMessage(syms, Object.fromEntries(syms.map((s) => [s, true])));
  assert.equal(m.title, '5 signals flipped');
  assert.match(m.body, /BTC, ETH, SOL and 2 more/);
  assert.match(m.body, /often wrong/);
});

test('exactly three flips do not say "and 0 more"', () => {
  const m = flipMessage(['BTC', 'ETH', 'SOL'], { BTC: true, ETH: true, SOL: true });
  assert.match(m.body, /^BTC, ETH, SOL changed direction/);
  assert.doesNotMatch(m.body, /more/);
});
