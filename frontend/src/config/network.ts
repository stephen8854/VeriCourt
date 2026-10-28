/**
 * Network and contract configuration, isolated in one place.
 *
 * - StudioNet values are those verified in Phases 2.13-2.17C (eth_chainId 61999
 *   at https://studio.genlayer.com/api) and in genlayer-js 1.1.8's chain
 *   definition (chains.studionet: id 61999, isStudio true).
 * - No application deployment exists yet. The contract address stays unset
 *   unless VITE_VERICOURT_CONTRACT_ADDRESS is supplied at build time; contract
 *   features are unavailable until then.
 * - Contract writes are disabled in this build (Phase 3.2).
 */

export const STUDIONET = {
  name: "GenLayer Studio Network",
  chainId: 61999,
  chainIdHex: "0xf22f",
  rpcUrl: "https://studio.genlayer.com/api",
} as const;

export const CONTRACT_WRITES_ENABLED = false as const;

/** Shown next to every disabled write control. */
export const WRITES_DISABLED_REASON =
  "Contract writes are disabled: wallet integration is still being tested and transaction submission has not been approved.";

export type ContractAddressConfig =
  | { status: "unset" }
  | { status: "invalid"; raw: string }
  | { status: "set"; address: `0x${string}` };

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export function parseContractAddress(raw: string | undefined): ContractAddressConfig {
  const value = (raw ?? "").trim();
  if (value === "") return { status: "unset" };
  if (!ADDRESS_PATTERN.test(value) || /^0x0{40}$/.test(value)) return { status: "invalid", raw: value };
  return { status: "set", address: value as `0x${string}` };
}

export const CONTRACT_ADDRESS: ContractAddressConfig = parseContractAddress(
  import.meta.env.VITE_VERICOURT_CONTRACT_ADDRESS as string | undefined,
);
