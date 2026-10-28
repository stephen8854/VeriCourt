import { describe, expect, it } from "vitest";
import { RECORDED_AMBIGUOUS, RECORDED_CLEAR, RECORDED_NO_REPLY } from "../fixtures/recorded";
import { diffPaths, validateAssessment, validateCase, validateRead } from "./validate";

describe("validators accept the recorded StudioNet read-backs", () => {
  it.each([RECORDED_CLEAR, RECORDED_AMBIGUOUS, RECORDED_NO_REPLY].map((r) => [r.source, r]))("%s", (_s, r) => {
    expect(validateCase(r.case).ok).toBe(true);
    expect(validateRead("get_case_evidence", r.evidence).ok).toBe(true);
    expect(validateRead("get_case_history", r.history).ok).toBe(true);
    expect(validateRead("get_assessment_status", r.reads.get_assessment_status).ok).toBe(true);
    expect(validateAssessment(r.assessment).ok).toBe(true);
  });
});

describe("validators reject malformed responses (inferred examples)", () => {
  it.each([
    ["null", null],
    ["string", "VC-000001"],
    ["missing status", { ...RECORDED_NO_REPLY.case, status: undefined }],
    ["number as string", { ...RECORDED_NO_REPLY.case, created_at: "1792220603" }],
    ["bigint-as-string", { ...RECORDED_NO_REPLY.case, reply_deadline: "99999999999999999999" }],
  ])("case: %s", (_n, value) => {
    expect(validateCase(value).ok).toBe(false);
  });

  it("assessment without exists flag, or with a malformed finding", () => {
    expect(validateAssessment({ outcome: "INCONCLUSIVE" }).ok).toBe(false);
    const broken = structuredClone(RECORDED_NO_REPLY.assessment) as unknown as { issue_findings: Array<Record<string, unknown>> };
    broken.issue_findings[0]!.supporting_evidence_ids = "E1";
    expect(validateAssessment(broken).ok).toBe(false);
  });

  it("missing assessment shape is accepted as 'no assessment'", () => {
    expect(validateAssessment({ exists: false, case_id: "VC-000001", status: "READY_FOR_ASSESSMENT", attempts: 0, schema_version: "x" }).ok).toBe(true);
  });

  it("case count must be a non-negative integer", () => {
    expect(validateRead("get_case_count", 3).ok).toBe(true);
    expect(validateRead("get_case_count", "3").ok).toBe(false);
    expect(validateRead("get_case_count", -1).ok).toBe(false);
  });
});

describe("diffPaths", () => {
  it("lists differing paths", () => {
    expect(diffPaths({ a: 1, b: [1, 2] }, { a: 1, b: [1, 3] })).toEqual(["$.b.1"]);
    expect(diffPaths({ a: 1 }, { a: 1, c: 2 })).toEqual(["$.c"]);
    expect(diffPaths(RECORDED_NO_REPLY.case, structuredClone(RECORDED_NO_REPLY.case))).toEqual([]);
  });
});
