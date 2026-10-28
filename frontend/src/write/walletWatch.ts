/**
 * Closes a guarded operation if the wallet's account, chain or connection
 * changes while it runs. Before the request is forwarded this prevents the
 * send (the guard refuses once closed). After it is forwarded nothing can be
 * withdrawn: the wallet prompt stays the wallet's, and the outcome is judged
 * from the journal and, if needed, read-only reconciliation.
 */
import { subscribeToWallet, type Eip1193Provider } from "../wallet/eip1193";
import type { WriteGuard } from "./guard";

export function watchWalletDuringOperation(provider: Eip1193Provider, guard: WriteGuard): { supported: boolean; stop: () => void } {
  const sub = subscribeToWallet(provider, {
    onAccountsChanged: () => guard.disarm("the wallet account changed during the operation"),
    onChainChanged: () => guard.disarm("the wallet network changed during the operation"),
    onDisconnect: () => guard.disarm("the wallet disconnected during the operation"),
  });
  return { supported: sub.supported, stop: sub.unsubscribe };
}
