import { describe, expect, it } from "vitest";
import { RECORDED_CLEAR, RECORDED_NO_REPLY, RECORDED_PHASE_2_8_TX } from "../fixtures/recorded";
import liveSubset from "../fixtures/recorded/phase-3-3-live-sdk-tx-subset.json";
import { SUCCESS_CATEGORIES, classifyTransaction, decodeLeaderResult } from "./classify";

/**
 * What genlayer-js 1.1.8 does to a Studio transaction in getTransaction (verified
 * from dist/index.js transactionActions.getTransaction): numeric `status` plus a
 * `statusName`. `decodeLocalnetTransaction` is not applied here; its effect on
 * the leader receipt in a browser is unverified (Phase 3.3).
 */
function asSdkStudioView(raw: Record<string, unknown>): Record<string, unknown> {
  const statusNames = [
    "UNINITIALIZED", "PENDING", "PROPOSING", "COMMITTING", "REVEALING", "ACCEPTED", "UNDETERMINED",
    "FINALIZED", "CANCELED", "APPEAL_REVEALING", "APPEAL_COMMITTING", "READY_TO_FINALIZE",
    "VALIDATORS_TIMEOUT", "LEADER_TIMEOUT",
  ];
  const name = raw.status === "ACTIVATED" ? "PENDING" : String(raw.status);
  return { ...raw, status: statusNames.indexOf(name), statusName: name };
}

describe("verified: real StudioNet transaction (Phase 2.8 assessment, raw eth_getTransactionByHash result)", () => {
  it("raw response is FINALIZED with MAJORITY_DISAGREE", () => {
    expect(RECORDED_PHASE_2_8_TX.status).toBe("FINALIZED");
    expect(RECORDED_PHASE_2_8_TX.result_name).toBe("MAJORITY_DISAGREE");
  });

  it.each([
    ["raw StudioNet shape", RECORDED_PHASE_2_8_TX],
    ["after genlayer-js getTransaction status mapping", asSdkStudioView(RECORDED_PHASE_2_8_TX)],
  ])("%s is a validator disagreement, never a success", (_name, tx) => {
    const view = classifyTransaction(tx);
    expect(view.category).toBe("VALIDATOR_DISAGREEMENT");
    expect(view.final).toBe(true);
    expect(SUCCESS_CATEGORIES).not.toContain(view.category);
    expect(view.lastRoundVotes).toEqual(["IDLE", "DISAGREE", "DISAGREE", "DISAGREE", "IDLE"]);
  });

  it("its leader receipt list holds a validator-mode receipt with ERROR; the leader one is selected by mode", () => {
    const receipts = (RECORDED_PHASE_2_8_TX.consensus_data as { leader_receipt: Array<Record<string, unknown>> }).leader_receipt;
    expect(receipts.map((r) => [r.mode, r.execution_result])).toEqual([
      ["leader", "SUCCESS"],
      ["validator", "ERROR"],
    ]);
    // Same transaction with consensus forced to agree: the leader (mode "leader") receipt decides.
    const agreed = { ...RECORDED_PHASE_2_8_TX, result_name: "MAJORITY_AGREE" };
    const view = classifyTransaction(agreed);
    expect(view.category).toBe("FINALIZED_SUCCESS");
    expect(view.leaderResultPayload).toBeNull(); // base64 'return' payload is not decoded to text
    expect(decodeLeaderResult(receipts[0]!.result).status).toBe("return");
    expect(decodeLeaderResult(receipts[1]!.result).status).toBe("contract_error");
  });
});

describe("verified live: genlayer-js 1.1.8 getTransaction in a browser (Phase 3.3, verbatim subset)", () => {
  it("classifies the observed shape as FINALIZED_SUCCESS with the decoded leader payload", () => {
    const view = classifyTransaction(liveSubset.transaction);
    expect(view).toMatchObject({
      category: "FINALIZED_SUCCESS",
      statusName: "FINALIZED",
      resultName: "MAJORITY_AGREE",
      final: true,
      leaderExecution: "SUCCESS",
      leaderResultStatus: "return",
      leaderResultPayload: '"INCONCLUSIVE"',
      lastRoundVotes: ["IDLE", "IDLE", "AGREE", "AGREE", "AGREE"],
    });
  });

  it("the SDK returns snake_case consensus fields plus statusName; no camelCase resultName", () => {
    const tx = liveSubset.transaction as Record<string, unknown>;
    expect(tx.statusName).toBe("FINALIZED");
    expect(tx.status).toBe(7);
    expect(tx).not.toHaveProperty("resultName");
    expect(tx).not.toHaveProperty("txExecutionResultName");
  });
});

/**
 * Reconstructed: field values recorded by the Python harness on StudioNet
 * (status, consensus result, leader execution/result status, votes), placed in
 * the verified raw Studio shape. The surrounding shape is inferred.
 */
function reconstruct(lastView: Record<string, unknown>): Record<string, unknown> {
  return {
    status: lastView.status_name,
    result_name: lastView.result_name,
    consensus_data: {
      leader_receipt: [
        {
          mode: "leader",
          execution_result: lastView.leader_execution_result,
          result: { status: lastView.leader_result_status, payload: { readable: lastView.leader_result_payload } },
        },
      ],
    },
    last_round: { validator_votes_name: lastView.votes },
  };
}

describe("reconstructed from recorded harness values (shape inferred)", () => {
  it("Phase 2.17C assessment: accepted, then finalized, INCONCLUSIVE returned", () => {
    const accepted = classifyTransaction(reconstruct(RECORDED_NO_REPLY.harnessLastViews["no_reply.request_assessment"]!));
    const finalized = classifyTransaction(reconstruct(RECORDED_NO_REPLY.harnessLastViews["no_reply.request_assessment.finality"]!));
    expect(accepted.category).toBe("ACCEPTED_SUCCESS");
    expect(accepted.final).toBe(false);
    expect(finalized.category).toBe("FINALIZED_SUCCESS");
    expect(finalized.leaderResultPayload).toBe('"INCONCLUSIVE"');
    expect(finalized.lastRoundVotes).toEqual(["IDLE", "IDLE", "AGREE", "AGREE", "AGREE"]);
  });

  it("Phase 2.14 writes all classify as accepted successes", () => {
    for (const [step, lastView] of Object.entries(RECORDED_CLEAR.harnessLastViews)) {
      const expected = step.endsWith(".finality") ? "FINALIZED_SUCCESS" : "ACCEPTED_SUCCESS";
      expect(classifyTransaction(reconstruct(lastView)).category).toBe(expected);
    }
  });
});

/** Inferred: synthetic shapes built from genlayer-js enums; never observed on StudioNet. */
describe("inferred synthetic transactions", () => {
  const tx = (status: string, result: string | null, execution = "SUCCESS", code = "return") => ({
    statusName: status,
    resultName: result,
    consensus_data: { leader_receipt: [{ mode: "leader", execution_result: execution, result: { status: code, payload: null } }] },
  });

  it.each([
    [tx("PENDING", "IDLE"), "PENDING"],
    [tx("PROPOSING", "IDLE"), "PENDING"],
    [tx("READY_TO_FINALIZE", "MAJORITY_AGREE"), "PENDING"],
    [tx("ACCEPTED", "MAJORITY_AGREE"), "ACCEPTED_SUCCESS"],
    [tx("FINALIZED", "MAJORITY_AGREE"), "FINALIZED_SUCCESS"],
    [tx("ACCEPTED", "MAJORITY_AGREE", "ERROR", "rollback"), "ACCEPTED_EXECUTION_FAILED"],
    [tx("FINALIZED", "MAJORITY_AGREE", "SUCCESS", "contract_error"), "FINALIZED_EXECUTION_FAILED"],
    [tx("UNDETERMINED", "MAJORITY_DISAGREE"), "VALIDATOR_DISAGREEMENT"],
    [tx("ACCEPTED", "MAJORITY_DISAGREE"), "VALIDATOR_DISAGREEMENT"],
    [tx("UNDETERMINED", "NO_MAJORITY"), "UNDETERMINED"],
    [tx("LEADER_TIMEOUT", "TIMEOUT"), "UNDETERMINED"],
    [tx("CANCELED", null), "UNDETERMINED"],
    [tx("ACCEPTED", null), "UNRECOGNIZED"],
    [tx("SOMETHING_NEW", "MAJORITY_AGREE"), "UNRECOGNIZED"],
    [tx("ACCEPTED", "MAJORITY_AGREE", "SUCCESS", "none"), "UNRECOGNIZED"],
    [{ statusName: "ACCEPTED", resultName: "MAJORITY_AGREE", consensus_data: { leader_receipt: [] } }, "UNRECOGNIZED"],
    ["not an object", "UNRECOGNIZED"],
    [null, "UNRECOGNIZED"],
  ])("%j -> %s", (input, expected) => {
    expect(classifyTransaction(input).category).toBe(expected);
  });

  it("a returned receipt with a successful leader is not success without MAJORITY_AGREE", () => {
    expect(classifyTransaction(tx("ACCEPTED", "MAJORITY_DISAGREE")).category).not.toMatch(/SUCCESS/);
  });

  it("decodes a base64 rollback result", () => {
    const b64 = btoa("\u0001case evidence is locked");
    expect(decodeLeaderResult(b64)).toEqual({ status: "rollback", payload: "case evidence is locked" });
  });
});
