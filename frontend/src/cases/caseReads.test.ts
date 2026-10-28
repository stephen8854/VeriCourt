import { beforeEach, describe, expect, it, vi } from "vitest";
import { PHASE_2_17C_NO_REPLY } from "../config/testDeployments";
import { REVIEWED_CONTRACT_CODE_SHA256 } from "../config/contract";
import { recordedNoReplyCaseReads } from "../live/expected";
import type { HashVariant, ReadMethod } from "../live/gateway";
import { fakeGateway, nodeSha256Hex } from "../test/fakeGateway";
import { checkContract, loadCase, loadPartyCases, resetContractCheckCache, type ReadOptions } from "./caseReads";
import { checkConsistency } from "./consistency";

const ADDRESS = PHASE_2_17C_NO_REPLY.address;
const OPTS: ReadOptions = { timeoutMs: 1000, networkRetryDelayMs: 1, sha256Hex: nodeSha256Hex, expectedCodeSha256: REVIEWED_CONTRACT_CODE_SHA256 };
const INFO = {
  schema_version: "vericourt-case-v1",
  case_count: 3,
  statuses: [],
  categories: [],
  evidence_types: [],
  limits: {},
  assessment: { schema_version: "vericourt-assessment-v2" },
};

type Override = (method: ReadMethod, variant: HashVariant) => Promise<unknown> | undefined;

function gateway(extra: Override = () => undefined, opts: Parameters<typeof fakeGateway>[0] = {}) {
  return fakeGateway({
    ...opts,
    overrideRead: (method, variant) => {
      const x = extra(method, variant);
      if (x !== undefined) return x;
      if (method === "get_contract_info") return Promise.resolve(INFO);
      if (method === "get_case_count") return Promise.resolve(3);
      return undefined;
    },
  });
}

beforeEach(() => resetContractCheckCache());

describe("contract check", () => {
  it("passes for the reviewed contract on StudioNet and is cached per address", async () => {
    const { gateway: g, impl } = gateway();
    expect(await checkContract(g, ADDRESS, OPTS)).toEqual({ kind: "ok" });
    expect(await checkContract(g, ADDRESS, OPTS)).toEqual({ kind: "ok" });
    expect(impl.getContractCode).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["another chain", { chainId: "0x1" }, /not StudioNet/],
    ["other code", { code: "# some other contract" }, /not the reviewed VeriCourt contract/],
  ])("refuses %s", async (_n, opts, reason) => {
    const { gateway: g } = gateway(() => undefined, opts);
    expect(await checkContract(g, ADDRESS, OPTS)).toMatchObject({ kind: "unexpected_contract", reason: expect.stringMatching(reason) });
  });

  it("refuses an unexpected schema version", async () => {
    const { gateway: g } = gateway((m) => (m === "get_contract_info" ? Promise.resolve({ ...INFO, schema_version: "vericourt-case-v9" }) : undefined));
    expect(await checkContract(g, ADDRESS, OPTS)).toMatchObject({ kind: "unexpected_contract", reason: expect.stringMatching(/case schema/) });
  });

  it("an unavailable RPC is reported (not cached), and can be retried", async () => {
    let fail = true;
    const { gateway: g } = gateway(() => undefined, {
      overrideChain: async () => {
        if (fail) throw new TypeError("Failed to fetch");
        return "0xf22f";
      },
    });
    expect(await checkContract(g, ADDRESS, OPTS)).toMatchObject({ kind: "unavailable", error: { category: "network_or_cors" } });
    fail = false;
    expect(await checkContract(g, ADDRESS, OPTS)).toEqual({ kind: "ok" });
  });
});

describe("loadCase", () => {
  it("loads the recorded VC-000001 at latest-final with 8 reads, final, and consistent", async () => {
    const { gateway: g, impl } = gateway();
    const r = await loadCase(g, ADDRESS, "VC-000001", OPTS);
    if (r.kind !== "loaded") throw new Error(JSON.stringify(r));
    expect(r.data.source).toBe("latest-final");
    expect(r.data.finality).toEqual({ kind: "final" });
    expect(r.data.inconsistencies).toEqual([]);
    expect(r.data.requests).toBe(8);
    expect(r.data.evidence.ok && r.data.history.ok && r.data.assessment.ok && r.data.assessmentStatus.ok).toBe(true);
    // Only the four read-only gateway operations exist; the strict proxy throws on anything else.
    expect(impl.getTransaction).not.toHaveBeenCalled();
  });

  it("an invalid ID makes no request", async () => {
    const { gateway: g, impl } = gateway();
    expect(await loadCase(g, ADDRESS, "VC-1", OPTS)).toEqual({ kind: "invalid_id" });
    expect(await loadCase(g, ADDRESS, "VC-000000", OPTS)).toEqual({ kind: "invalid_id" });
    expect(impl.chainId).not.toHaveBeenCalled();
  });

  it("a case number above the count is not found (no case read)", async () => {
    const { gateway: g } = gateway();
    expect(await loadCase(g, ADDRESS, "VC-000004", OPTS)).toEqual({ kind: "not_found", caseCount: 3 });
  });

  it("a case that exists only at latest-nonfinal is read there and marked not final yet", async () => {
    const { gateway: g, impl } = gateway((m, v) => (m === "get_case_count" && v === "latest-final" ? Promise.resolve(0) : undefined));
    const r = await loadCase(g, ADDRESS, "VC-000001", OPTS);
    expect(r.kind === "loaded" && r.data.source).toBe("latest-nonfinal");
    expect(r.kind === "loaded" && r.data.finality).toEqual({ kind: "not_final_yet" });
    expect(vi.mocked(impl.readContract).mock.calls.filter(([, m, , v]) => m === "get_case" && v === "latest-final")).toHaveLength(0);
  });

  it("newer non-final changes are reported, never shown as the record", async () => {
    const recorded = recordedNoReplyCaseReads().get_case as Record<string, unknown>;
    const { gateway: g } = gateway((m, v) => (m === "get_case" && v === "latest-nonfinal" ? Promise.resolve({ ...recorded, history_count: 9 }) : undefined));
    const r = await loadCase(g, ADDRESS, "VC-000001", OPTS);
    if (r.kind !== "loaded") throw new Error(r.kind);
    expect(r.data.finality).toMatchObject({ kind: "pending_changes", differences: ["$.history_count"] });
    expect(r.data.case.history_count).toBe(recorded.history_count);
  });

  it("a malformed case read stops the load; a malformed section is kept out but reported", async () => {
    const a = gateway((m) => (m === "get_case" ? Promise.resolve({ case_id: "VC-000001" }) : undefined));
    expect(await loadCase(a.gateway, ADDRESS, "VC-000001", OPTS)).toMatchObject({ kind: "malformed" });
    resetContractCheckCache();
    const b = gateway((m) => (m === "get_case_history" ? Promise.resolve([{ seq: "x" }]) : undefined));
    const r = await loadCase(b.gateway, ADDRESS, "VC-000001", OPTS);
    expect(r.kind === "loaded" && r.data.history.ok).toBe(false);
  });

  it("a read failure mid-way stops with the failing step and its category (the HTML rate-limit page is unparseable)", async () => {
    const { gateway: g } = gateway((m) => (m === "get_case_evidence" ? Promise.reject(new SyntaxError("Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON")) : undefined));
    const r = await loadCase(g, ADDRESS, "VC-000001", OPTS);
    expect(r).toMatchObject({ kind: "unavailable", step: expect.stringMatching(/get_case_evidence/), error: { category: "unparseable_response" } });
  });

  it("one network-level failure is retried once and the load succeeds; a timeout is not retried", async () => {
    let failures = 1;
    const { gateway: g, impl } = gateway((m) => {
      if (m === "get_case_history" && failures > 0) {
        failures -= 1;
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      return undefined;
    });
    const r = await loadCase(g, ADDRESS, "VC-000001", OPTS);
    expect(r.kind).toBe("loaded");
    expect(vi.mocked(impl.readContract).mock.calls.filter(([, m]) => m === "get_case_history")).toHaveLength(2);
  });

  it("a persistent network failure stops the load after one retry", async () => {
    const { gateway: g, impl } = gateway((m) => (m === "get_assessment" ? Promise.reject(new TypeError("Failed to fetch")) : undefined));
    expect(await loadCase(g, ADDRESS, "VC-000001", OPTS)).toMatchObject({ kind: "unavailable", error: { category: "network_or_cors" } });
    expect(vi.mocked(impl.readContract).mock.calls.filter(([, m]) => m === "get_assessment")).toHaveLength(2);
  });

  it("a timeout is reported as unavailable, never as absent", async () => {
    const { gateway: g, impl } = gateway((m) => (m === "get_assessment" ? new Promise(() => undefined) : undefined));
    const r = await loadCase(g, ADDRESS, "VC-000001", { ...OPTS, timeoutMs: 20 });
    expect(r).toMatchObject({ kind: "unavailable", error: { category: "timeout" } });
    expect(vi.mocked(impl.readContract).mock.calls.filter(([, m]) => m === "get_assessment")).toHaveLength(1);
  });

  it("an RPC error is not retried", async () => {
    const { gateway: g, impl } = gateway((m) => (m === "get_case_history" ? Promise.reject(new Error("gen_call failed: [EXPECTED] case not found")) : undefined));
    expect(await loadCase(g, ADDRESS, "VC-000001", OPTS)).toMatchObject({ kind: "unavailable", error: { category: "rpc_error" } });
    expect(vi.mocked(impl.readContract).mock.calls.filter(([, m]) => m === "get_case_history")).toHaveLength(1);
  });
});

describe("consistency checks", () => {
  async function loaded() {
    const { gateway: g } = gateway();
    const r = await loadCase(g, ADDRESS, "VC-000001", OPTS);
    if (r.kind !== "loaded") throw new Error(r.kind);
    return r.data;
  }

  it.each<[string, (d: Awaited<ReturnType<typeof loaded>>) => void, RegExp]>([
    ["evidence count", (d) => (d.case.evidence_count += 1), /evidence item\(s\), but the register lists/],
    ["history count", (d) => (d.case.history_count += 1), /history entr\(ies\), but the timeline lists/],
    ["requested id", (d) => (d.caseId = "VC-000002"), /returned case VC-000001 when VC-000002 was requested/],
    ["unknown status", (d) => (d.case.status = "CLOSED"), /Unrecognised case status CLOSED/],
    ["stored-but-not-decided", (d) => (d.case.status = "READY_FOR_ASSESSMENT"), /An assessment is stored, but the case status is READY_FOR_ASSESSMENT/],
    ["digest", (d) => (d.case.snapshot_digest = "0".repeat(64)), /snapshot digest differs/],
    [
      "unknown citation",
      (d) => {
        if (d.assessment.ok && d.assessment.value.exists) d.assessment.value.issue_findings[0]!.supporting_evidence_ids = ["E9"];
      },
      /cites E9, which is not in the evidence register/,
    ],
    ["reserved state", (d) => (d.case.status = "ASSESSMENT_PENDING"), /never stores/],
  ])("detects %s", async (_n, mutate, problem) => {
    const d = await loaded();
    mutate(d);
    expect(checkConsistency(d).join("\n")).toMatch(problem);
  });
});

describe("loadPartyCases", () => {
  it("reads the party index and each case status at latest-nonfinal", async () => {
    const { gateway: g, impl } = gateway((m) =>
      m === "get_party_case_ids" ? Promise.resolve({ total: 1, case_ids: ["VC-000001"] }) : undefined,
    );
    const r = await loadPartyCases(g, ADDRESS, "0x16fD571ae717F92b5e43597d813267C8d15f105A", 0, OPTS);
    expect(r).toMatchObject({ kind: "loaded", total: 1, rows: [{ caseId: "VC-000001", status: { ok: true } }] });
    expect(vi.mocked(impl.readContract).mock.calls.find(([, m]) => m === "get_party_case_ids")?.[2]).toEqual(["0x16fD571ae717F92b5e43597d813267C8d15f105A", 0, 10]);
  });

  it("rejects a malformed index", async () => {
    const { gateway: g } = gateway((m) => (m === "get_party_case_ids" ? Promise.resolve({ total: 0, case_ids: ["VC-000001"] }) : undefined));
    expect(await loadPartyCases(g, ADDRESS, "0x16fD571ae717F92b5e43597d813267C8d15f105A", 0, OPTS)).toMatchObject({ kind: "malformed" });
  });
});
