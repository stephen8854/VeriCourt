import { describe, expect, it } from "vitest";
import { RECORDED_CLEAR, RECORDED_NO_REPLY } from "../fixtures/recorded";
import { CLAIMANT_ONLY_CAUTION, claimantOnlyCaution } from "./caution";

const EXACT =
  "Every item cited for this finding was submitted by the claimant, and the respondent did not reply. " +
  "The contract cannot check whether these items are more than the claimant's own account.";

describe("claimant-only evidence caution", () => {
  it("uses the exact approved wording", () => {
    expect(CLAIMANT_ONLY_CAUTION).toBe(EXACT);
  });

  describe("recorded cases", () => {
    it("Phase 2.17C (no reply, UNRESOLVED): no caution, since the finding is not favourable", () => {
      const finding = RECORDED_NO_REPLY.assessment.issue_findings[0]!;
      expect(RECORDED_NO_REPLY.case.response_state).toBe("NO_RESPONSE_BY_DEADLINE");
      expect(claimantOnlyCaution(finding, RECORDED_NO_REPLY.case.response_state, RECORDED_NO_REPLY.evidence)).toBeNull();
    });

    it("Phase 2.14 (reply submitted, SUPPORTED): no caution, since the respondent replied", () => {
      const finding = RECORDED_CLEAR.assessment.issue_findings[0]!;
      expect(RECORDED_CLEAR.case.response_state).toBe("SUBMITTED");
      expect(claimantOnlyCaution(finding, RECORDED_CLEAR.case.response_state, RECORDED_CLEAR.evidence)).toBeNull();
    });
  });

  // Inferred: the recorded 2.17C evidence with a favourable determination the
  // models did NOT produce. This is the dangerous case the contract accepts
  // (tests/direct/test_no_reply_fixture.py::test_contract_accepts_a_finding_resting_on_silence_and_own_assertion).
  describe("inferred findings on the recorded 2.17C evidence (both items claimant-submitted)", () => {
    const evidence = RECORDED_NO_REPLY.evidence;
    it.each([
      ["SUPPORTED", ["E1"]],
      ["SUPPORTED", ["E2"]],
      ["SUPPORTED", ["E1", "E2"]],
      ["PARTIALLY_SUPPORTED", ["E1"]],
    ])("%s citing %j gets the caution", (determination, ids) => {
      expect(
        claimantOnlyCaution({ determination, supporting_evidence_ids: ids }, "NO_RESPONSE_BY_DEADLINE", evidence),
      ).toBe(EXACT);
    });

    it("no caution when the respondent replied", () => {
      expect(claimantOnlyCaution({ determination: "SUPPORTED", supporting_evidence_ids: ["E1"] }, "SUBMITTED", evidence)).toBeNull();
    });

    it("no caution while the reply window state is PENDING (not a missed deadline)", () => {
      expect(claimantOnlyCaution({ determination: "SUPPORTED", supporting_evidence_ids: ["E1"] }, "PENDING", evidence)).toBeNull();
    });

    it("no caution for NOT_SUPPORTED or UNRESOLVED", () => {
      expect(claimantOnlyCaution({ determination: "NOT_SUPPORTED", supporting_evidence_ids: ["E1"] }, "NO_RESPONSE_BY_DEADLINE", evidence)).toBeNull();
      expect(claimantOnlyCaution({ determination: "UNRESOLVED", supporting_evidence_ids: ["E1"] }, "NO_RESPONSE_BY_DEADLINE", evidence)).toBeNull();
    });
  });

  describe("inferred mixed-submitter records", () => {
    const evidence = [
      { evidence_id: "E1", submitter_role: "CLAIMANT" },
      { evidence_id: "E2", submitter_role: "RESPONDENT" },
    ];
    it("no caution when any cited item came from the respondent", () => {
      expect(
        claimantOnlyCaution({ determination: "SUPPORTED", supporting_evidence_ids: ["E1", "E2"] }, "NO_RESPONSE_BY_DEADLINE", evidence),
      ).toBeNull();
    });
    it("no caution when a cited id cannot be found (submitter not established)", () => {
      expect(
        claimantOnlyCaution({ determination: "SUPPORTED", supporting_evidence_ids: ["E1", "E7"] }, "NO_RESPONSE_BY_DEADLINE", evidence),
      ).toBeNull();
    });
  });
});
