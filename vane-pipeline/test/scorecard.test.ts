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
    doc: (path: string) => ({ path }),
    batch: () => ({
      set: (ref: any, data: any) => {
        writes.push({ op: 'set', path: ref.path });
        docs.set(ref.path, data);
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

test('one call per coin, horizon and hour', async () => {
  const { db, docs } = fakeDb();
  const coins = [{ sym: 'BTC', price: 100, up: true, targets: {} }];
  await recordCalls(db, coins, [...HZ], NOW);
  assert.equal(docs.size, 3, 'one per horizon');

  // The refresh runs twice an hour. The second run of the same hour must not
  // record a second opinion, or one view of the market is counted twice.
  await recordCalls(db, coins, [...HZ], NOW + 30 * 60_000);
  assert.equal(docs.size, 3, 'same hour must not add rows');

  await recordCalls(db, coins, [...HZ], NOW + 60 * 60_000);
  assert.equal(docs.size, 6, 'next hour records again');
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
  // 10 calls, all winners. A 100% hit rate off ten samples is not evidence.
  for (let i = 0; i < 10; i++) {
    await recordCalls(db, [{ sym: `C${i}`, price: 100, up: true, targets: {} }],
                      ['24H'], NOW + i * 3_600_000);
  }
  await gradeCalls(db, Object.fromEntries([...Array(10)].map((_, i) => [`C${i}`, 110])),
                   NOW + 40 * 3_600_000);
  const rows = await scorecard(db);
  const day = rows.find((r) => r.horizon === '24H')!;
  assert.equal(day.graded, 10);
  assert.equal(day.correct, 10);
  assert.equal(day.hitRate, null, 'below the minimum, no rate is published');
});

test('hit rate appears once the sample is large enough, and excludes ties', async () => {
  const { db } = fakeDb();
  const prices: Record<string, number> = {};
  for (let i = 0; i < 40; i++) {
    // 30 winners, 10 losers => 75%.
    const up = true;
    prices[`C${i}`] = i < 30 ? 110 : 90;
    await recordCalls(db, [{ sym: `C${i}`, price: 100, up, targets: {} }],
                      ['24H'], NOW + i * 3_600_000);
  }
  await gradeCalls(db, prices, NOW + 100 * 3_600_000);
  const day = (await scorecard(db)).find((r) => r.horizon === '24H')!;
  assert.equal(day.graded, 40);
  assert.equal(day.correct, 30);
  assert.equal(day.hitRate, 0.75);
});
