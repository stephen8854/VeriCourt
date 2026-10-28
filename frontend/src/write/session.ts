/**
 * One write lane: the transaction state model plus at most one guard.
 * - `begin` only works when the state model allows a new write (idle), so a
 *   second click, a second tab action through the same session, or a write
 *   after an uncertain one is refused.
 * - Each operation gets a fresh single-use guard; it is never re-armed.
 * - An uncertain outcome stays blocked until `reconcile` resolves it.
 *
 * In-memory only. A browser UI must also persist the pending record (e.g.
 * persistent browser storage) so a reload cannot bypass the block (Phase 3.5 §5); that is
 * not implemented because nothing in the UI uses this yet.
 */
import { INITIAL_TX_STATE, UNCERTAIN_PHASES, canStartWrite, txReducer, type TxEvent, type TxState } from "../tx/state";
import { WriteGuard } from "./guard";
import type { WriteIntent } from "./intent";
import { reconcile, type ReconciliationEvidence, type ReconciliationResult } from "./reconcile";
import { runGuardedWrite, type RunOptions, type WriteOutcome } from "./runner";

export function outcomeToEvent(outcome: WriteOutcome): TxEvent {
  switch (outcome.kind) {
    case "not_sent":
      return { type: "NOT_SENT", message: `Nothing was sent: ${outcome.reason}.` };
    case "rejected":
      return { type: "WALLET_REJECTED" };
    case "submitted":
      return { type: "SUBMITTED", txHash: outcome.txHash };
    case "uncertain":
      return { type: "SUBMISSION_UNCERTAIN", message: `The write may have been sent (${outcome.reason}). Writes are blocked until a read-only check resolves it.` };
  }
}

export class WriteBlocked extends Error {}

export class WriteSession {
  private tx: TxState = INITIAL_TX_STATE;
  private guard: WriteGuard | null = null;

  constructor(private readonly now: () => number = () => Date.now()) {}

  get state(): TxState {
    return this.tx;
  }

  get currentGuard(): WriteGuard | null {
    return this.guard;
  }

  private dispatch(event: TxEvent) {
    this.tx = txReducer(this.tx, event);
  }

  /** Starts an operation and returns its single-use guard. Throws when a write may not start. */
  begin(intent: WriteIntent): WriteGuard {
    if (!canStartWrite(this.tx)) throw new WriteBlocked(`a write cannot start in phase ${this.tx.phase}`);
    this.dispatch({ type: "PREPARE" });
    this.guard = new WriteGuard(intent, this.now);
    return this.guard;
  }

  /** Runs the SDK call for the current operation. One call per operation. */
  async run(submit: () => Promise<unknown>, options: RunOptions): Promise<WriteOutcome> {
    const guard = this.guard;
    if (guard === null || this.tx.phase !== "preparing") throw new WriteBlocked("no prepared operation");
    this.dispatch({ type: "REQUEST_WALLET" });
    const { outcome } = await runGuardedWrite(guard, submit, options);
    this.dispatch(outcomeToEvent(outcome));
    return outcome;
  }

  /** Abandons a prepared operation before anything was requested. */
  abandon(reason: string): void {
    if (this.tx.phase !== "preparing" || this.guard === null) throw new WriteBlocked("nothing to abandon");
    this.guard.disarm(reason);
    this.dispatch({ type: "NOT_SENT", message: `Nothing was sent: ${reason}.` });
  }

  /** Status observations, poll deadlines and the post-finality check. */
  apply(event: Extract<TxEvent, { type: "OBSERVED" | "NOT_FOUND_YET" | "POLL_TIMED_OUT" | "READ_FAILED" | "VERIFIED" | "VERIFICATION_MISMATCH" }>): void {
    this.dispatch(event);
  }

  /** Read-only reconciliation. Only a positive result changes the state. */
  reconcile(evidence: Omit<ReconciliationEvidence, "snapshot">): ReconciliationResult {
    if (this.guard === null) throw new WriteBlocked("no operation to reconcile");
    this.guard.disarm("reconciliation");
    const result = reconcile({ ...evidence, snapshot: this.guard.snapshot() });
    if (result.kind === "not_sent" && this.tx.phase === "submission_uncertain") {
      this.dispatch({ type: "RECONCILED_NOT_SENT", basis: result.basis });
    } else if (result.kind === "found" && UNCERTAIN_PHASES.includes(this.tx.phase)) {
      this.dispatch({ type: "RECONCILED_FOUND", txHash: result.txHash });
    } else if (result.kind === "effect_final" && UNCERTAIN_PHASES.includes(this.tx.phase)) {
      this.dispatch({ type: "RECONCILED_EFFECT_FINAL", basis: result.basis });
    }
    return result;
  }

  reset(): void {
    this.dispatch({ type: "RESET" });
    this.guard = null;
  }
}
