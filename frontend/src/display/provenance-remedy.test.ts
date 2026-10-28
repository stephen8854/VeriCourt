import { describe, expect, it } from "vitest";
import { REMEDY_ASSESSMENTS } from "../contract/enums";
import { RECORDED_NO_REPLY } from "../fixtures/recorded";
import {
  ADVISORY_BLOCK_HEADING,
  DECISION_BLOCK_HEADING,
  displayBlockOf,
  provenanceLabel,
  provenanceOf,
} from "./provenance";
import { CANNOT_ASSESS_NOTE, NO_ENFORCEMENT_DISCLAIMER, REMEDY_PROVENANCE, remedyDisplay } from "./remedy";

describe("provenance classes mirror the contract's stored provenance", () => {
  it("matches every field the contract lists (recorded Phase 2.17C provenance)", () => {
    const stored = RECORDED_NO_REPLY.assessment.provenance as Record<string, unknown>;
    for (const [cls, fields] of Object.entries(stored)) {
      if (cls === "display_notice") continue;
      const names = Array.isArray(fields) ? (fields as string[]) : Object.keys(fields as object);
      for (const field of names) expect(provenanceOf(field)).toBe(cls);
    }
  });

  it("only outcome and determinations are in the decision block", () => {
    expect(displayBlockOf("outcome")).toBe("decision");
    expect(displayBlockOf("issue_findings[].determination")).toBe("decision");
    for (const f of ["summary", "issue_findings[].finding", "issue_findings[].reasoning", "issue_findings[].confidence", "issue_findings[].open_questions", "limitations", "remedy_assessment"]) {
      expect(displayBlockOf(f)).toBe("advisory");
    }
  });

  it("leader-generated text is never labelled as verified", () => {
    expect(provenanceLabel("leader_generated_unverified")).toBe("AI-generated explanation: not independently verified");
    expect(provenanceLabel("leader_generated_constrained")).toMatch(/not compared across validators/);
    expect(ADVISORY_BLOCK_HEADING).toBe("Explanation (AI-generated, not independently verified)");
    for (const label of [provenanceLabel("leader_generated_unverified"), provenanceLabel("leader_generated_constrained"), ADVISORY_BLOCK_HEADING]) {
      // Any mention of verification must be negated.
      expect(label.replace(/not (independently )?verified/gi, "")).not.toMatch(/verif/i);
    }
  });

  it("validator agreement is described as a majority of those that voted, never 'all'", () => {
    const label = provenanceLabel("consensus_compared");
    expect(label).toMatch(/majority of the validators that voted/);
    expect(`${label} ${DECISION_BLOCK_HEADING}`).not.toMatch(/\ball\b|\bevery validator\b|\bunanim/i);
  });
});

describe("advisory remedy", () => {
  it.each(REMEDY_ASSESSMENTS)("%s is labelled advisory with the no-enforcement disclaimer", (remedy) => {
    const d = remedyDisplay(remedy);
    expect(d.provenance).toBe(REMEDY_PROVENANCE);
    expect(d.provenance).toBe("Advisory: AI-generated, not checked by validators");
    expect(d.disclaimer).toBe(NO_ENFORCEMENT_DISCLAIMER);
  });

  it("CANNOT_ASSESS does not claim to know whether it was replaced", () => {
    const d = remedyDisplay("CANNOT_ASSESS");
    expect(d.label).toBe("No view on the requested remedy");
    expect(d.note).toBe(CANNOT_ASSESS_NOTE);
    expect(d.note).toMatch(/may be the model's own view, or the contract's automatic replacement/);
  });

  it("recorded 2.17C remedy", () => {
    expect(RECORDED_NO_REPLY.assessment.remedy_assessment).toBe("CANNOT_ASSESS");
    expect(remedyDisplay(RECORDED_NO_REPLY.assessment.remedy_assessment).note).toBe(CANNOT_ASSESS_NOTE);
  });

  it("remedy labels never promise payment or enforcement", () => {
    for (const r of REMEDY_ASSESSMENTS) {
      expect(remedyDisplay(r).label).not.toMatch(/pay|refund|escrow|enforc|award|owe|liab/i);
    }
  });
});
