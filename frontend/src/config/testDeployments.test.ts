import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PHASE_2_17C_NO_REPLY } from "./testDeployments";

describe("Phase 2.17C test deployment constants", () => {
  it("expected code hash is the SHA-256 of contracts/vericourt.py in this repo", () => {
    const source = readFileSync(resolve(process.cwd(), "..", "contracts", "vericourt.py"));
    expect(createHash("sha256").update(source).digest("hex")).toBe(PHASE_2_17C_NO_REPLY.expectedCodeSha256);
  });

  it("transaction hashes are well-formed and unique", () => {
    const hashes = PHASE_2_17C_NO_REPLY.transactions.map((t) => t.hash);
    for (const h of hashes) expect(h).toMatch(/^0x[0-9a-f]{64}$/);
    expect(new Set(hashes).size).toBe(6);
    expect(hashes[0]).toBe(PHASE_2_17C_NO_REPLY.deployTx);
    expect(PHASE_2_17C_NO_REPLY.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("records the later writes (VC-000002, VC-000003 create, VC-000003 deadline) separately from the original run's evidence", () => {
    const w = PHASE_2_17C_NO_REPLY.laterWrites;
    expect(w.map((x) => x.caseId)).toEqual(["VC-000002", "VC-000003", "VC-000003"]);
    expect(w[2]).toMatchObject({ phase: "4.1 live test", hash: "0x7ce4c93288cb1fe33b2590c1525c3fba982c58e564f81872f4dbb92f92e6fde7", report: "docs/PHASE_4_1_LIVE_TEST_REVIEW.md" });
    expect(w[2]?.operation).toMatch(/^process_reply_deadline /);
    expect(w[0]).toMatchObject({ phase: "3.5A Stage A", report: "docs/PHASE_3_5A_STAGE_A_REPORT.md" });
    expect(w[1]).toMatchObject({
      phase: "3.6 browser-wallet test",
      hash: "0x1574004493ed3f2bb5dd29d673d6738d2ee192379edfaa563d523f69d7c108e0",
      report: "docs/PHASE_3_6_BROWSER_WALLET_TEST_REPORT.md",
    });
    for (const x of w) {
      expect(x.hash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(x.sender).toMatch(/^0x[0-9a-fA-F]{40}$/);
      // The live check's expectations still describe only the Phase 2.17C run.
      expect(PHASE_2_17C_NO_REPLY.transactions.map((t) => t.hash)).not.toContain(x.hash);
    }
    expect(new Set(w.map((x) => x.hash)).size).toBe(w.length);
    expect(PHASE_2_17C_NO_REPLY.caseId).toBe("VC-000001");
    expect(PHASE_2_17C_NO_REPLY.address).toBe("0x3258A80A86920792354A9b7e59D5Ed2409E96220");
  });
});
