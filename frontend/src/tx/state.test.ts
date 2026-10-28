import { describe, expect, it } from "vitest";
import {
  BLOCKING_PHASES,
  INITIAL_TX_STATE,
  InvalidTransition,
  PHASE_VERIFICATION,
  SETTLED_PHASES,
  UNCERTAIN_PHASES,
  canStartWrite,
  txReducer,
  type TxEvent,
  type TxPhase,
  type TxState,
} from "./state";

const run = (events: TxEvent[], start: TxState = INITIAL_TX_STATE) => events.reduce(txReducer, start);
const at = (phase: TxPhase, txHash: string | null = null): TxState => ({ phase, txHash, note: null });
const HASH = `0x${"ab".repeat(32)}`;
const ALL_PHASES = Object.keys(PHASE_VERIFICATION) as TxPhase[];
const SENT = [{ type: "PREPARE" }, { type: "REQUEST_WALLET" }, { type: "SUBMITTED", txHash: HASH }] as const satisfies TxEvent[];

describe("transaction state model", () => {
  it("represents every required state", () => {
    expect(ALL_PHASES.sort()).toEqual(
      [
        "idle", "preparing", "awaiting_wallet", "rejected", "not_sent", "submitted", "submission_uncertain",
        "pending", "accepted", "execution_failed", "validator_disagreement", "undetermined", "finalized",
        "finalized_unsuccessful", "verified", "verification_mismatch", "timed_out_unknown", "read_failure",
        "confirmed_by_state",
      ].sort(),
    );
  });

  it("every phase is either settled or blocking, never both", () => {
    for (const phase of ALL_PHASES) {
      expect(SETTLED_PHASES.includes(phase) !== BLOCKING_PHASES.includes(phase)).toBe(true);
    }
  });

  it("success needs acceptance, finality AND a matching post-finality read", () => {
    const accepted = run([...SENT, { type: "OBSERVED", category: "PENDING" }, { type: "OBSERVED", category: "ACCEPTED_SUCCESS" }]);
    expect(accepted).toEqual(at("accepted", HASH));
    const finalized = txReducer(accepted, { type: "OBSERVED", category: "FINALIZED_SUCCESS" });
    expect(finalized.phase).toBe("finalized");
    expect(canStartWrite(finalized)).toBe(false);
    expect(() => txReducer(finalized, { type: "RESET" })).toThrow(InvalidTransition);
    expect(txReducer(finalized, { type: "VERIFIED" }).phase).toBe("verified");
    expect(txReducer(finalized, { type: "VERIFICATION_MISMATCH", message: "no new case" })).toMatchObject({
      phase: "verification_mismatch",
      note: "no new case",
    });
  });

  it("VERIFIED is only possible after finality", () => {
    for (const phase of ALL_PHASES.filter((p) => p !== "finalized")) {
      expect(() => txReducer(at(phase, HASH), { type: "VERIFIED" })).toThrow(InvalidTransition);
    }
  });

  it.each([
    ["ACCEPTED_EXECUTION_FAILED", false, "execution_failed"],
    ["FINALIZED_EXECUTION_FAILED", true, "finalized_unsuccessful"],
    ["VALIDATOR_DISAGREEMENT", false, "validator_disagreement"],
    ["VALIDATOR_DISAGREEMENT", true, "finalized_unsuccessful"],
    ["UNDETERMINED", false, "undetermined"],
    ["UNDETERMINED", true, "finalized_unsuccessful"],
    ["UNRECOGNIZED", false, "read_failure"],
  ] as const)("observing %s (final=%s) gives %s", (category, final, phase) => {
    expect(txReducer(at("pending", HASH), { type: "OBSERVED", category, final }).phase).toBe(phase);
  });

  it("non-final failures keep blocking and can still move to finality", () => {
    for (const phase of ["execution_failed", "validator_disagreement", "undetermined"] as const) {
      expect(canStartWrite(at(phase, HASH))).toBe(false);
      expect(() => txReducer(at(phase, HASH), { type: "RESET" })).toThrow(InvalidTransition);
      expect(txReducer(at(phase, HASH), { type: "OBSERVED", category: "FINALIZED_SUCCESS" }).phase).toBe("finalized");
    }
  });

  it("wallet rejection is its own settled state and records that nothing was sent", () => {
    const s = run([{ type: "PREPARE" }, { type: "REQUEST_WALLET" }, { type: "WALLET_REJECTED" }]);
    expect(s.phase).toBe("rejected");
    expect(s.note).toMatch(/Nothing was sent/);
    expect(txReducer(s, { type: "RESET" })).toEqual(INITIAL_TX_STATE);
  });

  it("a write refused or failed before any request is not_sent", () => {
    expect(run([{ type: "PREPARE" }, { type: "NOT_SENT", message: "x" }]).phase).toBe("not_sent");
    expect(run([{ type: "PREPARE" }, { type: "REQUEST_WALLET" }, { type: "NOT_SENT", message: "x" }]).phase).toBe("not_sent");
    expect(() => txReducer(at("submitted", HASH), { type: "NOT_SENT", message: "x" })).toThrow(InvalidTransition);
  });

  it("not found yet keeps the submitted state", () => {
    const s = run([...SENT, { type: "NOT_FOUND_YET" }]);
    expect(s).toMatchObject({ phase: "submitted", txHash: HASH, note: "Not found yet." });
  });

  it("an accepted write cannot be turned into a failure", () => {
    expect(() => txReducer(at("accepted", HASH), { type: "OBSERVED", category: "VALIDATOR_DISAGREEMENT" })).toThrow(InvalidTransition);
  });

  it("timeouts and read failures are distinct unknown states", () => {
    expect(txReducer(at("pending", HASH), { type: "POLL_TIMED_OUT" }).phase).toBe("timed_out_unknown");
    expect(txReducer(at("pending", HASH), { type: "READ_FAILED" }).phase).toBe("read_failure");
  });
});

describe("no automatic retries; duplicates are blocked", () => {
  it("only idle allows a new write", () => {
    for (const phase of ALL_PHASES) expect(canStartWrite(at(phase))).toBe(phase === "idle");
  });

  it.each(BLOCKING_PHASES.map((p) => [p]))("%s blocks PREPARE and cannot be RESET", (phase) => {
    expect(() => txReducer(at(phase, HASH), { type: "PREPARE" })).toThrow(InvalidTransition);
    expect(() => txReducer(at(phase, HASH), { type: "RESET" })).toThrow(InvalidTransition);
  });

  it("an uncertain submission leaves only through read-only reconciliation", () => {
    const uncertain = run([{ type: "PREPARE" }, { type: "REQUEST_WALLET" }, { type: "SUBMISSION_UNCERTAIN", message: "timeout" }]);
    expect(uncertain.phase).toBe("submission_uncertain");
    for (const event of [{ type: "RESET" }, { type: "PREPARE" }, { type: "SUBMITTED", txHash: HASH }, { type: "NOT_SENT", message: "x" }] as TxEvent[]) {
      expect(() => txReducer(uncertain, event)).toThrow(InvalidTransition);
    }
    const notSent = txReducer(uncertain, { type: "RECONCILED_NOT_SENT", basis: "guard journal" });
    expect(notSent.phase).toBe("not_sent");
    expect(notSent.note).toMatch(/guard journal/);
    expect(txReducer(uncertain, { type: "RECONCILED_FOUND", txHash: HASH })).toEqual(at("submitted", HASH));
  });

  it("reconciliation events are only accepted in uncertain phases", () => {
    for (const phase of ALL_PHASES.filter((p) => !UNCERTAIN_PHASES.includes(p))) {
      expect(() => txReducer(at(phase, HASH), { type: "RECONCILED_FOUND", txHash: HASH })).toThrow(InvalidTransition);
      expect(() => txReducer(at(phase, HASH), { type: "RECONCILED_EFFECT_FINAL", basis: "x" })).toThrow(InvalidTransition);
    }
  });

  it("an effect confirmed by final contract state settles without a transaction id and forbids repeating", () => {
    for (const phase of UNCERTAIN_PHASES) {
      const s = txReducer(at(phase), { type: "RECONCILED_EFFECT_FINAL", basis: "case VC-000003 matches" });
      expect(s).toMatchObject({ phase: "confirmed_by_state", txHash: null });
      expect(s.note).toMatch(/must not be repeated/);
      expect(SETTLED_PHASES).toContain("confirmed_by_state");
    }
  });

  it("there is no retry event type", () => {
    const events: TxEvent["type"][] = [
      "PREPARE", "REQUEST_WALLET", "WALLET_REJECTED", "NOT_SENT", "SUBMITTED", "SUBMISSION_UNCERTAIN",
      "NOT_FOUND_YET", "OBSERVED", "POLL_TIMED_OUT", "READ_FAILED", "VERIFIED", "VERIFICATION_MISMATCH",
      "RECONCILED_NOT_SENT", "RECONCILED_FOUND", "RECONCILED_EFFECT_FINAL", "RESET",
    ];
    expect(events.some((e) => /retry|resubmit/i.test(e))).toBe(false);
  });

  it("the unverified JS mapping for 'submitted' is recorded", () => {
    expect(PHASE_VERIFICATION.submitted).toMatch(/^UNVERIFIED/);
  });
});
