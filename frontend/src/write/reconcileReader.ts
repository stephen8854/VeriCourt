/**
 * Gathers read-only evidence for reconciling an uncertain write. Never sends,
 * signs or retries anything. Every read is bounded; a failed or timed-out read
 * becomes "unknown"/"failed", never "absent"/"not found".
 */
import { withTimeout } from "../live/errors";
import type { Hex } from "./bytes";
import { matchEffect } from "./effects";
import type { PendingRecord } from "./pendingStore";
import { knownHashes, type ContractEffect, type LookupEvidence, type NonceEvidence, type ReconciliationEvidence } from "./reconcile";

export interface ReconciliationReader {
  /** The transaction, or null/undefined when the node reports it unknown. */
  getTransaction(hash: Hex): Promise<unknown>;
  getTransactionCount(address: Hex, block: "latest" | "pending"): Promise<unknown>;
  readContract(address: Hex, method: string, args: readonly unknown[], variant: "latest-final" | "latest-nonfinal"): Promise<unknown>;
}

const READ_TIMEOUT_MS = 20_000;

function quantity(v: unknown): bigint | null {
  if (typeof v === "string" && /^0x[0-9a-fA-F]+$/.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "bigint") return v;
  return null;
}

async function lookup(reader: ReconciliationReader, hashes: Hex[], timeoutMs: number): Promise<LookupEvidence> {
  if (hashes.length === 0) return { kind: "not_checked" };
  let anyFailed = false;
  for (const h of hashes) {
    try {
      const tx = await withTimeout(reader.getTransaction(h), timeoutMs, `getTransaction ${h}`);
      const got = (tx as { hash?: unknown; tx_id?: unknown } | null | undefined) ?? null;
      if (got !== null && [got.hash, got.tx_id].some((x) => typeof x === "string" && x.toLowerCase() === h.toLowerCase())) {
        return { kind: "found", hash: h };
      }
      if (got !== null) anyFailed = true; // an answer we cannot match is not "not found"
    } catch {
      anyFailed = true;
    }
  }
  return anyFailed ? { kind: "failed" } : { kind: "not_found" };
}

async function nonces(reader: ReconciliationReader, record: PendingRecord, timeoutMs: number): Promise<NonceEvidence> {
  const read = async (block: "latest" | "pending") => {
    try {
      return quantity(await withTimeout(reader.getTransactionCount(record.sender, block), timeoutMs, `nonce ${block}`));
    } catch {
      return null;
    }
  };
  return {
    before: record.nonceBefore === null ? null : BigInt(record.nonceBefore),
    latest: await read("latest"),
    pending: await read("pending"),
  };
}

/** The intended effect at latest-final, then latest-nonfinal (write/effects.ts, per method). */
async function caseEffect(
  reader: ReconciliationReader,
  record: PendingRecord,
  timeoutMs: number,
): Promise<{ effect: ContractEffect; detail: string }> {
  if (record.expectedEffect === null || (record.method === "create_case" && record.baselinePartyCaseCount === null)) {
    return { effect: "unknown", detail: "no effect check is defined for this operation, or no baseline was recorded" };
  }
  const at = async (variant: "latest-final" | "latest-nonfinal") => {
    try {
      return await matchEffect(reader, record, variant, timeoutMs);
    } catch {
      return null;
    }
  };
  const final = await at("latest-final");
  if (final === null) return { effect: "unknown", detail: "latest-final reads failed" };
  if (final.kind === "ambiguous") return { effect: "unknown", detail: final.detail };
  if (final.kind === "match") return { effect: "observed_final", detail: `${final.detail} at latest-final` };
  const nonFinal = await at("latest-nonfinal");
  if (nonFinal === null) return { effect: "unknown", detail: "latest-nonfinal reads failed" };
  if (nonFinal.kind === "ambiguous") return { effect: "unknown", detail: nonFinal.detail };
  if (nonFinal.kind === "match") return { effect: "observed_nonfinal", detail: `${nonFinal.detail} only at latest-nonfinal` };
  return { effect: "absent", detail: `${final.detail} (at either variant)` };
}

export async function gatherEvidence(
  reader: ReconciliationReader,
  record: PendingRecord,
  options: { timeoutMs?: number } = {},
): Promise<Omit<ReconciliationEvidence, "snapshot"> & { hashesChecked: Hex[] }> {
  const timeoutMs = options.timeoutMs ?? READ_TIMEOUT_MS;
  const snapshot = record.guard;
  const hashes = snapshot === null ? [] : knownHashes(snapshot);
  if (record.tx.txHash !== null && !hashes.includes(record.tx.txHash.toLowerCase() as Hex)) hashes.push(record.tx.txHash.toLowerCase() as Hex);
  const effect = await caseEffect(reader, record, timeoutMs);
  return {
    hashesChecked: hashes,
    lookup: await lookup(reader, hashes, timeoutMs),
    nonce: await nonces(reader, record, timeoutMs),
    contractEffect: effect.effect,
    effectDetail: effect.detail,
    nonceTrackingVerified: false,
    broadcastGuarded: false,
  };
}
