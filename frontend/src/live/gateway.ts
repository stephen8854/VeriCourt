/**
 * The ONLY network surface of the live check: four read-only operations.
 * There is deliberately no write, sign, deploy, wallet or network-switch method.
 */

export type HashVariant = "latest-nonfinal" | "latest-final";

export const READ_METHODS = [
  "get_contract_info",
  "get_case_count",
  "get_case",
  "get_case_status",
  "get_case_evidence",
  "get_case_history",
  "get_assessment_status",
  "get_assessment",
  "get_party_case_ids",
] as const;
export type ReadMethod = (typeof READ_METHODS)[number];

export interface ReadOnlyGateway {
  /** JSON-RPC eth_chainId against the StudioNet endpoint (not the wallet). */
  chainId(): Promise<unknown>;
  /** gen_getContractCode: the deployed contract source. */
  getContractCode(address: `0x${string}`): Promise<unknown>;
  /** gen_call (type "read") with an explicit transaction-hash variant. */
  readContract(address: `0x${string}`, method: ReadMethod, args: readonly (string | number)[], variant: HashVariant): Promise<unknown>;
  /** eth_getTransactionByHash via the SDK's Studio path. */
  getTransaction(hash: `0x${string}`): Promise<unknown>;
}

export const GATEWAY_METHODS = ["chainId", "getContractCode", "readContract", "getTransaction"] as const;
