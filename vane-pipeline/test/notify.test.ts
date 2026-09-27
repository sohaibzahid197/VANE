import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flipMessage, flips, notifyFlips } from '../src/notify.ts';

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

// --- who actually receives a flip push --------------------------------------
//
// Three conditions must ALL hold, and until this change two of them could never
// be true because nothing ever wrote them. These pin the consent boundary: the
// preference is opt-in, and absent means no.

/** Minimal Firestore stand-in: one users collection, one last_directions doc. */
function fakeDb(users: Record<string, unknown>[], last: Record<string, boolean>) {
  return {
    doc: () => ({
      get: async () => ({ exists: true, data: () => last }),
      set: async () => {},
      update: async () => {},
    }),
    collection: () => ({
      limit: () => ({
        get: async () => ({ docs: users.map((u, i) => ({ id: `u${i}`, data: () => u })) }),
      }),
    }),
  } as never;
}

/** Captures which tokens a multicast was aimed at. */
function stubMessaging() {
  const aimed: string[] = [];
  return {
    aimed,
    impl: {
      sendEachForMulticast: async ({ tokens }: { tokens: string[] }) => {
        aimed.push(...tokens);
        return { successCount: tokens.length, responses: tokens.map(() => ({})) };
      },
    },
  };
}

const FLIP = [{ sym: 'BTC', up: true }];
const WAS_DOWN = { BTC: false };

test('a user who has not opted in receives nothing', async () => {
  const msg = stubMessaging();
  const db = fakeDb(
    [
      // Both hold a token and watch the coin that flipped. Neither opted in:
      // one predates the preference entirely, one turned it off.
      { fcmToken: 'tok-absent', watchlist: ['BTC'] },
      { fcmToken: 'tok-false', watchlist: ['BTC'], alertFlips: false },
    ],
    WAS_DOWN,
  );

  const out = await notifyFlips(db, FLIP, 2000, msg.impl);

  assert.deepEqual(out.flipped, ['BTC'], 'the flip itself should still be detected');
  assert.equal(out.targeted, 0, 'nobody opted in, so nobody is targeted');
  assert.deepEqual(msg.aimed, [], 'and nothing is sent');
});

test('a user who opted in AND watches the coin receives it', async () => {
  const msg = stubMessaging();
  const db = fakeDb(
    [{ fcmToken: 'tok-yes', watchlist: ['BTC', 'ETH'], alertFlips: true }],
    WAS_DOWN,
  );

  const out = await notifyFlips(db, FLIP, 2000, msg.impl);

  assert.equal(out.targeted, 1);
  assert.deepEqual(msg.aimed, ['tok-yes']);
});

test('opting in does not override the watchlist', async () => {
  // Both conditions are required, not either.
  const msg = stubMessaging();
  const db = fakeDb(
    [{ fcmToken: 'tok-other', watchlist: ['SOL'], alertFlips: true }],
    WAS_DOWN,
  );

  const out = await notifyFlips(db, FLIP, 2000, msg.impl);

  assert.equal(out.targeted, 0, 'BTC flipped but this user watches only SOL');
  assert.deepEqual(msg.aimed, []);
});

test('a truthy non-boolean does not count as opting in', async () => {
  // The rules validate the type, but the sender must not lean on that alone:
  // an older document, or a future writer, could carry anything.
  const msg = stubMessaging();
  const db = fakeDb(
    [{ fcmToken: 'tok-str', watchlist: ['BTC'], alertFlips: 'true' }],
    WAS_DOWN,
  );

  const out = await notifyFlips(db, FLIP, 2000, msg.impl);

  assert.equal(out.targeted, 0);
  assert.deepEqual(msg.aimed, []);
});
