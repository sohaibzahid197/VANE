import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gradeCalls, recordCalls, scorecard } from '../src/scorecard.ts';

/** A Firestore stand-in: enough surface for these three functions. */
function fakeDb() {
  const docs = new Map<string, any>();
  const writes: { op: string; path: string }[] = [];

  const makeDoc = (path: string) => ({
    ref: { path },
    id: path.split('/').pop(),
    data: () => docs.get(path),
    get: (field: string) => docs.get(path)?.[field],
  });

  const db: any = {
    doc: (path: string) => ({
      path,
      get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
    }),
    runTransaction: async (fn: any) =>
      fn({
        get: async (ref: any) => ({ exists: docs.has(ref.path), data: () => docs.get(ref.path) }),
        set: (ref: any, data: any) => docs.set(ref.path, data),
      }),
    batch: () => ({
      // Honours `merge`, because the cursor is written one horizon at a time
      // and a fake that always replaced would silently drop the others —
      // making the code look broken when the double was.
      set: (ref: any, data: any, opts?: { merge?: boolean }) => {
        writes.push({ op: 'set', path: ref.path });
        docs.set(ref.path, opts?.merge ? { ...docs.get(ref.path), ...data } : data);
      },
      update: (ref: any, data: any) => {
        writes.push({ op: 'update', path: ref.path });
        docs.set(ref.path, { ...docs.get(ref.path), ...data });
      },
      commit: async () => {},
    }),
    collection: (name: string) => {
      const filters: [string, string, any][] = [];
      const q: any = {
        where: (f: string, op: string, v: any) => {
          filters.push([f, op, v]);
          return q;
        },
        limit: () => q,
        get: async () => {
          const matched = [...docs.keys()]
            .filter((p) => p.startsWith(`${name}/`))
            .filter((p) => {
              const d = docs.get(p);
              return filters.every(([f, op, v]) =>
                op === '<=' ? d[f] <= v : d[f] === v,
              );
            })
            .map(makeDoc);
          return { empty: matched.length === 0, docs: matched };
        },
      };
      return q;
    },
  };
  return { db, docs, writes };
}

const HZ = ['24H', '7D', '30D'] as const;
const NOW = Date.UTC(2026, 8, 24, 12, 0, 0);

test('calls do not overlap: one per coin per horizon LENGTH', async () => {
  const { db, docs } = fakeDb();
  const coins = [{ sym: 'BTC', price: 100, up: true, targets: {} }];

  await recordCalls(db, coins, [...HZ], NOW);
  // 3 calls + the cursor document.
  assert.equal(docs.size, 4, 'one per horizon, plus the cursor');

  // The cron fires every 15 minutes. None of those may add a call — hourly
  // 24H calls would share 23 of 24 hours, and the published sample would
  // claim far more evidence than exists.
  for (const m of [15, 30, 45, 60, 180, 720]) {
    await recordCalls(db, coins, [...HZ], NOW + m * 60_000);
  }
  assert.equal(docs.size, 4, 'nothing within the first day adds a call');

  // A day later the 24H window has elapsed — and only that one.
  await recordCalls(db, coins, [...HZ], NOW + 25 * 3_600_000);
  assert.equal(docs.size, 5, 'only 24H records again after a day');

  // A week later 7D turns over too.
  await recordCalls(db, coins, [...HZ], NOW + 8 * 24 * 3_600_000);
  assert.equal(docs.size, 7, '24H and 7D, not 30D');
});

test('the first call of a window is kept, not the last', async () => {
  // The entry price must match what users were shown when the call was made.
  const { db, docs } = fakeDb();
  await recordCalls(db, [{ sym: 'BTC', price: 100, up: true, targets: {} }], ['24H'], NOW);
  await recordCalls(db, [{ sym: 'BTC', price: 999, up: false, targets: {} }],
                    ['24H'], NOW + 45 * 60_000);
  const call = [...docs.entries()].find(([k]) => k.startsWith('signals_history/'))![1];
  assert.equal(call.entryPrice, 100, 'a later run must not rewrite the entry price');
  assert.equal(call.direction, 'up', 'nor the direction users saw');
});

test('a call is only due after its horizon has elapsed', async () => {
  const { db } = fakeDb();
  await recordCalls(db, [{ sym: 'BTC', price: 100, up: true, targets: {} }], ['24H'], NOW);

  const early = await gradeCalls(db, { BTC: 110 }, NOW + 60_000);
  assert.equal(early.graded, 0, 'not due yet');

  const late = await gradeCalls(db, { BTC: 110 }, NOW + 25 * 3_600_000);
  assert.equal(late.graded, 1);
});

test('an UP call wins when the price rises and loses when it falls', async () => {
  for (const [up, exit, want] of [[true, 110, true], [true, 90, false],
                                  [false, 90, true], [false, 110, false]] as const) {
    const { db, docs } = fakeDb();
    await recordCalls(db, [{ sym: 'BTC', price: 100, up, targets: {} }], ['24H'], NOW);
    await gradeCalls(db, { BTC: exit }, NOW + 25 * 3_600_000);
    const row = [...docs.values()][0];
    assert.equal(row.won, want, `up=${up} exit=${exit}`);
  }
});

test('a flat outcome is a tie, not a win for DOWN', async () => {
  // Without this, every DOWN call collects a free win on any pegged asset.
  const { db, docs } = fakeDb();
  await recordCalls(db, [{ sym: 'USDT', price: 1, up: false, targets: {} }], ['24H'], NOW);
  const r = await gradeCalls(db, { USDT: 1 }, NOW + 25 * 3_600_000);
  assert.equal(r.ties, 1);
  assert.equal(r.graded, 0);
  assert.equal([...docs.values()][0].won, null);
});

test('a coin that left the universe is voided, not graded', async () => {
  const { db } = fakeDb();
  await recordCalls(db, [{ sym: 'GONE', price: 5, up: true, targets: {} }], ['24H'], NOW);
  const r = await gradeCalls(db, {}, NOW + 25 * 3_600_000);
  assert.equal(r.voided, 1);
  assert.equal(r.graded, 0);
});

test('hit rate is withheld until there are enough graded calls', async () => {
  const { db } = fakeDb();
  // 50 calls, all winners. A 100% hit rate is still not evidence at n=50:
  // the interval on a coin flip that wide covers almost everything.
  const prices: Record<string, number> = {};
  for (let i = 0; i < 50; i++) {
    prices[`C${i}`] = 110;
    await recordCalls(db, [{ sym: `C${i}`, price: 100, up: true, targets: {} }],
                      ['24H'], NOW + i * 25 * 3_600_000);
  }
  await gradeCalls(db, prices, NOW + 10_000 * 3_600_000);
  const day = (await scorecard(db)).find((r) => r.horizon === '24H')!;
  assert.equal(day.graded, 50);
  assert.equal(day.correct, 50);
  assert.equal(day.hitRate, null, 'below the minimum, no rate is published');
});

test('hit rate appears once the sample is large enough, and excludes ties', async () => {
  const { db } = fakeDb();
  const prices: Record<string, number> = {};
  const N = 200;
  for (let i = 0; i < N; i++) {
    // 150 winners, 50 losers => 75%.
    prices[`C${i}`] = i < 150 ? 110 : 90;
    await recordCalls(db, [{ sym: `C${i}`, price: 100, up: true, targets: {} }],
                      ['24H'], NOW + i * 25 * 3_600_000);
  }
  await gradeCalls(db, prices, NOW + 100_000 * 3_600_000);
  const day = (await scorecard(db)).find((r) => r.horizon === '24H')!;
  assert.equal(day.graded, N);
  assert.equal(day.correct, 150);
  assert.equal(day.hitRate, 0.75);
});


test('the running totals survive being graded in separate batches', () => {
  // The counters replaced a full scan, so a lost delta is a permanently wrong
  // published hit rate rather than a number that self-corrects next run.
  return (async () => {
    const { db } = fakeDb();
    const prices: Record<string, number> = {};
    for (let i = 0; i < 20; i++) {
      prices[`A${i}`] = 110;
      await recordCalls(db, [{ sym: `A${i}`, price: 100, up: true, targets: {} }],
                        ['24H'], NOW + i * 25 * 3_600_000);
    }
    // After every A call is placed AND due.
    await gradeCalls(db, prices, NOW + 600 * 3_600_000);

    for (let i = 0; i < 20; i++) {
      prices[`B${i}`] = 90;
      await recordCalls(db, [{ sym: `B${i}`, price: 100, up: true, targets: {} }],
                        ['24H'], NOW + (700 + i * 25) * 3_600_000);
    }
    await gradeCalls(db, prices, NOW + 1300 * 3_600_000);

    const day = (await scorecard(db)).find((r) => r.horizon === '24H')!;
    assert.equal(day.graded, 40, 'both runs counted');
    assert.equal(day.correct, 20, 'only the winners');
    // The counters are right; the RATE is still withheld at n=40, which is
    // the threshold doing its job rather than a counting failure.
    assert.equal(day.hitRate, null);
  })();
});

test('ties and voids never reach the totals', async () => {
  const { db } = fakeDb();
  await recordCalls(db, [{ sym: 'FLAT', price: 1, up: false, targets: {} }], ['24H'], NOW);
  await recordCalls(db, [{ sym: 'GONE', price: 5, up: true, targets: {} }],
                    ['24H'], NOW + 25 * 3_600_000);
  await gradeCalls(db, { FLAT: 1 }, NOW + 100 * 3_600_000);
  const day = (await scorecard(db)).find((r) => r.horizon === '24H')!;
  assert.equal(day.graded, 0, 'a tie and a void are not results');
  assert.equal(day.correct, 0);
});
