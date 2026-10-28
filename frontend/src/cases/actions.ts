/**
 * Which contract writes the viewer could make on a case right now, judged
 * from validated reads and this device's clock (pure). This is guidance only:
 * the contract enforces every rule, and every write re-checks fresh state in
 * its preflight. Nothing here sends anything.
 */
import type { CaseView, EvidenceView } from "../contract/types";
import type { ContractWriteMethod } from "../write/methods";
import type { AssessmentStatusView } from "./caseReads";
import type { ViewerRole } from "../display/caseText";

/**
 * Safety margin around the reply deadline, in seconds. The contract judges the
 * deadline by the transaction's time; this device's clock may differ, and
 * StudioNet's write simulation runs behind real time, so writes near the
 * deadline are not offered.
 */
export const DEADLINE_MARGIN_SECONDS = 600;

export const MAX_EVIDENCE_PER_PARTY = 10;
export const MAX_EVIDENCE_PER_CASE = 20;

export interface CaseAction {
  method: Exclude<ContractWriteMethod, "create_case">;
  label: string;
  available: boolean;
  /** Why it is not available (or a caveat when it is). */
  note: string;
}

export function caseActions(
  c: CaseView,
  role: ViewerRole,
  status: AssessmentStatusView | null,
  evidence: readonly EvidenceView[] | null,
  nowSeconds: number,
): CaseAction[] {
  const party = role !== null;
  const awaiting = c.status === "AWAITING_RESPONSE" && c.response_state === "PENDING";
  const beforeDeadline = nowSeconds <= c.reply_deadline - DEADLINE_MARGIN_SECONDS;
  const wellAfterDeadline = nowSeconds >= c.reply_deadline + DEADLINE_MARGIN_SECONDS;
  const notParty = "Only the claimant or the respondent can do this; connect the wallet of a party.";

  const own = role === "CLAIMANT" ? c.claimant_evidence_count : role === "RESPONDENT" ? c.respondent_evidence_count : 0;
  const total = evidence?.length ?? c.evidence_count;
  let evidenceNote = "";
  let evidenceOk = party && c.status === "AWAITING_RESPONSE" && !c.snapshot_locked && beforeDeadline;
  if (!party) evidenceNote = notParty;
  else if (c.snapshot_locked || c.status !== "AWAITING_RESPONSE") evidenceNote = "The record is locked; no more evidence can be added.";
  else if (!beforeDeadline) evidenceNote = "The reply deadline has passed or is less than 10 minutes away (by this device's clock).";
  else if (own >= MAX_EVIDENCE_PER_PARTY) {
    evidenceOk = false;
    evidenceNote = `You have submitted the maximum of ${MAX_EVIDENCE_PER_PARTY} items.`;
  } else if (total >= MAX_EVIDENCE_PER_CASE) {
    evidenceOk = false;
    evidenceNote = `The case has the maximum of ${MAX_EVIDENCE_PER_CASE} items.`;
  } else evidenceNote = `${MAX_EVIDENCE_PER_PARTY - own} of your ${MAX_EVIDENCE_PER_PARTY} items remain.`;

  const replyOk = role === "RESPONDENT" && awaiting && beforeDeadline;
  const replyNote =
    role !== "RESPONDENT"
      ? "Only the respondent can reply."
      : !awaiting
        ? "A reply can no longer be recorded on this case."
        : !beforeDeadline
          ? "The reply deadline has passed or is less than 10 minutes away (by this device's clock)."
          : "Submitting the reply locks the record: add any evidence first.";

  const deadlineOk = party && awaiting && wellAfterDeadline;
  const deadlineNote = !party
    ? notParty
    : !awaiting
      ? "Nothing to record: the case is not awaiting a reply."
      : !wellAfterDeadline
        ? "Available from 10 minutes after the reply deadline (by this device's clock)."
        : "Records that no reply was received before the deadline, and locks the record.";

  const assessOk = party && status !== null && status.can_request;
  const assessNote = !party
    ? notParty
    : status === null
      ? "The assessment status could not be read."
      : status.can_request
        ? `${status.remaining_attempts} of ${status.max_attempts} attempts remain.`
        : c.status === "AWAITING_RESPONSE"
          ? "Available once the record is locked (after the reply, or after the missed deadline is recorded)."
          : "No assessment can be requested on this case.";

  return [
    { method: "submit_evidence", label: "Submit evidence", available: evidenceOk, note: evidenceNote },
    { method: "submit_reply", label: "Reply as respondent", available: replyOk, note: replyNote },
    { method: "process_reply_deadline", label: "Record the missed reply deadline", available: deadlineOk, note: deadlineNote },
    { method: "request_assessment", label: "Request the assessment", available: assessOk, note: assessNote },
  ];
}
