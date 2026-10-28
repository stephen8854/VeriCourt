/**
 * Strict encoder/decoder for the consensus call genlayer-js 1.1.8 sends on
 * StudioNet: `addTransaction(address,address,uint256,uint256,bytes)` (the SDK's
 * ADD_TRANSACTION_ABI_V5, dist/index.js 893-907). The studionet chain ABI has
 * 5 inputs, so V5 is the SDK's primary encoding and V6 (with `_validUntil`) its
 * fallback (dist/index.js 963-972). Only V5 is accepted here: a V6 request is
 * the fallback the guard must refuse.
 *
 * The selector is a recorded constant, not recomputed (no keccak dependency):
 * it was decoded from the Phase 2.8 StudioNet transaction with the SDK's own
 * ABI (Phase 3.5), and the tests check it against the SDK's live encoding.
 */
import { bigintToBytes, bytesToBigint, bytesToHex, hexToBytes, isHex, type Hex } from "./bytes";

export const ADD_TRANSACTION_V5_SELECTOR = "0x27241a99";

export interface AddTransactionArgs {
  sender: Hex;
  recipient: Hex;
  numOfInitialValidators: bigint;
  maxRotations: bigint;
  txData: Hex;
}

const WORD = 32;

function word(value: Uint8Array): Uint8Array {
  if (value.length > WORD) throw new Error("value wider than 32 bytes");
  const out = new Uint8Array(WORD);
  out.set(value, WORD - value.length);
  return out;
}

function addressWord(address: string): Uint8Array {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("invalid address");
  return word(hexToBytes(address));
}

export function encodeAddTransactionV5(args: AddTransactionArgs): Hex {
  const payload = hexToBytes(args.txData);
  const padded = new Uint8Array(Math.ceil(payload.length / WORD) * WORD);
  padded.set(payload);
  const parts = [
    hexToBytes(ADD_TRANSACTION_V5_SELECTOR),
    addressWord(args.sender),
    addressWord(args.recipient),
    word(bigintToBytes(args.numOfInitialValidators)),
    word(bigintToBytes(args.maxRotations)),
    word(bigintToBytes(5n * BigInt(WORD))), // offset of the dynamic `bytes` argument
    word(bigintToBytes(BigInt(payload.length))),
    padded,
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return bytesToHex(out);
}

/** Returns null unless `data` is exactly a canonical V5 addTransaction call. */
export function decodeAddTransactionV5(data: unknown): AddTransactionArgs | null {
  if (!isHex(data) || !data.toLowerCase().startsWith(ADD_TRANSACTION_V5_SELECTOR)) return null;
  const body = hexToBytes(`0x${data.slice(10)}`);
  if (body.length < 6 * WORD || body.length % WORD !== 0) return null;
  const at = (i: number) => body.subarray(i * WORD, (i + 1) * WORD);
  const isAddressWord = (w: Uint8Array) => w.subarray(0, 12).every((b) => b === 0);
  if (!isAddressWord(at(0)) || !isAddressWord(at(1))) return null;
  if (bytesToBigint(at(4)) !== 5n * BigInt(WORD)) return null;
  const len = Number(bytesToBigint(at(5)));
  const paddedLen = Math.ceil(len / WORD) * WORD;
  if (body.length !== 6 * WORD + paddedLen) return null;
  const tail = body.subarray(6 * WORD);
  if (!tail.subarray(len).every((b) => b === 0)) return null;
  return {
    sender: bytesToHex(at(0).subarray(12)),
    recipient: bytesToHex(at(1).subarray(12)),
    numOfInitialValidators: bytesToBigint(at(2)),
    maxRotations: bytesToBigint(at(3)),
    txData: bytesToHex(tail.subarray(0, len)),
  };
}
