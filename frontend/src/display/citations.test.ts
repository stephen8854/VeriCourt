import { describe, expect, it } from "vitest";
import { RECORDED_CLEAR, RECORDED_NO_REPLY } from "../fixtures/recorded";
import {
  DIRECTION_CHECKED_HEADING,
  EMPTY_CITATIONS_TEXT,
  OPPOSITE_TO_CLAIMANT_UNCOMPARED,
  TOWARD_CLAIMANT_UNCOMPARED,
  UNCOMPARED_CITATIONS_NOTE,
  UNRESOLVED_HEADING,
  citationGroups,
  citationsWereOverlapChecked,
  describeCitedItem,
  visibleCitationGroups,
} from "./citations";

const DIRECTIONAL_WORDS = /\bsupport|\boppos|\bagainst\b|\bfavour|\bin favor|\bcounter\b/i;

describe("UNRESOLVED citations (recorded Phase 2.17C assessment)", () => {
  const finding = RECORDED_NO_REPLY.assessment.issue_findings[0]!;

  it("is the real stored case: UNRESOLVED with ids in supporting_evidence_ids", () => {
    expect(finding.determination).toBe("UNRESOLVED");
    expect(finding.supporting_evidence_ids).toEqual(["E1", "E2"]);
  });

  it("is shown as one group with no direction", () => {
    const groups = citationGroups(finding);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: "considered", heading: UNRESOLVED_HEADING, ids: ["E1", "E2"] });
    expect(groups[0]!.heading).toBe("Evidence the assessment considered — no direction established");
    expect(groups[0]!.heading).not.toMatch(DIRECTIONAL_WORDS);
  });

  it("merges both lists without duplicates (inferred example)", () => {
    const groups = citationGroups({ determination: "UNRESOLVED", supporting_evidence_ids: ["E2"], counter_evidence_ids: ["E1", "E2"] });
    expect(groups.map((g) => g.ids)).toEqual([["E2", "E1"]]);
  });

  it("describes cited items without any direction", () => {
    const items = finding.supporting_evidence_ids.map((id) => describeCitedItem(id, RECORDED_NO_REPLY.evidence));
    expect(items.map((i) => i.submittedBy)).toEqual(["Claimant", "Claimant"]);
    for (const item of items) {
      expect(`${item.label} ${item.inspection}`).not.toMatch(/\bsupports?\b|\bproves?\b/i);
    }
  });
});

describe("definite determinations", () => {
  it("SUPPORTED (recorded Phase 2.14): supporting list is the overlap-checked one", () => {
    const finding = RECORDED_CLEAR.assessment.issue_findings[0]!;
    expect(finding.determination).toBe("SUPPORTED");
    const groups = visibleCitationGroups(finding);
    expect(groups).toHaveLength(1); // empty counter list is not shown
    expect(groups[0]).toMatchObject({ key: "direction_checked", heading: DIRECTION_CHECKED_HEADING, ids: ["E1", "E2"] });
  });

  it("PARTIALLY_SUPPORTED shows the opposite list as uncompared (inferred example)", () => {
    const groups = citationGroups({ determination: "PARTIALLY_SUPPORTED", supporting_evidence_ids: ["E1"], counter_evidence_ids: ["E2"] });
    expect(groups.map((g) => [g.key, g.ids])).toEqual([
      ["direction_checked", ["E1"]],
      ["uncompared", ["E2"]],
    ]);
    expect(groups[1]!.heading).toBe(OPPOSITE_TO_CLAIMANT_UNCOMPARED);
  });

  it("NOT_SUPPORTED: counter list is the overlap-checked one (inferred example)", () => {
    const groups = citationGroups({ determination: "NOT_SUPPORTED", supporting_evidence_ids: ["E3"], counter_evidence_ids: ["E2"] });
    expect(groups.map((g) => [g.key, g.ids])).toEqual([
      ["direction_checked", ["E2"]],
      ["uncompared", ["E3"]],
    ]);
    expect(groups[1]!.heading).toBe(TOWARD_CLAIMANT_UNCOMPARED);
  });
});

describe("overlap-check note depends on the determination", () => {
  it("only definite determinations were overlap-checked", () => {
    expect(citationsWereOverlapChecked("SUPPORTED")).toBe(true);
    expect(citationsWereOverlapChecked("PARTIALLY_SUPPORTED")).toBe(true);
    expect(citationsWereOverlapChecked("NOT_SUPPORTED")).toBe(true);
    expect(citationsWereOverlapChecked("UNRESOLVED")).toBe(false);
    expect(citationsWereOverlapChecked("MIXED")).toBe(false);
    expect(UNCOMPARED_CITATIONS_NOTE).toMatch(/not compared across validators/);
  });
});

describe("empty citation lists", () => {
  it("UNRESOLVED with nothing cited says so, without implying no evidence exists", () => {
    const groups = visibleCitationGroups({ determination: "UNRESOLVED", supporting_evidence_ids: [], counter_evidence_ids: [] });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.ids).toEqual([]);
    expect(groups[0]!.emptyText).toBe(EMPTY_CITATIONS_TEXT);
    expect(EMPTY_CITATIONS_TEXT).toBe("No evidence was cited for this finding.");
  });

  it("an unknown determination never gets a direction", () => {
    const groups = citationGroups({ determination: "MIXED", supporting_evidence_ids: ["E1"], counter_evidence_ids: [] });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.heading).toBe("Evidence cited (direction not established)");
  });

  it("a cited id missing from the record is reported, not guessed", () => {
    expect(describeCitedItem("E9", RECORDED_NO_REPLY.evidence)).toEqual({
      id: "E9",
      label: "Not found in the locked record",
      submittedBy: "Unknown",
      inspection: "Unknown",
    });
  });
});
