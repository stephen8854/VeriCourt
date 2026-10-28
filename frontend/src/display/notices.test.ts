import { describe, expect, it } from "vitest";
import { NOTICE_NO_RESPONSE, NOTICE_REPLY_CONSIDERED } from "../contract/notices";
import { RECORDED_CLEAR, RECORDED_NO_REPLY } from "../fixtures/recorded";
import { checkStoredNotices, isNoResponse, noResponseNotice } from "./notices";

describe("no-response notice", () => {
  it("returns the contract's exact notice for NO_RESPONSE_BY_DEADLINE", () => {
    expect(noResponseNotice("NO_RESPONSE_BY_DEADLINE")).toBe(NOTICE_NO_RESPONSE);
  });

  it("does not apply to PENDING or SUBMITTED", () => {
    expect(isNoResponse("PENDING")).toBe(false);
    expect(noResponseNotice("PENDING")).toBeNull();
    expect(noResponseNotice("SUBMITTED")).toBeNull();
  });

  it("matches the notice the contract actually stored on StudioNet (Phase 2.17C)", () => {
    expect(RECORDED_NO_REPLY.assessment.notices).toEqual([NOTICE_NO_RESPONSE]);
    expect(noResponseNotice(RECORDED_NO_REPLY.assessment.response_state)).toBe(RECORDED_NO_REPLY.assessment.notices[0]);
  });

  it("never describes silence as an admission, refusal or proof", () => {
    expect(NOTICE_NO_RESPONSE).not.toMatch(/admi|refus|declin|ignor|default|proves|uncontested/i);
  });
});

describe("stored notices pass through verbatim", () => {
  it("recorded reply case (Phase 2.14)", () => {
    const check = checkStoredNotices(RECORDED_CLEAR.assessment.notices, RECORDED_CLEAR.assessment.response_state);
    expect(check).toEqual({ notices: [NOTICE_REPLY_CONSIDERED], mismatch: null });
  });

  it("flags (does not invent) a missing no-response notice — inferred example", () => {
    const check = checkStoredNotices(["something else"], "NO_RESPONSE_BY_DEADLINE");
    expect(check.notices).toEqual(["something else"]);
    expect(check.mismatch).not.toBeNull();
  });
});
