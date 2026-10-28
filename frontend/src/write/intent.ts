/**
 * A write intent: the exact request one user-approved operation may make.
 *
 * The expected calldata is rebuilt from the same exported genlayer-js 1.1.8
 * helpers `writeContract` uses (dist/index.js 678-687:
 * `serialize([encode(makeCalldataObject(method, args, kwargs)), leaderOnly])`),
 * then wrapped in the V5 `addTransaction` call. The guard compares requests
 * byte-for-byte against it, so any other method, argument, recipient, sender
 * or encoding (including the SDK's V6 fallback) is refused.
 *
 * `consensusAddress` is where the request is expected to go. With
 * `studionetWriteParams()` it is the SDK's static studionet
 * `consensusMainContract` (0xb7278A61…), which is what writeContract will use.
 * StudioNet reports 0x0 for that contract and earlier genlayer-py writes went
 * to 0x0 (Phase 3.5 §2). This module does NOT resolve that discrepancy; it only
 * makes sure the request goes exactly where the intent says.
 */
import { abi } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { ADD_TRANSACTION_V5_SELECTOR, encodeAddTransactionV5 } from "./addTransaction";
import type { Hex } from "./bytes";

import { CONTRACT_WRITE_METHODS, type ContractWriteMethod } from "./methods";

export { CONTRACT_WRITE_METHODS, type ContractWriteMethod };

export type CalldataArg = Parameters<typeof abi.calldata.encode>[0];

export interface ChainWriteParams {
  chainId: number;
  consensusAddress: Hex;
  numOfInitialValidators: bigint;
  maxRotations: bigint;
}

/** The values genlayer-js 1.1.8 itself will use for a studionet writeContract. */
export function studionetWriteParams(): ChainWriteParams {
  return {
    chainId: studionet.id,
    consensusAddress: studionet.consensusMainContract?.address as Hex,
    numOfInitialValidators: BigInt(studionet.defaultNumberOfInitialValidators),
    maxRotations: BigInt(studionet.defaultConsensusMaxRotations),
  };
}

export interface WriteIntentInput {
  operationId: string;
  chain: ChainWriteParams;
  sender: Hex;
  contractAddress: Hex;
  method: ContractWriteMethod;
  args: readonly CalldataArg[];
  /** Pre-send nonce from a read-only check; when set, the request must carry it. */
  expectedNonce?: bigint;
}

export interface WriteIntent {
  readonly operationId: string;
  readonly chainId: number;
  readonly sender: Hex;
  readonly consensusAddress: Hex;
  readonly contractAddress: Hex;
  readonly method: ContractWriteMethod;
  /** RLP of [genvm calldata, leaderOnly=false]: the `_txData` argument. */
  readonly txData: Hex;
  /** Full `addTransaction` calldata the request must carry, lowercase. */
  readonly calldata: Hex;
  readonly selector: typeof ADD_TRANSACTION_V5_SELECTOR;
  readonly expectedNonce: bigint | null;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function encodeContractCall(method: ContractWriteMethod, args: readonly CalldataArg[]): Hex {
  const call = abi.calldata.makeCalldataObject(method, [...args], undefined);
  return abi.transactions.serialize([abi.calldata.encode(call), false]) as Hex;
}

export function buildWriteIntent(input: WriteIntentInput): WriteIntent {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.operationId)) throw new Error("operationId must be 1-64 safe characters");
  if (!(CONTRACT_WRITE_METHODS as readonly string[]).includes(input.method)) throw new Error("not a contract write method");
  for (const [name, value] of [
    ["sender", input.sender],
    ["contractAddress", input.contractAddress],
    ["consensusAddress", input.chain.consensusAddress],
  ] as const) {
    if (!ADDRESS.test(value)) throw new Error(`${name} is not an address`);
  }
  if (!Number.isSafeInteger(input.chain.chainId) || input.chain.chainId <= 0) throw new Error("invalid chainId");
  const txData = encodeContractCall(input.method, input.args);
  const calldata = encodeAddTransactionV5({
    sender: input.sender,
    recipient: input.contractAddress,
    numOfInitialValidators: input.chain.numOfInitialValidators,
    maxRotations: input.chain.maxRotations,
    txData,
  }).toLowerCase() as Hex;
  return Object.freeze({
    operationId: input.operationId,
    chainId: input.chain.chainId,
    sender: input.sender,
    consensusAddress: input.chain.consensusAddress,
    contractAddress: input.contractAddress,
    method: input.method,
    txData,
    calldata,
    selector: ADD_TRANSACTION_V5_SELECTOR,
    expectedNonce: input.expectedNonce ?? null,
  });
}
