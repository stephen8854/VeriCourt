/**
 * genlayer-js 1.1.8 bindings for the write experiment. Loaded only by the
 * gated experiment panel (dynamic import), so the ordinary bundle has none.
 *
 * Reader: no account, no provider. The SDK cannot sign and routes every call
 * to the StudioNet RPC (dist/index.js 2377-2419).
 *
 * Writer: `account` is the sender ADDRESS STRING and `provider` is the guarded
 * provider. With an address-string account, genlayer-js routes only
 * PROVIDER_METHODS (eth_accounts, eth_requestAccounts, eth_sendTransaction,
 * eth_signTransaction, personal_sign, eth_signTypedData_v4) to
 * `config.provider`, never to window.ethereum while a provider is set, and
 * writeContract uses only eth_sendTransaction among them (once per encoding
 * attempt; the guard admits one). Its reads (nonce, gas estimate, gas price)
 * go to the RPC. An account OBJECT would switch the SDK to its local-signing
 * path, so a non-string sender is refused here.
 * `endpoint` is never passed (createClient would mutate the shared chain object).
 */
import { createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import type { TransactionHash, TransactionHashVariant } from "genlayer-js/types";
import type { Eip1193Provider } from "../wallet/eip1193";
import type { Hex } from "../write/bytes";
import type { ExperimentReader, WriteClient } from "./createCaseFlow";

type ClientConfig = NonNullable<Parameters<typeof createClient>[0]>;

export function createSdkReader(): ExperimentReader {
  const client = createClient({ chain: studionet } as unknown as ClientConfig);
  const rpc = (method: string, params: unknown[] = []) => client.request({ method, params } as never) as Promise<unknown>;
  return {
    chainId: () => rpc("eth_chainId"),
    gasPrice: () => rpc("eth_gasPrice"),
    getContractCode: (address) => client.getContractCode(address),
    getTransaction: (hash) => client.getTransaction({ hash: hash as TransactionHash }),
    getTransactionCount: (address, block) => rpc("eth_getTransactionCount", [address, block]),
    readContract: (address, method, args, variant) =>
      client.readContract({ address, functionName: method, args: [...args] as never, transactionHashVariant: variant as unknown as TransactionHashVariant }),
    simulateCreateCase: (sender, contract, args) =>
      client.simulateWriteContract({ account: { address: sender } as never, address: contract, functionName: "create_case", args: [...args] as never }),
    simulateWrite: (sender, contract, method, args) =>
      client.simulateWriteContract({ account: { address: sender } as never, address: contract, functionName: method, args: [...args] as never }),
  };
}

export function createSdkWriteClient(guarded: Eip1193Provider, sender: Hex): WriteClient {
  if (typeof sender !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(sender)) throw new Error("the write client needs the sender as an address string");
  const client = createClient({ chain: studionet, account: sender, provider: guarded } as unknown as ClientConfig);
  return {
    writeContract: (args) => client.writeContract({ address: args.address, functionName: args.functionName, args: args.args as never, value: args.value }),
  };
}
