import { describe, expect, it } from "vitest";
import { actionHref, caseHref, isCaseId, parseLocation, parseRoute } from "../app/routes";
import { safeHttpUrl } from "../components/ExternalLink";
import { PHASE_2_17C_NO_REPLY } from "../config/testDeployments";
import type { CaseView } from "../contract/types";
import { formatUtc, historyActionLabel, replyWindowView, viewerRole } from "../display/caseText";
import { NOTICE_NO_RESPONSE } from "../contract/notices";
import { recordedNoReplyCaseReads } from "../live/expected";
import { caseActions } from "./actions";
import { knownTransactionsFor } from "./knownTransactions";
import { MAX_RECENT, RECENT_KEY, localTransactions, recentCases, recordLocalTransaction, rememberCase } from "./localHistory";

const CASE = recordedNoReplyCaseReads().get_case as CaseView;
const A = `0x${"1a".repeat(20)}`;
const B = `0x${"2b".repeat(20)}`;
const awaiting = (over: Partial<CaseView> = {}): CaseView => ({
  ...CASE,
  claimant: A,
  respondent: B,
  status: "AWAITING_RESPONSE",
  response_state: "PENDING",
  snapshot_locked: false,
  created_at: 1000,
  reply_window_seconds: 3600,
  reply_deadline: 4600,
  ...over,
});

function memory() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}

describe("routes", () => {
  it("parses case, report and review routes with queries", () => {
    expect(parseLocation("#/case/VC-000003")).toEqual({ route: "/case", caseId: "VC-000003", query: {} });
    expect(parseLocation("#/report/VC-000001")).toMatchObject({ route: "/report", caseId: "VC-000001" });
    expect(parseLocation("#/review?action=submit_evidence&case=VC-000003")).toEqual({
      route: "/review",
      caseId: null,
      query: { action: "submit_evidence", case: "VC-000003" },
    });
    expect(parseLocation("#/nowhere").route).toBe("/");
    expect(parseRoute("#/wallet?x=1")).toBe("/wallet");
    expect(parseLocation("#/case/%E0%A4%A").caseId).toBe("%E0%A4%A");
  });

  it("validates case IDs and builds links", () => {
    expect(isCaseId("VC-000001")).toBe(true);
    expect(isCaseId("VC-1234567")).toBe(true);
    expect(isCaseId("vc-000001")).toBe(false);
    expect(isCaseId("VC-00001")).toBe(false);
    expect(caseHref("VC-000002")).toBe("#/case/VC-000002");
    expect(actionHref("submit_reply", "VC-000002")).toBe("#/review?action=submit_reply&case=VC-000002");
  });
});

describe("external links", () => {
  it.each(["javascript:alert(1)", "data:text/html,x", "ftp://x.org", "not a url", "https://exa mple.org"])("%s is not a link", (u) => {
    expect(safeHttpUrl(u)).toBeNull();
  });
  it("http(s) URLs are links", () => {
    expect(safeHttpUrl("https://example.org/a?b=1")?.href).toBe("https://example.org/a?b=1");
  });
});

describe("case wording", () => {
  it("formats contract times in UTC", () => {
    expect(formatUtc(1792395515)).toBe("2026-10-19 07:38:35 UTC");
    expect(formatUtc(0)).toBe("not recorded");
  });

  it("an open window, a passed-but-unprocessed window, a reply, and a recorded missed deadline", () => {
    expect(replyWindowView(awaiting(), 4000).tone).toBe("open");
    const passed = replyWindowView(awaiting(), 5000);
    expect(passed.tone).toBe("closed_unprocessed");
    expect(passed.headline).toMatch(/appears to have closed .*by this device's clock/);
    expect(passed.detail).not.toMatch(/no response/i);
    expect(replyWindowView(awaiting({ response_state: "SUBMITTED", replied_at: 2000 }), 5000).tone).toBe("replied");
    expect(replyWindowView(CASE, 0).detail).toBe(NOTICE_NO_RESPONSE);
  });

  it("roles and history labels", () => {
    expect(viewerRole(awaiting(), A.toUpperCase().replace("0X", "0x"))).toBe("CLAIMANT");
    expect(viewerRole(awaiting(), B)).toBe("RESPONDENT");
    expect(viewerRole(awaiting(), null)).toBeNull();
    expect(historyActionLabel("REPLY_WINDOW_EXPIRED")).toBe("Reply window closed with no reply recorded");
    expect(historyActionLabel("SOMETHING")).toMatch(/Unrecognised/);
  });
});

describe("action eligibility (guidance only)", () => {
  const find = (list: ReturnType<typeof caseActions>, m: string) => list.find((a) => a.method === m)!;

  it("before the deadline: evidence for either party, reply for the respondent only", () => {
    const asClaimant = caseActions(awaiting(), "CLAIMANT", null, [], 4000);
    expect(find(caseActions(awaiting(), "CLAIMANT", null, [], 4001), "submit_evidence").available).toBe(false);
    expect(find(asClaimant, "submit_evidence").available).toBe(true);
    expect(find(asClaimant, "submit_reply").available).toBe(false);
    expect(find(asClaimant, "process_reply_deadline").available).toBe(false);
    const asRespondent = caseActions(awaiting(), "RESPONDENT", null, [], 4000);
    expect(find(asRespondent, "submit_reply")).toMatchObject({ available: true, note: expect.stringMatching(/locks the record: add any evidence first/) });
  });

  it("after the deadline (plus the 10-minute margin): only recording the missed deadline", () => {
    expect(caseActions(awaiting(), "CLAIMANT", null, [], 5199).filter((a) => a.available)).toEqual([]);
    const list = caseActions(awaiting(), "CLAIMANT", null, [], 5200);
    expect(list.filter((a) => a.available).map((a) => a.method)).toEqual(["process_reply_deadline"]);
  });

  it("observers can do nothing; quotas and attempts are respected", () => {
    expect(caseActions(awaiting(), null, null, [], 4000).every((a) => !a.available)).toBe(true);
    expect(find(caseActions(awaiting({ claimant_evidence_count: 10 }), "CLAIMANT", null, [], 4000), "submit_evidence").available).toBe(false);
    const status = { case_id: "x", status: "READY_FOR_ASSESSMENT", has_assessment: false, attempts: 1, max_attempts: 2, remaining_attempts: 1, can_request: true, last_error: "", schema_version: "" };
    const ready = awaiting({ status: "READY_FOR_ASSESSMENT", snapshot_locked: true, response_state: "SUBMITTED" });
    expect(find(caseActions(ready, "RESPONDENT", status, [], 9999), "request_assessment")).toMatchObject({ available: true, note: "1 of 2 attempts remain." });
    expect(find(caseActions(ready, "RESPONDENT", { ...status, can_request: false }, [], 9999), "request_assessment").available).toBe(false);
  });
});

describe("browser-local history", () => {
  it("recent cases are per contract, bounded, de-duplicated and validated", () => {
    const s = memory();
    for (let i = 1; i <= 25; i++) rememberCase(s, PHASE_2_17C_NO_REPLY.address, `VC-${String(i).padStart(6, "0")}`);
    rememberCase(s, PHASE_2_17C_NO_REPLY.address, "VC-000025");
    rememberCase(s, PHASE_2_17C_NO_REPLY.address, "<script>");
    const list = recentCases(s, PHASE_2_17C_NO_REPLY.address);
    expect(list).toHaveLength(MAX_RECENT);
    expect(list[0]).toBe("VC-000025");
    expect(new Set(list).size).toBe(list.length);
    expect(recentCases(s, B)).toEqual([]);
  });

  it("works when storage is missing, throws or holds garbage", () => {
    expect(recentCases(null, A)).toEqual([]);
    const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(() => rememberCase(throwing, PHASE_2_17C_NO_REPLY.address, "VC-000001")).not.toThrow();
    const s = memory();
    s.m.set(RECENT_KEY, "{not json");
    expect(recentCases(s, PHASE_2_17C_NO_REPLY.address)).toEqual([]);
  });

  it("known transactions: recorded test runs plus this browser's own sends, labelled by source", () => {
    const s = memory();
    const hash = `0x${"ef".repeat(32)}`;
    recordLocalTransaction(s, { contract: PHASE_2_17C_NO_REPLY.address, caseId: "VC-000001", method: "submit_evidence", hash, at: "2026-10-20T10:00:00.000Z", phase: "submitted" });
    recordLocalTransaction(s, { contract: PHASE_2_17C_NO_REPLY.address, caseId: "VC-000001", method: "submit_evidence", hash, at: "2026-10-20T10:00:00.000Z", phase: "verified" });
    expect(localTransactions(s)).toHaveLength(1);
    const one = knownTransactionsFor(PHASE_2_17C_NO_REPLY.address, "VC-000001", s);
    expect(one.map((t) => t.operation)).toEqual(["create_case", "submit_evidence (E1)", "submit_evidence (E2)", "process_reply_deadline", "request_assessment", "submit_evidence"]);
    expect(one.at(-1)?.source).toMatch(/sent from this browser .*verified/);
    expect(knownTransactionsFor(PHASE_2_17C_NO_REPLY.address, "VC-000003", null)).toEqual([
      { hash: PHASE_2_17C_NO_REPLY.laterWrites[1]!.hash, operation: "create_case", source: "recorded test (Phase 3.6 browser-wallet test)" },
      { hash: PHASE_2_17C_NO_REPLY.laterWrites[2]!.hash, operation: "process_reply_deadline", source: "recorded test (Phase 4.1 live test)" },
    ]);
    expect(knownTransactionsFor(B, "VC-000001", s)).toEqual([]);
  });
});
