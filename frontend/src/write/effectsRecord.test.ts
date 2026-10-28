/**
 * The write-safety record's expected effect (Phase 4.1). Strict, fail-closed
 * parsing: an effect whose shape does not match the record's method makes the
 * record unreadable, which blocks every write until it is resolved by hand.
 * Records written before Phase 4 (create_case, kind-less effect) stay readable.
 */
import { describe, expect, it } from "vitest";
import { PENDING_KEY, PendingStore, blockReason, parseRecord, type PendingRecord } from "./pendingStore";
import { fakeStorage } from "../test/writeHarness";

const ADDR = `0x${"1a".repeat(20)}`;

function record(method: PendingRecord["method"], expectedEffect: unknown): string {
  return JSON.stringify({
    version: 1,
    operationId: "op-1",
    createdAt: "2026-10-20T00:00:00.000Z",
    updatedAt: "2026-10-20T00:00:00.000Z",
    chainId: 61999,
    contract: ADDR,
    sender: ADDR,
    consensusAddress: ADDR,
    method,
    expectedEffect,
    baselinePartyCaseCount: null,
    nonceBefore: "0",
    tx: { phase: "submitted", txHash: `0x${"cd".repeat(32)}`, note: null },
    guard: null,
    recoveredAfterReload: false,
    reconciliations: [],
  });
}

describe("expected effect parsing", () => {
  it.each<[PendingRecord["method"], unknown]>([
    ["create_case", { title: "A title", respondent: ADDR }],
    ["create_case", null],
    ["submit_evidence", { kind: "submit_evidence", caseId: "VC-000001", label: "l", description: "d", contentRef: "https://x.org", sha256: "", baselineEvidenceCount: 0 }],
    ["submit_evidence", { kind: "submit_evidence", caseId: "VC-000001", label: "l", description: "d", contentRef: "", sha256: "ab".repeat(32), baselineEvidenceCount: 3 }],
    ["submit_reply", { kind: "submit_reply", caseId: "VC-000002", reply: "text" }],
    ["process_reply_deadline", { kind: "process_reply_deadline", caseId: "VC-000002" }],
    ["request_assessment", { kind: "request_assessment", caseId: "VC-000002", baselineAttempts: 1 }],
  ])("accepts %s with a matching effect", (method, effect) => {
    expect(parseRecord(record(method, effect)).ok).toBe(true);
  });

  it.each<[string, PendingRecord["method"], unknown]>([
    ["a kind that differs from the method", "submit_reply", { kind: "process_reply_deadline", caseId: "VC-000002" }],
    ["a kind-less effect on a case-level method", "submit_reply", { title: "x", respondent: ADDR }],
    ["a bad case id", "process_reply_deadline", { kind: "process_reply_deadline", caseId: "case-2" }],
    ["an upper-case or short digest", "submit_evidence", { kind: "submit_evidence", caseId: "VC-000001", label: "l", description: "d", contentRef: "", sha256: "AB".repeat(32), baselineEvidenceCount: 0 }],
    ["a negative baseline", "submit_evidence", { kind: "submit_evidence", caseId: "VC-000001", label: "l", description: "d", contentRef: "", sha256: "", baselineEvidenceCount: -1 }],
    ["a missing reply", "submit_reply", { kind: "submit_reply", caseId: "VC-000001" }],
    ["a fractional attempt baseline", "request_assessment", { kind: "request_assessment", caseId: "VC-000001", baselineAttempts: 0.5 }],
    ["an unknown kind", "submit_reply", { kind: "something", caseId: "VC-000001" }],
  ])("rejects %s, which blocks every write", (_name, method, effect) => {
    const text = record(method, effect);
    expect(parseRecord(text).ok).toBe(false);
    const storage = fakeStorage();
    storage.data.set(PENDING_KEY, text);
    expect(blockReason(new PendingStore(storage).load())).toMatch(/cannot be read/);
  });
});
