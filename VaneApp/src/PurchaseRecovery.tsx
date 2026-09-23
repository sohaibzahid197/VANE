// Finishes purchases the paywall could not.
//
// A purchase whose server validation failed is deliberately left unfinished,
// so it can be retried. Something has to do that retrying, and it has to be
// able to grant entitlement when it succeeds — which is why this lives INSIDE
// StoreProvider. The equivalent code in App.tsx could not: App renders the
// provider, so it sits outside it and structurally cannot reach setPro. It
// validated, finished the transaction, and left the user on the free tier
// until two more launches had gone by.
//
// It renders nothing. It exists to be inside the provider.

import { useEffect } from 'react';
import { validatePurchase } from './entitlement.ts';
import {
  claimTransaction,
  complete,
  onPurchaseRecovered,
  pendingTransactions,
  releaseTransaction,
  transactionIdOf,
} from './purchases.ts';
import { useStore } from './store.tsx';

export default function PurchaseRecovery() {
  const { setPro } = useStore();

  useEffect(() => {
    let alive = true;

    const handle = async (transaction: unknown) => {
      const id = transactionIdOf(transaction);
      // One purchase, one handler: the launch pull and the event stream can
      // both surface the same transaction, and handling it twice would
      // validate and finish it twice.
      if (!claimTransaction(id)) return;

      const verdict = await validatePurchase(id);
      if (!verdict?.active) {
        // Released so the next launch — or the next event — tries again. The
        // transaction stays unfinished, which is what keeps it recoverable.
        releaseTransaction(id);
        return;
      }

      // Entitlement first, then finish. Finishing drops the transaction from
      // the queue, so the other order loses the purchase if anything fails in
      // between.
      if (alive) setPro(true);
      await complete(transaction);
    };

    // Pull, rather than wait. An interrupted purchase is not guaranteed to be
    // re-emitted, so asking the store outright is the only deterministic way
    // to find one.
    void (async () => {
      for (const tx of await pendingTransactions()) {
        if (!alive) return;
        await handle(tx);
      }
    })();

    const off = onPurchaseRecovered((transaction) => handle(transaction));
    return () => {
      alive = false;
      off();
    };
  }, [setPro]);

  return null;
}
