/**
 * Wording for the general case views (Phase 4.0B): reply window, record
 * lock, history entries, roles and times. Procedural and neutral: silence is
 * never described as anything but a procedural fact, the browser's clock is
 * never presented as the contract's, and no label implies a judgment.
 * Every string here is scanned by forbidden-terms.test.ts.
 */
import { HISTORY_ACTIONS, LOCK_REASONS, isOneOf, type HistoryAction, type LockReason } from "../contract/enums";
import type { CaseView } from "../contract/types";
import { unrecognised } from "./labels";
import { noResponseNotice } from "./notices";

/** "2026-10-19 07:38:35 UTC" (contract times are Unix seconds). */
export function formatUtc(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "not recorded";
  return `${new Date(seconds * 1000).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

const HISTORY_LABELS: Record<HistoryAction, string> = {
  CASE_CREATED: "Case created by the claimant",
  EVIDENCE_SUBMITTED: "Evidence submitted",
  REPLY_SUBMITTED: "Respondent's reply recorded",
  REPLY_WINDOW_EXPIRED: "Reply window closed with no reply recorded",
  SNAPSHOT_LOCKED: "Record locked for assessment",
  ASSESSMENT_DECIDED: "Assessment recorded",
  ASSESSMENT_ATTEMPT_FAILED: "Assessment attempt produced no valid result",
  ASSESSMENT_UNAVAILABLE: "No valid assessment after the maximum number of attempts",
};

export function historyActionLabel(action: unknown): string {
  return isOneOf(HISTORY_ACTIONS, action) ? HISTORY_LABELS[action] : unrecognised("history action", action);
}

const LOCK_REASON_LABELS: Record<LockReason, string> = {
  REPLY_SUBMITTED: "locked when the respondent's reply was recorded",
  REPLY_WINDOW_EXPIRED: "locked when the reply window closed with no reply recorded",
};

export function lockReasonLabel(reason: unknown): string {
  return isOneOf(LOCK_REASONS, reason) ? LOCK_REASON_LABELS[reason] : unrecognised("lock reason", reason);
}

export function roleLabel(role: unknown): string {
  return role === "CLAIMANT" ? "Claimant" : role === "RESPONDENT" ? "Respondent" : unrecognised("role", role);
}

export type ViewerRole = "CLAIMANT" | "RESPONDENT" | null;

/** The connected account's role in this case, or null (observer / not connected). */
export function viewerRole(c: Pick<CaseView, "claimant" | "respondent">, account: string | null): ViewerRole {
  if (account === null) return null;
  const a = account.toLowerCase();
  if (c.claimant.toLowerCase() === a) return "CLAIMANT";
  if (c.respondent.toLowerCase() === a) return "RESPONDENT";
  return null;
}

export const DEVICE_CLOCK_NOTE =
  "Times are compared with this device's clock. The contract uses the time of the transaction that runs, so it decides.";

export interface ReplyWindowView {
  tone: "open" | "closed_unprocessed" | "replied" | "no_reply";
  headline: string;
  detail: string;
}

/**
 * The reply window as the contract and this device's clock show it. A passed
 * deadline is never described as "no response" until the contract records
 * NO_RESPONSE_BY_DEADLINE.
 */
export function replyWindowView(
  c: Pick<CaseView, "status" | "response_state" | "reply_deadline" | "replied_at">,
  nowSeconds: number,
): ReplyWindowView {
  const deadline = formatUtc(c.reply_deadline);
  if (c.response_state === "SUBMITTED") {
    return { tone: "replied", headline: "The respondent replied", detail: `Reply recorded at ${formatUtc(c.replied_at)} (deadline was ${deadline}).` };
  }
  const notice = noResponseNotice(c.response_state);
  if (notice !== null) return { tone: "no_reply", headline: "No reply was recorded before the deadline", detail: notice };
  if (c.response_state === "PENDING" && c.status === "AWAITING_RESPONSE") {
    if (nowSeconds <= c.reply_deadline) {
      return {
        tone: "open",
        headline: `Reply window open until ${deadline}`,
        detail: "Until then, both parties can submit evidence and the respondent can reply. The respondent's reply locks the record.",
      };
    }
    return {
      tone: "closed_unprocessed",
      headline: `The reply window appears to have closed (${deadline}, by this device's clock)`,
      detail:
        "The contract has not recorded this yet. Either party can ask the contract to record that no reply was received before the deadline; until then the case stays awaiting a reply.",
    };
  }
  return { tone: "open", headline: `Reply deadline ${deadline}`, detail: "" };
}
