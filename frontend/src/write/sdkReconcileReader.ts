/**
 * genlayer-js 1.1.8 implementation of ReconciliationReader: reads only.
 * No account and no provider are configured, so the SDK has nothing to sign
 * with and routes every call to the RPC (dist/index.js 2377-2419). Calls are
 * bounded by gatherEvidence's timeouts. `endpoint` is not passed (createClient
 * would mutate the shared chain object).
 */
import { createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import type { TransactionHash, TransactionHashVariant } from "genlayer-js/types";
import type { ReconciliationReader } from "./reconcileReader";

type ClientChain = NonNullable<NonNullable<Parameters<typeof createClient>[0]>["chain"]>;

export function createSdkReconciliationReader(): ReconciliationReader {
  const client = createClient({ chain: studionet as unknown as ClientChain });
  return {
    getTransaction: (hash) => client.getTransaction({ hash: hash as TransactionHash }),
    getTransactionCount: (address, block) => client.request({ method: "eth_getTransactionCount", params: [address, block] } as never),
    readContract: (address, method, args, variant) =>
      client.readContract({
        address,
        functionName: method,
        args: [...args] as never,
        transactionHashVariant: variant as unknown as TransactionHashVariant,
      }),
  };
}
