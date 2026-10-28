/**
 * Persistent write-safety record (browser storage), so an unresolved write
 * stays blocked across reloads, tab closes and other tabs.
 *
 * Fail-closed rules:
 * - Storage that cannot be read or written blocks all writes (persistence
 *   cannot be guaranteed).
 * - A record that cannot be parsed blocks all writes (its outcome is unknown).
 *   Clearing it is a manual step (see docs), never automatic.
 * - The record is written BEFORE any wallet request (write-ahead, via the
 *   guard observer), so after a reload "no request recorded" really means
 *   none was sent from that page.
 *
 * Contents are public or user-entered values only: addresses, hashes, the
 * case title and respondent, phase, guard journal. No key, no signature.
 */
import { PHASE_VERIFICATION, SETTLED_PHASES, type TxPhase, type TxState } from "../tx/state";
import type { Hex } from "./bytes";
import type { GuardSnapshot, OutboundState } from "./guard";
import { CONTRACT_WRITE_METHODS, type ContractWriteMethod } from "./methods";

export const PENDING_KEY = "vericourt.write.pending.v1";
const RECORD_VERSION = 1;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ReconciliationNote {
  at: string;
  kind: "not_sent" | "found" | "effect_final" | "unresolved" | "read_failed";
  detail: string;
}

/** create_case: the new case's title and respondent (kept in its original, kind-less shape so older records stay readable). */
export interface CreateCaseEffect {
  title: string;
  respondent: string;
}

/** What a case-level write is expected to change (all values are public, user-entered or read from the contract). */
export type CaseWriteEffect =
  | {
      kind: "submit_evidence";
      caseId: string;
      label: string;
      description: string;
      contentRef: string;
      /** Lowercase hex, or "". */
      sha256: string;
      /** Evidence items in the case before the write (latest-nonfinal = latest-final at preflight). */
      baselineEvidenceCount: number;
    }
  | { kind: "submit_reply"; caseId: string; reply: string }
  | { kind: "process_reply_deadline"; caseId: string }
  | {
      kind: "request_assessment";
      caseId: string;
      /** Consensus-agreed attempts recorded before the write. */
      baselineAttempts: number;
    };

export type ExpectedEffect = CreateCaseEffect | CaseWriteEffect;

export function isCaseWriteEffect(e: ExpectedEffect | null): e is CaseWriteEffect {
  return e !== null && "kind" in e;
}

export interface PendingRecord {
  version: 1;
  operationId: string;
  createdAt: string;
  updatedAt: string;
  chainId: number;
  contract: Hex;
  sender: Hex;
  consensusAddress: Hex;
  method: ContractWriteMethod;
  /** What the effect check looks for; its shape must match `method`. */
  expectedEffect: ExpectedEffect | null;
  /** Number of party case ids for the sender before the write (null if not read). */
  baselinePartyCaseCount: number | null;
  /** Sender nonce before the write, decimal string (null if not read). */
  nonceBefore: string | null;
  tx: TxState;
  guard: GuardSnapshot | null;
  /** Set when the page that ran the operation went away mid-operation. */
  recoveredAfterReload: boolean;
  reconciliations: ReconciliationNote[];
}

export type LoadResult =
  | { kind: "none" }
  | { kind: "record"; record: PendingRecord }
  | { kind: "unreadable"; reason: string }
  | { kind: "storage_unavailable"; reason: string };

// ---------------------------------------------------------------------------
// Strict parsing
// ---------------------------------------------------------------------------

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const PHASES = Object.keys(PHASE_VERIFICATION) as TxPhase[];
const OUTBOUND_STATES: OutboundState[] = ["in_flight", "hash", "signed", "rejected", "error", "malformed", "withheld"];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNullOr = <T>(v: unknown, check: (x: unknown) => x is T): v is T | null => v === null || check(v);
const isAddr = (v: unknown): v is Hex => isStr(v) && ADDRESS.test(v);
const isHash = (v: unknown): v is Hex => isStr(v) && HASH.test(v);

function checkTx(v: unknown): string | null {
  if (!isObj(v)) return "tx is not an object";
  if (!PHASES.includes(v.phase as TxPhase)) return "unknown tx phase";
  if (!isNullOr(v.txHash, isHash)) return "bad txHash";
  if (!isNullOr(v.note, isStr)) return "bad note";
  return null;
}

function checkGuard(v: unknown): string | null {
  if (v === null) return null;
  if (!isObj(v)) return "guard is not an object";
  if (!isStr(v.operationId) || typeof v.armed !== "boolean" || !isNullOr(v.disarmReason, isStr)) return "bad guard header";
  if (v.requestsForwarded !== 0 && v.requestsForwarded !== 1) return "bad requestsForwarded";
  if (typeof v.refusals !== "number" || !Array.isArray(v.journal)) return "bad guard counters";
  const o = v.outbound;
  if (o !== null) {
    if (!isObj(o)) return "bad outbound";
    if (o.channel !== "wallet" && o.channel !== "signer") return "bad outbound channel";
    if (!OUTBOUND_STATES.includes(o.state as OutboundState)) return "bad outbound state";
    if (!isNullOr(o.hash, isHash)) return "bad outbound hash";
    if (typeof o.settledAfterDisarm !== "boolean") return "bad outbound flag";
  }
  if ((o === null) !== (v.requestsForwarded === 0)) return "outbound and requestsForwarded disagree";
  return null;
}

const CASE_ID = /^VC-\d{6,}$/;
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

function checkEffect(eff: unknown, method: ContractWriteMethod): string | null {
  if (eff === null) return null;
  if (!isObj(eff)) return "bad expectedEffect";
  if (!("kind" in eff)) {
    return method === "create_case" && isStr(eff.title) && isStr(eff.respondent) ? null : "bad expectedEffect";
  }
  if (eff.kind !== method || !isStr(eff.caseId) || !CASE_ID.test(eff.caseId)) return "expectedEffect does not match the method";
  switch (eff.kind) {
    case "submit_evidence":
      return isStr(eff.label) && isStr(eff.description) && isStr(eff.contentRef) && isStr(eff.sha256) && /^([0-9a-f]{64})?$/.test(eff.sha256) && isCount(eff.baselineEvidenceCount)
        ? null
        : "bad submit_evidence effect";
    case "submit_reply":
      return isStr(eff.reply) ? null : "bad submit_reply effect";
    case "process_reply_deadline":
      return null;
    case "request_assessment":
      return isCount(eff.baselineAttempts) ? null : "bad request_assessment effect";
    default:
      return "bad expectedEffect";
  }
}

export function parseRecord(text: string): { ok: true; record: PendingRecord } | { ok: false; reason: string } {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { ok: false, reason: "not valid JSON" };
  }
  if (!isObj(v)) return { ok: false, reason: "not an object" };
  if (v.version !== RECORD_VERSION) return { ok: false, reason: "unknown record version" };
  if (!isStr(v.operationId) || !isStr(v.createdAt) || !isStr(v.updatedAt)) return { ok: false, reason: "bad identity fields" };
  if (typeof v.chainId !== "number" || !isAddr(v.contract) || !isAddr(v.sender) || !isAddr(v.consensusAddress)) {
    return { ok: false, reason: "bad chain or address fields" };
  }
  if (!(CONTRACT_WRITE_METHODS as readonly unknown[]).includes(v.method)) return { ok: false, reason: "bad method" };
  const effectProblem = checkEffect(v.expectedEffect, v.method as ContractWriteMethod);
  if (effectProblem) return { ok: false, reason: effectProblem };
  if (!(v.baselinePartyCaseCount === null || (Number.isSafeInteger(v.baselinePartyCaseCount) && (v.baselinePartyCaseCount as number) >= 0))) {
    return { ok: false, reason: "bad baseline" };
  }
  if (!(v.nonceBefore === null || (isStr(v.nonceBefore) && /^\d+$/.test(v.nonceBefore)))) return { ok: false, reason: "bad nonceBefore" };
  const txProblem = checkTx(v.tx);
  if (txProblem) return { ok: false, reason: txProblem };
  const guardProblem = checkGuard(v.guard);
  if (guardProblem) return { ok: false, reason: guardProblem };
  if (typeof v.recoveredAfterReload !== "boolean" || !Array.isArray(v.reconciliations)) return { ok: false, reason: "bad bookkeeping fields" };
  return { ok: true, record: v as unknown as PendingRecord };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class PendingStoreError extends Error {}

export class PendingStore {
  constructor(private readonly storage: StorageLike | null) {}

  /** Browser storage, or null if it cannot even be accessed (a throwing getter counts as unavailable). */
  static fromWindow(win: unknown = globalThis): PendingStore {
    let storage: StorageLike | null = null;
    try {
      storage = (win as { localStorage?: StorageLike }).localStorage ?? null;
    } catch {
      storage = null;
    }
    return new PendingStore(storage);
  }

  load(): LoadResult {
    if (this.storage === null) return { kind: "storage_unavailable", reason: "browser storage is not available" };
    let text: string | null;
    try {
      text = this.storage.getItem(PENDING_KEY);
    } catch {
      return { kind: "storage_unavailable", reason: "browser storage could not be read" };
    }
    if (text === null) return { kind: "none" };
    const parsed = parseRecord(text);
    return parsed.ok ? { kind: "record", record: parsed.record } : { kind: "unreadable", reason: parsed.reason };
  }

  /** Writes the record and reads it back. Throws PendingStoreError on any failure. */
  save(record: PendingRecord): void {
    if (this.storage === null) throw new PendingStoreError("browser storage is not available");
    const text = JSON.stringify(record);
    try {
      this.storage.setItem(PENDING_KEY, text);
      if (this.storage.getItem(PENDING_KEY) !== text) throw new Error("read-back mismatch");
    } catch (err) {
      throw new PendingStoreError(`the pending-write record could not be saved (${(err as Error).message})`);
    }
  }

  /** Removes the record. Only for settled records (enforced by the caller). */
  clear(): void {
    if (this.storage === null) throw new PendingStoreError("browser storage is not available");
    this.storage.removeItem(PENDING_KEY);
  }

  /** True when storage accepts a write and returns it unchanged (without touching the record). */
  probe(): boolean {
    if (this.storage === null) return false;
    const key = `${PENDING_KEY}.probe`;
    try {
      this.storage.setItem(key, "1");
      const ok = this.storage.getItem(key) === "1";
      this.storage.removeItem(key);
      return ok;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/** Why no new write may start, or null if one may. */
export function blockReason(load: LoadResult): string | null {
  switch (load.kind) {
    case "none":
      return null;
    case "storage_unavailable":
      return `Writes are blocked: ${load.reason}, so an unresolved write could not be remembered across reloads.`;
    case "unreadable":
      return `Writes are blocked: a pending-write record exists but cannot be read (${load.reason}). Its outcome is unknown. See the manual recovery steps.`;
    case "record":
      return SETTLED_PHASES.includes(load.record.tx.phase)
        ? null
        : `Writes are blocked: an earlier write (${load.record.method}, ${load.record.operationId}) is unresolved (${load.record.tx.phase}).`;
  }
}

/** Phases that only exist while the page that runs the operation is alive. */
const LIVE_ONLY: readonly TxPhase[] = ["preparing", "awaiting_wallet"];

/**
 * Re-derives a record's phase after the page that ran it went away. Because the
 * record is written before any request leaves (write-ahead), a record with no
 * forwarded request proves nothing was sent from that page. Everything else
 * that was still open becomes uncertain; a timeout or reload is never failure.
 */
export function recoverAfterReload(record: PendingRecord, nowIso: string): PendingRecord {
  if (!LIVE_ONLY.includes(record.tx.phase)) return record;
  const g = record.guard;
  const o = g?.outbound ?? null;
  let tx: TxState;
  if (o === null) {
    tx = { phase: "not_sent", txHash: null, note: "The page closed or reloaded before any wallet request was made. Nothing was sent." };
  } else if (o.channel === "wallet" && o.state === "rejected") {
    tx = { phase: "rejected", txHash: null, note: "The wallet request was rejected. Nothing was sent." };
  } else if (o.state === "hash" && o.hash !== null) {
    tx = { phase: "submitted", txHash: o.hash, note: "Recovered after a reload: the wallet had returned this hash." };
  } else {
    tx = {
      phase: "submission_uncertain",
      txHash: null,
      note: "The page closed or reloaded while a wallet request was open or unresolved. The write may have been sent. Writes stay blocked until a read-only check resolves it.",
    };
  }
  return {
    ...record,
    tx,
    guard: g === null ? null : { ...g, armed: false, disarmReason: g.disarmReason ?? "page reloaded" },
    recoveredAfterReload: true,
    updatedAt: nowIso,
  };
}
