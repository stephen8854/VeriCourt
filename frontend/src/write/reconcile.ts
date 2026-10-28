/**
 * Read-only reconciliation of an uncertain write (pure decision; the caller
 * gathers the evidence with read calls only and never resubmits).
 *
 * "Not sent" is concluded only from positive evidence:
 * 1. the guard journal shows no transaction left the guarded channels and the
 *    guard is closed; or
 * 2. the wallet explicitly rejected the request (4001), even if late; or
 * 3. an explicit error response, together with an unchanged nonce (latest and
 *    pending), an absent contract effect, and no transaction found by any
 *    known hash, and only once StudioNet's nonce behaviour has been verified.
 *    It is off: StudioNet records nonces but does not validate them
 *    (Phase 3.5A Stage A), so this stays false.
 * "Sent, and its effect is final" is concluded when a latest-final read shows
 * the intended effect after the recorded baseline (`effect_final`): the write
 * must not be repeated even though no transaction id is known.
 * A missing response, a timeout, or "not found" alone is never proof.
 */
import type { Hex } from "./bytes";
import type { GuardSnapshot } from "./guard";

export type LookupEvidence =
  | { kind: "found"; hash: Hex }
  | { kind: "not_found" }
  | { kind: "failed" }
  | { kind: "not_checked" };

export interface NonceEvidence {
  before: bigint | null;
  latest: bigint | null;
  pending: bigint | null;
}

export interface ReconciliationEvidence {
  snapshot: GuardSnapshot;
  /** Lookup of the known hash (if any) with getTransaction. */
  lookup: LookupEvidence;
  nonce: NonceEvidence;
  /**
   * Contract state compared with the intent, counting only changes after the
   * recorded baseline: seen at latest-final, seen only at latest-nonfinal,
   * absent at both, or not checkable.
   */
  contractEffect: ContractEffect;
  /** Human-readable detail of the effect check (e.g. which case matched). */
  effectDetail?: string;
  /** True only after a live test has shown StudioNet advances the sender nonce for a write. */
  nonceTrackingVerified: boolean;
  /** Signer channel: whether the guarded fetch tracked broadcasts. */
  broadcastGuarded: boolean;
}

export type ContractEffect = "observed_final" | "observed_nonfinal" | "absent" | "unknown";

export type ReconciliationResult =
  | { kind: "not_sent"; basis: string }
  | { kind: "found"; txHash: Hex; basis: string }
  | { kind: "effect_final"; basis: string }
  | { kind: "unresolved"; reasons: string[] };

export function knownHashes(snapshot: GuardSnapshot): Hex[] {
  const o = snapshot.outbound;
  const hashes = [o?.hash, o?.broadcast?.hash].filter((h): h is Hex => typeof h === "string");
  return [...new Set(hashes.map((h) => h.toLowerCase() as Hex))];
}

export function reconcile(e: ReconciliationEvidence): ReconciliationResult {
  const s = e.snapshot;
  if (s.armed) return { kind: "unresolved", reasons: ["the guard is still armed; close the operation before reconciling"] };
  const o = s.outbound;
  const hashes = knownHashes(s);

  if (e.lookup.kind === "found") {
    if (!hashes.includes(e.lookup.hash.toLowerCase() as Hex)) {
      return { kind: "unresolved", reasons: ["the transaction found is not one this operation recorded"] };
    }
    return { kind: "found", txHash: e.lookup.hash, basis: "a transaction with the recorded hash exists on the chain" };
  }

  if (o === null) return { kind: "not_sent", basis: "the guard journal shows no transaction request left the guard, and the guard is closed" };
  if (o.channel === "wallet" && o.state === "rejected") return { kind: "not_sent", basis: "the wallet explicitly rejected the request (EIP-1193 4001)" };
  if (o.channel === "signer") {
    if (o.state !== "signed") return { kind: "not_sent", basis: `no signed transaction was released (signer state: ${o.state})` };
    if (o.broadcast === null && e.broadcastGuarded) {
      return { kind: "not_sent", basis: "the signed transaction was never broadcast, and the guarded fetch is closed" };
    }
  }

  const reasons: string[] = [];
  if (e.contractEffect === "observed_final") {
    return { kind: "effect_final", basis: `the intended effect is final in contract state${e.effectDetail ? ` (${e.effectDetail})` : ""}` };
  }
  if (e.contractEffect === "observed_nonfinal") {
    reasons.push("the intended effect is visible but not final yet: check again later, and do not resubmit");
    return { kind: "unresolved", reasons };
  }

  const explicitError =
    (o.channel === "wallet" && o.state === "error") || (o.channel === "signer" && o.broadcast?.state === "rpc_error");
  const nonceUnchanged =
    e.nonce.before !== null && e.nonce.latest === e.nonce.before && e.nonce.pending === e.nonce.before;
  const noHashOrNotFound = hashes.length === 0 || e.lookup.kind === "not_found";
  if (explicitError && e.nonceTrackingVerified && nonceUnchanged && e.contractEffect === "absent" && noHashOrNotFound) {
    return {
      kind: "not_sent",
      basis: "explicit error response, nonce unchanged (latest and pending), contract effect absent, no transaction found",
    };
  }

  if (!explicitError) reasons.push(`the request left the guard and no explicit error came back (state: ${o.broadcast?.state ?? o.state})`);
  if (!e.nonceTrackingVerified) reasons.push("StudioNet nonce behaviour is not yet verified, so the nonce cannot rule out a send");
  if (!nonceUnchanged) reasons.push("the nonce is unknown or has changed");
  if (e.contractEffect !== "absent") reasons.push("the contract effect could not be checked");
  if (hashes.length > 0 && e.lookup.kind !== "not_found") reasons.push("the known hash could not be looked up");
  return { kind: "unresolved", reasons };
}
