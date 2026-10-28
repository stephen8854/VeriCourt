import { describe, expect, it } from "vitest";
import { contractSource } from "../test/contractSource";
import {
  CASE_ACTION_LIMITS,
  describeSubmitEvidence,
  submitEvidenceArgs,
  submitReplyArgs,
  urlProblem,
  validateCaseIdOnly,
  validateSubmitEvidence,
  validateSubmitReply,
  type SubmitEvidenceInput,
} from "./caseActions";

const ISSUES = ["I1", "I2"];
const HASH = "AB".repeat(32);

const link: SubmitEvidenceInput = {
  caseId: "VC-000003",
  evidenceType: "LINK",
  label: "Delivered build",
  description: "The build as delivered.",
  contentRef: "https://example.org/build",
  sha256: "",
  issueIds: ["I1"],
};

describe("limits mirror the contract", () => {
  it.each(Object.entries(CASE_ACTION_LIMITS))("%s = %d", (name, value) => {
    const key = name === "MAX_ISSUES_PER_EVIDENCE" ? null : name;
    if (key === null) {
      expect(contractSource).toMatch(/^MAX_ISSUES_PER_EVIDENCE = MAX_ISSUES$/m);
      expect(contractSource).toMatch(new RegExp(`^MAX_ISSUES = ${value}$`, "m"));
    } else {
      expect(contractSource).toMatch(new RegExp(`^${key} = ${value}\\b`, "m"));
    }
  });
});

describe("submit_evidence validation", () => {
  it("accepts a valid link, text excerpt and file digest", () => {
    expect(validateSubmitEvidence(link, ISSUES)).toEqual([]);
    expect(validateSubmitEvidence({ ...link, evidenceType: "TEXT", contentRef: "Clause 3: two rounds of revisions." }, ISSUES)).toEqual([]);
    expect(validateSubmitEvidence({ ...link, evidenceType: "FILE_DIGEST", contentRef: "", sha256: HASH }, ISSUES)).toEqual([]);
    expect(validateSubmitEvidence({ ...link, sha256: HASH }, ISSUES)).toEqual([]);
  });

  it.each([
    ["javascript:alert(1)", /http\(s\) URL/],
    ["ftp://example.org", /http\(s\) URL/],
    ["https://", /no host/],
    ["https:///path", /no host/],
    ["https://exa mple.org", /whitespace/],
    [`https://e.org/${"a".repeat(600)}`, /exceeds 512/],
  ])("rejects the URL %s", (url, problem) => {
    expect(urlProblem(url)).toMatch(problem);
  });

  it("enforces the type-specific digest rules", () => {
    expect(validateSubmitEvidence({ ...link, evidenceType: "TEXT", contentRef: "x", sha256: HASH }, ISSUES)).toContain("a SHA-256 is not accepted for a text excerpt");
    expect(validateSubmitEvidence({ ...link, evidenceType: "FILE_DIGEST", contentRef: "a.pdf", sha256: "" }, ISSUES)).toContain(
      "SHA-256 must be 64 hexadecimal characters",
    );
    expect(validateSubmitEvidence({ ...link, sha256: "zz" }, ISSUES)).toContain("SHA-256 must be 64 hexadecimal characters");
  });

  it("checks issue references, counts and duplicates", () => {
    expect(validateSubmitEvidence({ ...link, issueIds: [] }, ISSUES)).toContain("choose between 1 and 5 issues");
    expect(validateSubmitEvidence({ ...link, issueIds: ["I9"] }, ISSUES)).toContain("unknown issue I9");
    expect(validateSubmitEvidence({ ...link, issueIds: ["I1", "I1"] }, ISSUES)).toContain("issue I1 is listed twice");
  });

  it("counts code points and rejects control characters, like the contract", () => {
    expect(validateSubmitEvidence({ ...link, label: "😀".repeat(120) }, ISSUES)).toEqual([]);
    expect(validateSubmitEvidence({ ...link, label: "😀".repeat(121) }, ISSUES)).toContain("label exceeds 120 characters");
    expect(validateSubmitEvidence({ ...link, description: "a\u0007b" }, ISSUES)).toContain("description contains control characters");
    expect(validateSubmitEvidence({ ...link, label: "   " }, ISSUES)).toContain("label is required");
  });

  it("encodes exactly the reviewed values, digest in lowercase", () => {
    const input = { ...link, sha256: HASH, issueIds: ["I2", "I1"] };
    expect(submitEvidenceArgs(input)).toEqual(["VC-000003", "LINK", "Delivered build", "The build as delivered.", "https://example.org/build", HASH.toLowerCase(), ["I2", "I1"]]);
    const rows = describeSubmitEvidence(input);
    expect(rows.find((r) => r.label === "SHA-256")?.value).toBe(HASH.toLowerCase());
    expect(rows.find((r) => r.label === "Issues")?.value).toEqual(["I2", "I1"]);
  });
});

describe("submit_reply and case-only actions", () => {
  it("validates the reply like the contract", () => {
    expect(validateSubmitReply({ caseId: "VC-000001", reply: "My reply." })).toEqual([]);
    expect(validateSubmitReply({ caseId: "VC-000001", reply: "" })).toContain("reply is required");
    expect(validateSubmitReply({ caseId: "VC-000001", reply: "x".repeat(4001) })).toContain("reply exceeds 4000 characters");
    expect(validateSubmitReply({ caseId: "case-1", reply: "ok" })).toContain("case ID must look like VC-000001");
    expect(submitReplyArgs({ caseId: "VC-000001", reply: "a\nb" })).toEqual(["VC-000001", "a\nb"]);
  });

  it("validates the case ID for deadline and assessment actions", () => {
    expect(validateCaseIdOnly("VC-000002")).toEqual([]);
    expect(validateCaseIdOnly("VC-2")).toHaveLength(1);
  });
});
