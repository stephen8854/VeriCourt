/**
 * A write lane whose safety state survives reloads and is shared by tabs.
 *
 * Order of operations for one write (browser-wallet path):
 * 1. `open()` loads the record; anything left mid-operation by a closed page
 *    is re-derived by recoverAfterReload (never "failed" because of a timeout).
 * 2. `begin()` refuses unless: storage works, no unresolved record exists, the
 *    cross-tab lock is free, and (re-read under the lock) still no unresolved
 *    record. It then writes the record (phase preparing) BEFORE returning.
 * 3. `run()` watches the wallet for account/chain/disconnect changes, and runs
 *    the SDK call under the deadline. The guard's observer persists every
 *    journal change; the forward itself is write-ahead (not sent if not saved).
 *    The outcome is persisted; the lock is released.
 * 4. Unresolved outcomes stay recorded and block every tab until
 *    `reconcile()` (read-only) resolves them. There is no retry.
 *
 * Not wired to any UI in this build (writes are disabled).
 */
import { SETTLED_PHASES, UNCERTAIN_PHASES, txReducer, type TxEvent, type TxState } from "../tx/state";
import type { Eip1193Provider } from "../wallet/eip1193";
import { WriteGuard } from "./guard";
import type { WriteIntent } from "./intent";
import {
  PendingStore,
  PendingStoreError,
  blockReason,
  recoverAfterReload,
  type LoadResult,
  type PendingRecord,
} from "./pendingStore";
import { reconcile, type ReconciliationResult } from "./reconcile";
import { gatherEvidence, type ReconciliationReader } from "./reconcileReader";
import { runGuardedWrite, type RunOptions, type WriteOutcome } from "./runner";
import { outcomeToEvent } from "./session";
import { watchWalletDuringOperation } from "./walletWatch";
import type { Release, WriteLock } from "./writeLock";

export class WriteRefused extends Error {}

/**
 * The SDK call finished but its outcome could not be saved. The tab is then
 * blocked for good (`blockedReason`); the stored record, if any, still blocks
 * every other tab (a reload recovers it as uncertain unless it proves otherwise).
 */
export class WriteOutcomeNotRecorded extends Error {
  constructor(readonly outcome: WriteOutcome | null, detail: string) {
    super(`The write's outcome could not be saved (${detail}). Writes are blocked in this tab; reload to recover the stored record.`);
    this.name = "WriteOutcomeNotRecorded";
  }
}

/** Result of the fresh preflight run under the cross-tab lock. */
export interface PreflightResult {
  intent: WriteIntent;
  ctx: BeginContext;
}

export interface BeginContext {
  /** What the effect check should look for (create_case). */
  expectedEffect: PendingRecord["expectedEffect"];
  /** Read-only pre-checks done just before begin(). */
  baselinePartyCaseCount: number | null;
  nonceBefore: bigint | null;
}

export class DurableWriteSession {
  private record: PendingRecord | null;
  private guard: WriteGuard | null = null;
  private release: Release | null = null;
  private loadState: LoadResult;
  /** Set when a save failed during an operation: this tab may not write again. */
  private broken: string | null = null;

  private constructor(
    private readonly store: PendingStore,
    private readonly lock: WriteLock | null,
    private readonly now: () => number,
  ) {
    this.loadState = { kind: "none" };
    this.record = null;
  }

  /**
   * Loads the record and, if no other tab holds the write lock, recovers an
   * operation whose page went away. Never throws.
   */
  static async open(store: PendingStore, lock: WriteLock | null, now: () => number = () => Date.now()): Promise<DurableWriteSession> {
    const s = new DurableWriteSession(store, lock, now);
    s.refresh();
    if (lock !== null) {
      const release = await lock.tryAcquire().catch(() => null);
      if (release !== null) {
        try {
          s.recoverUnderLock();
        } finally {
          release();
        }
      }
    }
    return s;
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  /**
   * Re-reads storage (e.g. after a `storage` event from another tab). Read-only:
   * a record in a live-only phase may belong to a tab that is still running,
   * so it is shown as unresolved, never recovered here.
   */
  refresh(): void {
    if (this.guard !== null) return;
    this.loadState = this.store.load();
    this.record = this.loadState.kind === "record" ? this.loadState.record : null;
  }

  /**
   * Must be called only while holding the write lock: a running tab holds the
   * lock for its whole operation (a closed or reloaded page releases it), so a
   * live-only record seen under the lock belongs to a page that went away.
   */
  private recoverUnderLock(): void {
    this.refresh();
    if (this.loadState.kind !== "record") return;
    const recovered = recoverAfterReload(this.loadState.record, this.iso());
    if (recovered === this.loadState.record) return;
    try {
      this.store.save(recovered);
      this.loadState = { kind: "record", record: recovered };
      this.record = recovered;
    } catch {
      this.loadState = { kind: "storage_unavailable", reason: "the recovered record could not be saved" };
      this.record = null;
    }
  }

  get state(): TxState | null {
    return this.record?.tx ?? null;
  }

  get current(): PendingRecord | null {
    return this.record;
  }

  /** Why a new write may not start, or null. */
  get blockedReason(): string | null {
    if (this.broken !== null) return this.broken;
    if (this.guard !== null) return "A write is in progress in this tab.";
    if (this.lock === null) return "Writes are blocked: this browser cannot guarantee one write at a time across tabs (no Web Locks support).";
    if (!this.store.probe()) return "Writes are blocked: browser storage is not writable, so an unresolved write could not be remembered.";
    return blockReason(this.loadState);
  }

  /**
   * Applies `mutate` to the record AS STORED, and only if storage still holds
   * this session's operation. Another tab may have reconciled or replaced it,
   * and a late callback from an old operation must never overwrite a newer
   * record. Throws (PendingStoreError or Error) instead of writing otherwise.
   */
  private persist(mutate: (r: PendingRecord) => PendingRecord): void {
    if (this.record === null) throw new Error("no record");
    const onDisk = this.store.load();
    if (onDisk.kind !== "record" || onDisk.record.operationId !== this.record.operationId) {
      throw new PendingStoreError("storage no longer holds this operation's record; not overwriting");
    }
    const next = { ...mutate(onDisk.record), updatedAt: this.iso() };
    this.store.save(next); // throws PendingStoreError
    this.record = next;
  }

  private dispatch(event: TxEvent): void {
    try {
      this.persist((r) => ({ ...r, tx: txReducer(r.tx, event) }));
    } catch (err) {
      if (err instanceof PendingStoreError) this.broken = `Writes are blocked in this tab: ${err.message}. Reload to recover the stored record.`;
      throw err;
    }
  }

  /** Starts an operation with already-gathered context (tests and scripts). */
  begin(intent: WriteIntent, ctx: BeginContext): Promise<WriteGuard> {
    return this.beginWithPreflight(async () => ({ intent, ctx }));
  }

  /**
   * Starts an operation. `preflight` runs read-only checks UNDER the cross-tab
   * lock, after reload recovery and the unresolved-record check, and returns
   * the intent (e.g. with the nonce it just read pinned). Only then is the
   * write-ahead record saved. Resolves with the single-use guard, or throws
   * WriteRefused (nothing is recorded or sent when the preflight fails).
   */
  async beginWithPreflight(preflight: () => Promise<PreflightResult>): Promise<WriteGuard> {
    if (this.broken !== null) throw new WriteRefused(this.broken);
    if (this.guard !== null) throw new WriteRefused("A write is in progress in this tab.");
    if (this.lock === null) throw new WriteRefused("Writes are blocked: this browser cannot guarantee one write at a time across tabs (no Web Locks support).");
    if (!this.store.probe()) throw new WriteRefused("Writes are blocked: browser storage is not writable, so an unresolved write could not be remembered.");
    const release = await this.lock.tryAcquire();
    if (release === null) throw new WriteRefused("Writes are blocked: another tab is running a write.");
    try {
      // Under the lock: re-read, and recover any operation whose page went away.
      this.recoverUnderLock();
      const again = blockReason(this.loadState);
      if (again !== null) throw new WriteRefused(again);
      let pre: PreflightResult;
      try {
        pre = await preflight();
      } catch (err) {
        throw new WriteRefused(`The preflight check failed, so nothing was sent: ${(err as Error).message}`);
      }
      const { intent, ctx } = pre;
      if (this.record?.operationId === intent.operationId) throw new WriteRefused("operation ids must be unique (use a fresh random id per operation)");
      const record: PendingRecord = {
        version: 1,
        operationId: intent.operationId,
        createdAt: this.iso(),
        updatedAt: this.iso(),
        chainId: intent.chainId,
        contract: intent.contractAddress,
        sender: intent.sender,
        consensusAddress: intent.consensusAddress,
        method: intent.method,
        expectedEffect: ctx.expectedEffect,
        baselinePartyCaseCount: ctx.baselinePartyCaseCount,
        nonceBefore: ctx.nonceBefore === null ? null : ctx.nonceBefore.toString(),
        tx: txReducer({ phase: "idle", txHash: null, note: null }, { type: "PREPARE" }),
        guard: null,
        recoveredAfterReload: false,
        reconciliations: [],
      };
      try {
        this.store.save(record);
      } catch (err) {
        throw new WriteRefused(`Writes are blocked: ${(err as Error).message}.`);
      }
      this.record = record;
      this.loadState = { kind: "record", record };
      const guard = new WriteGuard(intent, this.now);
      // Strict for the forward (write-ahead), best effort for the rest.
      guard.observe((snapshot) => {
        // Late callbacks (after the run ended) still land here, but only on this operation's record.
        if (this.record?.operationId !== snapshot.operationId) throw new Error("record belongs to another operation");
        this.persist((r) => ({ ...r, guard: snapshot }));
      });
      this.guard = guard;
      this.release = release;
      return guard;
    } catch (err) {
      release();
      throw err;
    }
  }

  /** Runs the one SDK call for the current operation. `wallet` is watched for changes. */
  async run(submit: () => Promise<unknown>, options: RunOptions & { wallet: Eip1193Provider }): Promise<WriteOutcome> {
    const guard = this.guard;
    if (guard === null || this.record?.tx.phase !== "preparing") throw new WriteRefused("no prepared operation");
    const watch = watchWalletDuringOperation(options.wallet, guard);
    let outcome: WriteOutcome | null = null;
    try {
      if (!watch.supported) {
        guard.disarm("the wallet does not report account or network changes");
        this.dispatch({ type: "NOT_SENT", message: "Nothing was sent: the wallet does not report account or network changes, so the operation could not be watched." });
        return { kind: "not_sent", reason: "wallet events unsupported" };
      }
      this.dispatch({ type: "REQUEST_WALLET" });
      const result = await runGuardedWrite(guard, submit, options);
      outcome = result.outcome;
      this.persist((r) => ({ ...r, guard: result.snapshot }));
      this.dispatch(outcomeToEvent(outcome));
      return outcome;
    } catch (err) {
      guard.disarm("the operation's record could not be saved");
      if (err instanceof PendingStoreError) {
        this.broken ??= `Writes are blocked in this tab: ${err.message}. Reload to recover the stored record.`;
        throw new WriteOutcomeNotRecorded(outcome, err.message);
      }
      throw err;
    } finally {
      watch.stop();
      this.guard = null;
      this.release?.();
      this.release = null;
    }
  }

  /** Status observations after submission (poll results, deadline, post-finality check). */
  apply(event: Extract<TxEvent, { type: "OBSERVED" | "NOT_FOUND_YET" | "POLL_TIMED_OUT" | "READ_FAILED" | "VERIFIED" | "VERIFICATION_MISMATCH" }>): void {
    this.dispatch(event);
  }

  /** Read-only reconciliation of an uncertain record. Persists the attempt and any resolution. */
  async reconcile(reader: ReconciliationReader, options: { timeoutMs?: number } = {}): Promise<ReconciliationResult> {
    if (this.guard !== null) throw new WriteRefused("an operation is running in this tab");
    const r = this.record;
    if (r === null || !UNCERTAIN_PHASES.includes(r.tx.phase)) throw new WriteRefused("nothing uncertain to reconcile");
    const evidence = await gatherEvidence(reader, r, options);
    const snapshot = r.guard ?? { operationId: r.operationId, armed: false, disarmReason: "no journal", requestsForwarded: 0, refusals: 0, outbound: null, journal: [] };
    // A record with no journal (should not happen: begin() persists before any request) is never "not sent".
    const result: ReconciliationResult =
      r.guard === null ? { kind: "unresolved", reasons: ["no guard journal was recorded"] } : reconcile({ ...evidence, snapshot });
    const note = {
      at: this.iso(),
      kind: result.kind,
      detail: result.kind === "unresolved" ? result.reasons.join("; ") : result.basis,
    };
    this.persist((rec) => ({ ...rec, reconciliations: [...rec.reconciliations.slice(-9), note] }));
    const phase = this.record?.tx.phase;
    if (result.kind === "not_sent" && phase === "submission_uncertain") this.dispatch({ type: "RECONCILED_NOT_SENT", basis: result.basis });
    else if (result.kind === "found") this.dispatch({ type: "RECONCILED_FOUND", txHash: result.txHash });
    else if (result.kind === "effect_final") this.dispatch({ type: "RECONCILED_EFFECT_FINAL", basis: result.basis });
    return result;
  }

  /** Clears a settled record so a new write may start. Unresolved records cannot be cleared here. */
  reset(): void {
    if (this.guard !== null) throw new WriteRefused("an operation is running in this tab");
    if (this.record === null) return;
    if (!SETTLED_PHASES.includes(this.record.tx.phase)) throw new WriteRefused("an unresolved write cannot be cleared");
    try {
      this.store.clear();
    } catch (err) {
      throw new WriteRefused((err as PendingStoreError).message);
    }
    this.record = null;
    this.loadState = { kind: "none" };
  }
}
