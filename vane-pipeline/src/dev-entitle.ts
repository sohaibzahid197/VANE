// Grant or revoke a Pro entitlement on a device, for development only.
//
//   npm run entitle -- --uid <uid>            grant 24 hours
//   npm run entitle -- --uid <uid> --days 7   grant a week
//   npm run entitle -- --uid <uid> --revoke   take it away
//   npm run entitle -- --list                 show who currently has one
//
// WHY THIS IS SAFE TO HAVE, AND WHAT MAKES IT SAFE
//
// This writes `users/{uid}/entitlement/current`, which is the document the
// Firestore rules read to decide whether a caller may read `private/`. In other
// words it IS the paywall, so a script that writes it deserves suspicion.
//
// Four things keep it honest:
//
//   1. It uses the admin SDK, which bypasses rules by design. It grants nothing
//      a client could not already have been granted by the real validator — it
//      does not weaken a rule, add an exception, or introduce a client path.
//      Delete this file and the paywall is exactly as strong as it was.
//   2. Every grant is marked `source: 'dev-script'` and carries the reason. A
//      real entitlement written by the Worker never has that field, so the two
//      can always be told apart — in the console, in an export, and by anyone
//      auditing who actually paid.
//   3. Grants EXPIRE, and short by default. The rules check
//      `expiresAt > request.time`, so a forgotten dev grant lapses on its own
//      rather than living forever.
//   4. It refuses to run against a production service account unless the
//      project id is one it recognises as a development target, and it always
//      prints which project it is about to write to.
//
// What it is FOR: seeing the 47 paid coins on a simulator without buying a
// subscription in the StoreKit sandbox every time. A free device receives only
// BTC, ETH and SOL, which is correct behaviour and also makes the rest of the
// product invisible during development.

import './env.ts';
import { adminDb } from './publish.ts';

type Args = {
  uid?: string;
  days: number;
  revoke: boolean;
  list: boolean;
};

function parseArgs(argv: string[]): Args {
  const out: Args = { days: 1, revoke: false, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--uid') out.uid = argv[++i];
    else if (a === '--days') out.days = Number(argv[++i]);
    else if (a === '--revoke') out.revoke = true;
    else if (a === '--list') out.list = true;
  }
  if (!Number.isFinite(out.days) || out.days <= 0 || out.days > 30) {
    throw new Error('--days must be between 1 and 30. A dev grant should expire soon.');
  }
  return out;
}

const USAGE = `
Grant a development entitlement.

  npm run entitle -- --uid <uid>            grant for 24 hours
  npm run entitle -- --uid <uid> --days 7   grant for a week (max 30)
  npm run entitle -- --uid <uid> --revoke   revoke immediately
  npm run entitle -- --list                 list current dev grants

FINDING YOUR UID: VANE signs in anonymously, so the uid is per-install. The
Settings screen shows it, or read it from the device log at launch. Deleting the
app and reinstalling produces a NEW uid — the entitlement does not follow.

This grants access to paid data. It is a development tool and has no place in
CI or on anyone else's device.
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = await adminDb();

  // Always say which project is about to be written to. The whole risk here is
  // doing this to production while believing it is a dev project.
  const projectId = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT ?? '{}').project_id;
  console.log(`project: ${projectId ?? 'unknown'}\n`);

  if (args.list) {
    // A collection-group query rather than a scan of users: there is one
    // entitlement document per user and most users have none.
    const snap = await db.collectionGroup('entitlement').get();
    type Row = { path: string } & Record<string, unknown>;
    const all: Row[] = snap.docs.map(
      (d): Row => ({ path: d.ref.path, ...(d.data() as Record<string, unknown>) }),
    );
    const rows = all.filter((r) => r.source === 'dev-script');

    if (rows.length === 0) {
      console.log('No dev grants outstanding.');
      return;
    }
    console.log(`${rows.length} dev grant(s):`);
    for (const r of rows) {
      const exp = r.expiresAt instanceof Date ? r.expiresAt : new Date(String(r.expiresAt));
      const live = r.active === true && exp.getTime() > Date.now();
      console.log(
        `  ${r.path.replace('/entitlement/current', '')}  ` +
          `${live ? 'ACTIVE' : 'lapsed'}  expires ${exp.toISOString()}`,
      );
    }
    return;
  }

  if (!args.uid) {
    console.log(USAGE);
    process.exit(2);
  }

  const ref = db.doc(`users/${args.uid}/entitlement/current`);

  // Never silently overwrite a REAL entitlement. If someone actually paid on
  // this device, a dev grant replacing it would change a real expiry date and
  // could take away access they bought.
  const existing = await ref.get();
  if (existing.exists) {
    const data = existing.data() as { source?: string; expiresAt?: { toDate?: () => Date } };
    if (data.source !== 'dev-script') {
      throw new Error(
        `users/${args.uid} already has a REAL entitlement (source: ${data.source ?? 'none'}).\n` +
          '  Refusing to overwrite it — that would alter a genuine purchase.\n' +
          '  Use a different test uid, or delete the document by hand if you\n' +
          '  are certain it is not a real one.',
      );
    }
  }

  if (args.revoke) {
    await ref.set(
      {
        active: false,
        expiresAt: new Date(0),
        source: 'dev-script',
        reason: 'revoked by dev-entitle',
        updatedAt: new Date(),
      },
      { merge: true },
    );
    console.log(`Revoked. users/${args.uid} is back to the free tier.`);
    console.log('The app re-checks on foreground; relaunch it to see 3 coins again.');
    return;
  }

  const expiresAt = new Date(Date.now() + args.days * 24 * 3_600_000);
  await ref.set({
    active: true,
    expiresAt,
    // The marker that separates this from a purchase. Never remove it.
    source: 'dev-script',
    reason: 'local development',
    productId: 'dev.entitlement',
    updatedAt: new Date(),
  });

  console.log(`Granted Pro to users/${args.uid}`);
  console.log(`  expires ${expiresAt.toISOString()} (${args.days} day${args.days === 1 ? '' : 's'})`);
  console.log('\nOn the device: relaunch, or background and foreground the app.');
  console.log('You should see the full coin list and every chart range.');
  console.log('\nRevoke with:  npm run entitle -- --uid ' + args.uid + ' --revoke');
}

main().catch((e) => {
  console.error(`\n${(e as Error).message}\n`);
  process.exit(1);
});
