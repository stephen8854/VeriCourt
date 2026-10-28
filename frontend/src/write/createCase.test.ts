import { decodeInputData } from "genlayer-js";
import { describe, expect, it } from "vitest";
import { contractSource as CONTRACT_SOURCE } from "../test/contractSource";
import { CONTRACT, SENDER } from "../test/writeHarness";
import { decodeAddTransactionV5 } from "./addTransaction";
import {
  CREATE_CASE_LIMITS,
  CREATE_CASE_PARAMS,
  createCaseArgs,
  describeCreateCase,
  validateCreateCase,
  type CreateCaseInput,
} from "./createCase";
import { buildWriteIntent, studionetWriteParams } from "./intent";
import { PREVIEW_CASE } from "../pages/WritePreview";

const VALID: CreateCaseInput = {
  respondent: `0x${"2b".repeat(20)}`,
  category: "SOFTWARE",
  title: "FICTIONAL - CSV export",
  agreementSummary: "FICTIONAL agreement",
  expectedDeliverable: "FICTIONAL deliverable",
  claim: "FICTIONAL claim\nwith a second line",
  requestedRemedy: "FICTIONAL remedy",
  issues: ["FICTIONAL issue one", "FICTIONAL issue two"],
  replyWindowSeconds: 3600,
};

describe("create_case model mirrors the contract", () => {
  it("limits equal the contract constants", () => {
    const constant = (name: string) => {
      const m = CONTRACT_SOURCE.match(new RegExp(`^${name} = (.+?)(?:\\s+#.*)?$`, "m"));
      if (!m) throw new Error(`constant ${name} not found`);
      const expr = m[1]!.trim();
      // Only integer literals and products ("30 * 24 * 60 * 60") are accepted.
      if (!/^\d+(\s*\*\s*\d+)*$/.test(expr)) throw new Error(`unexpected expression for ${name}: ${expr}`);
      return expr.split("*").reduce((acc, n) => acc * Number(n.trim()), 1);
    };
    for (const [name, value] of Object.entries(CREATE_CASE_LIMITS)) expect(constant(name), name).toBe(value);
  });

  it("argument order equals the contract's create_case signature", () => {
    const sig = CONTRACT_SOURCE.match(/def create_case\(\s*self,([\s\S]*?)\)\s*->/);
    const names = sig![1]!.split(",").map((p) => p.trim().split(":")[0]!.trim()).filter(Boolean);
    expect(names).toEqual([...CREATE_CASE_PARAMS]);
  });
});

describe("validateCreateCase", () => {
  it("accepts a valid fictional case and the preview example", () => {
    expect(validateCreateCase(VALID, SENDER)).toEqual([]);
    expect(validateCreateCase(PREVIEW_CASE, SENDER)).toEqual([]);
  });

  it.each<[string, Partial<CreateCaseInput>, RegExp]>([
    ["respondent = claimant", { respondent: SENDER }, /different addresses/],
    ["zero respondent", { respondent: `0x${"0".repeat(40)}` }, /zero address/],
    ["bad respondent", { respondent: "0x123" }, /20-byte hex/],
    ["unknown category", { category: "LEGAL" as never }, /category must be one of/],
    ["short title", { title: "abc " }, /at least 5/],
    ["long title", { title: "x".repeat(121) }, /exceeds 120/],
    ["empty claim", { claim: "   " }, /claim is required/],
    ["control characters", { claim: "a\u0007b" }, /control characters/],
    ["no issues", { issues: [] }, /between 1 and 5/],
    ["six issues", { issues: ["a", "b", "c", "d", "e", "f"] }, /between 1 and 5/],
    ["duplicate issues (whitespace and case)", { issues: ["Late  Delivery", "late delivery"] }, /duplicate issue/],
    ["short window", { replyWindowSeconds: 3599 }, /between 3600/],
    ["fractional window", { replyWindowSeconds: 3600.5 }, /integer/],
  ])("rejects %s", (_name, patch, problem) => {
    expect(validateCreateCase({ ...VALID, ...patch }, SENDER).join("; ")).toMatch(problem);
  });

  it("counts Unicode code points like Python's len()", () => {
    expect(validateCreateCase({ ...VALID, title: "😀".repeat(120) }, SENDER)).toEqual([]);
    expect(validateCreateCase({ ...VALID, title: "😀".repeat(121) }, SENDER).join()).toMatch(/exceeds 120/);
  });
});

describe("confirmation data is exactly what gets encoded", () => {
  it("decoding the intent's calldata yields the displayed values, in order", () => {
    const intent = buildWriteIntent({
      operationId: "op-display",
      chain: studionetWriteParams(),
      sender: SENDER,
      contractAddress: CONTRACT,
      method: "create_case",
      args: createCaseArgs(VALID),
    });
    const txData = decodeAddTransactionV5(intent.calldata)!.txData;
    const decoded = decodeInputData(txData, CONTRACT);
    const call = decoded && "callData" in decoded ? (decoded.callData as Map<string, unknown>) : null;
    expect(call?.get("method")).toBe("create_case");
    const args = call?.get("args") as unknown[];
    const shown = describeCreateCase(VALID);
    expect(shown.map((f) => f.param)).toEqual([...CREATE_CASE_PARAMS]);
    for (let i = 0; i < 8; i++) expect(args[i], CREATE_CASE_PARAMS[i]).toEqual(shown[i]!.value);
    expect(args[8]).toBe(3600n);
    expect(shown[8]!.value).toBe("3600 seconds (1 hour)");
  });

  it("the displayed rows carry the advisory and numbering notes", () => {
    const rows = describeCreateCase(VALID);
    expect(rows.find((r) => r.param === "requested_remedy")?.note).toMatch(/Advisory/);
    expect(rows.find((r) => r.param === "issues")?.note).toMatch(/I1, I2/);
  });
});
