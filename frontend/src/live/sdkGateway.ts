/**
 * genlayer-js 1.1.8 implementation of the read-only gateway. Loaded lazily
 * (dynamic import) so the SDK is only fetched when the user starts a live check.
 *
 * Verified from the installed SDK source (dist/index.js):
 * - createClient makes no request when called.
 * - With no `account`/`provider`, eth_chainId, gen_call, gen_getContractCode
 *   and eth_getTransactionByHash all go to the chain's RPC URL via fetch; only
 *   wallet methods (eth_accounts, eth_sendTransaction, signing) are routed to a
 *   wallet, and this module never calls them.
 * - The SDK transport sets retryCount 0 and has no timeout; the caller wraps
 *   every call in withTimeout().
 * - `endpoint` is not passed, because createClient would mutate the shared chain object.
 */
import { createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import type { TransactionHash, TransactionHashVariant } from "genlayer-js/types";
import type { ReadOnlyGateway } from "./gateway";

// genlayer-js 1.1.8 declares createClient's `chain` parameter more narrowly than its
// own GenLayerChain type (fails under exactOptionalPropertyTypes), yet at runtime it
// needs the full chain object (isStudio, consensus contracts). Pass the SDK's own
// studionet definition unchanged.
type ClientChain = NonNullable<NonNullable<Parameters<typeof createClient>[0]>["chain"]>;

export function createSdkGateway(): ReadOnlyGateway {
  const client = createClient({ chain: studionet as unknown as ClientChain });
  return {
    chainId: () => client.request({ method: "eth_chainId" }),
    getContractCode: (address) => client.getContractCode(address),
    readContract: (address, method, args, variant) =>
      client.readContract({
        address,
        functionName: method,
        args: [...args],
        transactionHashVariant: variant as unknown as TransactionHashVariant,
      }),
    getTransaction: (hash) => client.getTransaction({ hash: hash as TransactionHash }),
  };
}
