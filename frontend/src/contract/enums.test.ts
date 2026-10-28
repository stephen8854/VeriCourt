import { describe, expect, it } from "vitest";
import { pyConcatString, pyNameTuple, pyString, pyStringTuple } from "../test/contractSource";
import * as E from "./enums";
import * as N from "./notices";

describe("TypeScript mirror matches contracts/vericourt.py", () => {
  it("versions", () => {
    expect(E.CASE_SCHEMA_VERSION).toBe(pyString("SCHEMA_VERSION"));
    expect(E.ASSESSMENT_SCHEMA_VERSION).toBe(pyString("ASSESSMENT_SCHEMA_VERSION"));
    expect(E.METHODOLOGY_VERSION).toBe(pyString("METHODOLOGY_VERSION"));
  });

  it("enum tuples", () => {
    expect([...E.CASE_STATUSES]).toEqual(pyNameTuple("ALL_STATUSES"));
    expect([...E.CATEGORIES]).toEqual(pyNameTuple("CATEGORIES"));
    expect([...E.EVIDENCE_TYPES]).toEqual(pyNameTuple("EVIDENCE_TYPES"));
    expect([...E.OUTCOMES]).toEqual(pyNameTuple("OUTCOMES"));
    expect([...E.DETERMINATIONS]).toEqual(pyNameTuple("DETERMINATIONS"));
    expect([...E.REMEDY_ASSESSMENTS]).toEqual(pyNameTuple("REMEDY_ASSESSMENTS"));
    expect([...E.CONFIDENCE_LEVELS]).toEqual(pyNameTuple("CONFIDENCE_LEVELS"));
    expect([...E.FAVOURABLE_DETERMINATIONS]).toEqual(pyNameTuple("FAVOURABLE_DETERMINATIONS"));
  });

  it("single-value constants", () => {
    expect([...E.RESPONSE_STATES]).toEqual(["RESPONSE_PENDING", "RESPONSE_SUBMITTED", "RESPONSE_NONE_BY_DEADLINE"].map(pyString));
    expect([...E.LOCK_REASONS]).toEqual(["LOCK_REASON_REPLY", "LOCK_REASON_EXPIRED"].map(pyString));
    expect([...E.ROLES]).toEqual(["ROLE_CLAIMANT", "ROLE_RESPONDENT"].map(pyString));
    expect([...E.HISTORY_ACTIONS]).toEqual(
      [
        "ACTION_CASE_CREATED",
        "ACTION_EVIDENCE_SUBMITTED",
        "ACTION_REPLY_SUBMITTED",
        "ACTION_REPLY_WINDOW_EXPIRED",
        "ACTION_SNAPSHOT_LOCKED",
        "ACTION_ASSESSMENT_DECIDED",
        "ACTION_ASSESSMENT_ATTEMPT_FAILED",
        "ACTION_ASSESSMENT_UNAVAILABLE",
      ].map(pyString),
    );
  });

  it("notices are verbatim", () => {
    expect(N.NOTICE_NO_RESPONSE).toBe(pyConcatString("NOTICE_NO_RESPONSE"));
    expect(N.NOTICE_REPLY_CONSIDERED).toBe(pyString("NOTICE_REPLY_CONSIDERED"));
    expect(N.NOTICE_EXTERNAL_NOT_OPENED).toBe(pyConcatString("NOTICE_EXTERNAL_NOT_OPENED"));
    expect([...N.STANDARD_NOTICES]).toEqual(pyStringTuple("STANDARD_NOTICES"));
    expect(N.PROVENANCE_NOTICE).toBe(pyConcatString("PROVENANCE_NOTICE"));
  });
});
