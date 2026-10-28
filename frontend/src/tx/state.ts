/**
 * Write-transaction state model. Pure functions, no I/O. Nothing in the
 * shipped UI drives it yet: writes stay disabled (config/network.ts).
 *
 * Rules:
 * - There is no retry event. A write whose sending is uncertain
 *   (submission_uncertain), or whose outcome could not be observed
 *   (timed_out_unknown, read_failure), stays blocked until a read-only
 *   reconciliation (write/reconcile.ts) proves it was NOT sent
 *   (RECONCILED_NOT_SENT) or finds its transaction (RECONCILED_FOUND).
 *   `create_case` and `submit_evidence` are not idempotent in the contract.
 * - A transaction that is still moving (pending, accepted, or a non-final
 *   failure, disagreement or undetermined round) blocks new writes, so a
 *   transaction that later succeeds cannot be duplicated.
 * - Accepted is not final, and final is not success: success (`verified`)
 *   needs finality AND a post-finality read showing the intended effect.
 */
import type { TxCategory } from "./classify";

export type TxPhase =
  | "idle"
  | "preparing"
  /** The request is with the wallet (or the test signer). */
  | "awaiting_wallet"
  /** The wallet declined (4001). Nothing was sent. */
  | "rejected"
  /** Provably not sent: failed or refused before any request left the guard, or reconciliation proved it. */
  | "not_sent"
  /** A transaction hash came back. Not success. */
  | "submitted"
  /** Something may have been sent; no hash. */
  | "submission_uncertain"
  | "pending"
  | "accepted"
  | "execution_failed"
  | "validator_disagreement"
  | "undetermined"
  /** Finalized with a successful execution; the post-finality read is still due. */
  | "finalized"
  /** Finalized as a failed execution, a disagreement or an undetermined result. */
  | "finalized_unsuccessful"
  /** Finalized, and a latest-final read showed the intended effect. The only success state. */
  | "verified"
  /** Finalized, but the latest-final read did not show the intended effect. */
  | "verification_mismatch"
  /**
   * Reached only from an uncertain phase: no transaction id is known, but a
   * latest-final read shows the intended effect (e.g. exactly the new case).
   * The write happened; it must not be repeated. Not "verified": the
   * transaction itself was never observed.
   */
  | "confirmed_by_state"
  | "timed_out_unknown"
  | "read_failure";

export interface TxState {
  phase: TxPhase;
  txHash: string | null;
  /** Last non-fatal message (e.g. why nothing was sent). */
  note: string | null;
}

export type TxEvent =
  | { type: "PREPARE" }
  | { type: "REQUEST_WALLET" }
  | { type: "WALLET_REJECTED" }
  | { type: "NOT_SENT"; message: string }
  | { type: "SUBMITTED"; txHash: string }
  | { type: "SUBMISSION_UNCERTAIN"; message: string }
  | { type: "NOT_FOUND_YET" }
  | { type: "OBSERVED"; category: TxCategory; final?: boolean }
  | { type: "POLL_TIMED_OUT" }
  | { type: "READ_FAILED" }
  | { type: "VERIFIED"; detail?: string }
  | { type: "VERIFICATION_MISMATCH"; message: string }
  | { type: "RECONCILED_NOT_SENT"; basis: string }
  | { type: "RECONCILED_FOUND"; txHash: string }
  | { type: "RECONCILED_EFFECT_FINAL"; basis: string }
  | { type: "RESET" };

export const INITIAL_TX_STATE: TxState = { phase: "idle", txHash: null, note: null };

/** States a user may clear with RESET: the write's outcome is known and nothing is still moving. */
export const SETTLED_PHASES: readonly TxPhase[] = [
  "idle",
  "rejected",
  "not_sent",
  "finalized_unsuccessful",
  "verified",
  "verification_mismatch",
  "confirmed_by_state",
];

/** States in which a new write must not start (everything not settled). */
export const BLOCKING_PHASES: readonly TxPhase[] = [
  "preparing",
  "awaiting_wallet",
  "submitted",
  "submission_uncertain",
  "pending",
  "accepted",
  "execution_failed",
  "validator_disagreement",
  "undetermined",
  "finalized",
  "timed_out_unknown",
  "read_failure",
];

/** States that need a read-only reconciliation before anything else may happen. */
export const UNCERTAIN_PHASES: readonly TxPhase[] = ["submission_uncertain", "timed_out_unknown", "read_failure"];

export function canStartWrite(state: TxState): boolean {
  return state.phase === "idle";
}

/** Phases in which a status observation is expected. */
const OBSERVABLE: readonly TxPhase[] = ["submitted", "pending", "accepted", "execution_failed", "validator_disagreement", "undetermined"];

function phaseFor(category: TxCategory, final: boolean): TxPhase {
  switch (category) {
    case "PENDING":
      return "pending";
    case "ACCEPTED_SUCCESS":
      return "accepted";
    case "FINALIZED_SUCCESS":
      return "finalized";
    case "ACCEPTED_EXECUTION_FAILED":
      return "execution_failed";
    case "FINALIZED_EXECUTION_FAILED":
      return "finalized_unsuccessful";
    case "VALIDATOR_DISAGREEMENT":
      return final ? "finalized_unsuccessful" : "validator_disagreement";
    case "UNDETERMINED":
      return final ? "finalized_unsuccessful" : "undetermined";
    case "UNRECOGNIZED":
      return "read_failure";
  }
}

export class InvalidTransition extends Error {}

function invalid(state: TxState, event: TxEvent): never {
  throw new InvalidTransition(`event ${event.type} is not allowed in phase ${state.phase}`);
}

export function txReducer(state: TxState, event: TxEvent): TxState {
  const p = state.phase;
  switch (event.type) {
    case "PREPARE":
      return p === "idle" ? { phase: "preparing", txHash: null, note: null } : invalid(state, event);
    case "REQUEST_WALLET":
      return p === "preparing" ? { ...state, phase: "awaiting_wallet" } : invalid(state, event);
    case "WALLET_REJECTED":
      return p === "awaiting_wallet"
        ? { phase: "rejected", txHash: null, note: "The wallet request was rejected. Nothing was sent." }
        : invalid(state, event);
    case "NOT_SENT":
      return p === "preparing" || p === "awaiting_wallet"
        ? { phase: "not_sent", txHash: null, note: event.message }
        : invalid(state, event);
    case "SUBMITTED":
      return p === "awaiting_wallet" ? { phase: "submitted", txHash: event.txHash, note: null } : invalid(state, event);
    case "SUBMISSION_UNCERTAIN":
      return p === "awaiting_wallet" ? { ...state, phase: "submission_uncertain", note: event.message } : invalid(state, event);
    case "NOT_FOUND_YET":
      // Right after submission a lookup may not find the transaction yet; the poll deadline still applies.
      return p === "submitted" ? { ...state, note: "Not found yet." } : invalid(state, event);
    case "OBSERVED": {
      if (!OBSERVABLE.includes(p)) return invalid(state, event);
      const next = phaseFor(event.category, event.final === true);
      // An accepted write can only move on to finality (or stay accepted); it never "un-succeeds".
      if (p === "accepted" && next !== "finalized" && next !== "accepted") return invalid(state, event);
      return { ...state, phase: next, note: null };
    }
    case "POLL_TIMED_OUT":
      return OBSERVABLE.includes(p) ? { ...state, phase: "timed_out_unknown" } : invalid(state, event);
    case "READ_FAILED":
      return OBSERVABLE.includes(p) ? { ...state, phase: "read_failure" } : invalid(state, event);
    case "VERIFIED":
      return p === "finalized" ? { ...state, phase: "verified", note: event.detail ?? null } : invalid(state, event);
    case "VERIFICATION_MISMATCH":
      return p === "finalized" ? { ...state, phase: "verification_mismatch", note: event.message } : invalid(state, event);
    case "RECONCILED_NOT_SENT":
      return p === "submission_uncertain"
        ? { phase: "not_sent", txHash: null, note: `Read-only reconciliation showed the write was not sent: ${event.basis}.` }
        : invalid(state, event);
    case "RECONCILED_EFFECT_FINAL":
      return UNCERTAIN_PHASES.includes(p)
        ? { phase: "confirmed_by_state", txHash: null, note: `The write's effect is final in contract state: ${event.basis}. It must not be repeated.` }
        : invalid(state, event);
    case "RECONCILED_FOUND":
      return UNCERTAIN_PHASES.includes(p) ? { phase: "submitted", txHash: event.txHash, note: null } : invalid(state, event);
    case "RESET":
      return SETTLED_PHASES.includes(p) ? INITIAL_TX_STATE : invalid(state, event);
  }
}

/** How far each phase's mapping has been verified (reported, not enforced). */
export const PHASE_VERIFICATION: Record<TxPhase, string> = {
  idle: "local state only",
  preparing: "local state only",
  awaiting_wallet: "local state only; wallet behaviour unverified",
  rejected: "EIP-1193 code 4001; tested with mock wallets only",
  not_sent: "guard journal (write/guard.ts), tested offline against the real genlayer-js 1.1.8 write path with mocks",
  submitted:
    "UNVERIFIED in JS: genlayer-js 1.1.8 returns the eth_sendTransaction result for wallet writes on Studio; whether it is the GenLayer transaction id is unverified for genlayer-js (offline evidence for the genlayer-py path only, Phase 3.5 §1.4)",
  submission_uncertain: "local; reconciliation rules tested offline, never exercised on StudioNet",
  pending: "status names verified from genlayer-js types and StudioNet (Python harness)",
  accepted: "classification verified on StudioNet via genlayer-py (Phases 2.14-2.17C) and the live genlayer-js read shape (Phase 3.3)",
  execution_failed: "classification from SDK enums; never observed on StudioNet",
  validator_disagreement: "verified on a real StudioNet transaction (Phase 2.8 raw response)",
  undetermined: "classification from SDK enums; v2 never observed on StudioNet",
  finalized: "classification verified on StudioNet via genlayer-py and the Phase 3.3 genlayer-js read",
  finalized_unsuccessful: "classification from SDK enums and `final` flag; never observed on StudioNet",
  verified: "post-finality latest-final read verified for genlayer-py writes (Phases 2.14-2.17C); JS write path unverified",
  verification_mismatch: "local state only",
  confirmed_by_state: "local; reconciliation by latest-final contract reads, tested offline only",
  timed_out_unknown: "local deadline; harness behaviour tested offline",
  read_failure: "local; harness behaviour tested offline",
};
