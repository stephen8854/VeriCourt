import { describe, expect, it } from "vitest";
import { CASE_STATUSES, CONFIDENCE_LEVELS, DETERMINATIONS, OUTCOMES, RESPONSE_STATES } from "../contract/enums";
import { RECORDED_NO_REPLY } from "../fixtures/recorded";
import {
  caseHeadline,
  caseStatusLabel,
  confidenceLabel,
  determinationLabel,
  finalityFromReads,
  finalityLabel,
  outcomeLabel,
  outcomeNeedsIssueDetail,
  responseStateLabel,
} from "./labels";

describe("labels for every contract enum value", () => {
  it.each(CASE_STATUSES)("case status %s", (s) => expect(caseStatusLabel(s)).not.toMatch(/^Unrecognised/));
  it.each(RESPONSE_STATES)("response state %s", (s) => expect(responseStateLabel(s)).not.toMatch(/^Unrecognised/));
  it.each(OUTCOMES)("outcome %s", (s) => expect(outcomeLabel(s)).not.toMatch(/^Unrecognised/));
  it.each(DETERMINATIONS)("determination %s", (s) => expect(determinationLabel(s)).not.toMatch(/^Unrecognised/));
  it.each(CONFIDENCE_LEVELS)("confidence %s", (s) => expect(confidenceLabel(s)).not.toMatch(/Unrecognised/));

  it("unknown values are flagged, never mapped to a real label", () => {
    expect(caseStatusLabel("CLOSED")).toBe("Unrecognised case status: CLOSED");
    expect(outcomeLabel(undefined)).toBe("Unrecognised outcome: undefined");
    expect(determinationLabel("MIXED")).toBe("Unrecognised determination: MIXED");
  });
});

describe("specific wording", () => {
  it("INCONCLUSIVE and UNRESOLVED do not sound like a tie or a loss", () => {
    expect(outcomeLabel("INCONCLUSIVE")).toBe("The record did not allow a determination of the claim");
    expect(determinationLabel("UNRESOLVED")).toBe("The record does not establish this issue either way");
  });

  it("missing reply is described as a fact, not intent", () => {
    expect(responseStateLabel("NO_RESPONSE_BY_DEADLINE")).toBe("No reply was recorded before the deadline");
  });

  it("ASSESSMENT_FAILED says nothing about the merits", () => {
    expect(caseStatusLabel("ASSESSMENT_FAILED")).toContain("says nothing about the merits");
  });

  it("confidence is the model's self-report about the determination", () => {
    expect(confidenceLabel("HIGH")).toBe(
      "Model's self-reported certainty in this determination: High (not validator-checked, not a probability)",
    );
  });

  it("partial and inconclusive outcomes always need per-issue detail", () => {
    expect(outcomeNeedsIssueDetail("CLAIM_PARTIALLY_SUPPORTED")).toBe(true);
    expect(outcomeNeedsIssueDetail("INCONCLUSIVE")).toBe(true);
  });
});

describe("lifecycle status and finality are separate", () => {
  it("DECIDED is labelled as recorded, never as final", () => {
    expect(caseStatusLabel("DECIDED")).toBe("Assessment recorded");
    expect(caseStatusLabel("DECIDED").toLowerCase()).not.toContain("final");
  });

  it("finality needs a latest-final read", () => {
    expect(finalityFromReads("DECIDED", null)).toBe("not_checked");
    expect(finalityFromReads("DECIDED", "READY_FOR_ASSESSMENT")).toBe("not_final");
    expect(finalityFromReads("DECIDED", "DECIDED")).toBe("final");
  });

  it("headline keeps the two apart", () => {
    expect(caseHeadline("DECIDED", "not_checked")).toEqual({ status: "Assessment recorded", finality: "Finality not checked" });
    expect(finalityLabel("final")).toBe("Final (confirmed by a latest-final read)");
  });

  it("recorded 2.17C case: DECIDED status alone does not yield final", () => {
    expect(RECORDED_NO_REPLY.case.status).toBe("DECIDED");
    expect(finalityFromReads(RECORDED_NO_REPLY.case.status, null)).toBe("not_checked");
  });
});
