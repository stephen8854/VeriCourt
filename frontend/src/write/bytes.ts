/**
 * Byte helpers and a minimal, strict RLP codec (Ethereum Yellow Paper,
 * appendix B). Used only to check a locally signed legacy transaction against
 * the approved request before the SDK may broadcast it. No hashing, no keys.
 */
export type Hex = `0x${string}`;

const HEX_BODY = /^(?:[0-9a-fA-F]{2})*$/;

export function isHex(value: unknown): value is Hex {
  return typeof value === "string" && value.startsWith("0x") && HEX_BODY.test(value.slice(2));
}

export function hexToBytes(hex: string): Uint8Array {
  if (!isHex(hex)) throw new Error("not an even-length 0x-prefixed hex string");
  const out = new Uint8Array((hex.length - 2) / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): Hex {
  let s = "0x";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s as Hex;
}

/** Big-endian unsigned integer with no leading zero bytes (RLP canonical form). */
export function bigintToBytes(n: bigint): Uint8Array {
  if (n < 0n) throw new Error("negative integer");
  if (n === 0n) return new Uint8Array(0);
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  return hexToBytes(`0x${hex}`);
}

export function bytesToBigint(bytes: Uint8Array): bigint {
  return bytes.length === 0 ? 0n : BigInt(bytesToHex(bytes));
}

export function sameAddress(a: unknown, b: unknown): boolean {
  return typeof a === "string" && typeof b === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) && a.toLowerCase() === b.toLowerCase();
}

// ---------------------------------------------------------------------------
// RLP
// ---------------------------------------------------------------------------

export type RlpItem = Uint8Array | RlpItem[];

function lengthPrefix(len: number, offset: number): Uint8Array {
  if (len < 56) return Uint8Array.of(offset + len);
  const lenBytes = bigintToBytes(BigInt(len));
  return Uint8Array.of(offset + 55 + lenBytes.length, ...lenBytes);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function rlpEncode(item: RlpItem): Uint8Array {
  if (item instanceof Uint8Array) {
    if (item.length === 1 && (item[0] ?? 0x80) < 0x80) return item;
    return concat([lengthPrefix(item.length, 0x80), item]);
  }
  const body = concat(item.map(rlpEncode));
  return concat([lengthPrefix(body.length, 0xc0), body]);
}

export class RlpError extends Error {}

/** Decodes one item that must span the whole input. Rejects non-canonical encodings. */
export function rlpDecode(input: Uint8Array): RlpItem {
  const [item, end] = decodeAt(input, 0);
  if (end !== input.length) throw new RlpError("trailing bytes after RLP item");
  return item;
}

function readLength(input: Uint8Array, at: number, lenOfLen: number): number {
  if (at + lenOfLen > input.length) throw new RlpError("truncated RLP length");
  const bytes = input.subarray(at, at + lenOfLen);
  if (bytes[0] === 0) throw new RlpError("non-canonical RLP length (leading zero)");
  const len = Number(bytesToBigint(bytes));
  if (len < 56) throw new RlpError("non-canonical RLP length (long form for short item)");
  return len;
}

function decodeAt(input: Uint8Array, at: number): [RlpItem, number] {
  const prefix = input[at];
  if (prefix === undefined) throw new RlpError("truncated RLP input");
  if (prefix < 0x80) return [input.subarray(at, at + 1), at + 1];
  if (prefix < 0xc0) {
    let start: number;
    let len: number;
    if (prefix <= 0xb7) {
      len = prefix - 0x80;
      start = at + 1;
      const only = input[start];
      if (len === 1 && only !== undefined && only < 0x80) throw new RlpError("non-canonical single byte");
    } else {
      const lenOfLen = prefix - 0xb7;
      len = readLength(input, at + 1, lenOfLen);
      start = at + 1 + lenOfLen;
    }
    if (start + len > input.length) throw new RlpError("truncated RLP string");
    return [input.subarray(start, start + len), start + len];
  }
  let start: number;
  let len: number;
  if (prefix <= 0xf7) {
    len = prefix - 0xc0;
    start = at + 1;
  } else {
    const lenOfLen = prefix - 0xf7;
    len = readLength(input, at + 1, lenOfLen);
    start = at + 1 + lenOfLen;
  }
  const end = start + len;
  if (end > input.length) throw new RlpError("truncated RLP list");
  const items: RlpItem[] = [];
  let cursor = start;
  while (cursor < end) {
    const [item, next] = decodeAt(input, cursor);
    items.push(item);
    cursor = next;
  }
  if (cursor !== end) throw new RlpError("RLP list length mismatch");
  return [items, end];
}

// ---------------------------------------------------------------------------
// Legacy (type 0, EIP-155) signed transactions
// ---------------------------------------------------------------------------

export interface LegacySignedTransaction {
  nonce: bigint;
  gasPrice: bigint;
  gas: bigint;
  to: Hex | null;
  value: bigint;
  data: Hex;
  chainId: bigint | null;
}

function scalar(item: RlpItem | undefined, name: string): bigint {
  if (!(item instanceof Uint8Array)) throw new RlpError(`${name} is not a byte string`);
  if (item.length > 0 && item[0] === 0) throw new RlpError(`${name} has a leading zero byte`);
  return bytesToBigint(item);
}

/** Parses `rlp([nonce, gasPrice, gas, to, value, data, v, r, s])`. Signature values are not verified. */
export function parseLegacySignedTransaction(serialized: string): LegacySignedTransaction {
  const bytes = hexToBytes(serialized);
  if ((bytes[0] ?? 0) < 0xc0) throw new RlpError("not a legacy (RLP list) transaction");
  const item = rlpDecode(bytes);
  if (!Array.isArray(item) || item.length !== 9) throw new RlpError("a legacy transaction has 9 fields");
  const to = item[3];
  const data = item[5];
  if (!(to instanceof Uint8Array) || (to.length !== 0 && to.length !== 20)) throw new RlpError("invalid `to` field");
  if (!(data instanceof Uint8Array)) throw new RlpError("invalid `data` field");
  const v = scalar(item[6], "v");
  return {
    nonce: scalar(item[0], "nonce"),
    gasPrice: scalar(item[1], "gasPrice"),
    gas: scalar(item[2], "gas"),
    to: to.length === 0 ? null : bytesToHex(to),
    value: scalar(item[4], "value"),
    data: bytesToHex(data),
    chainId: v >= 35n ? (v - 35n) / 2n : null,
  };
}
