/**
 * Human-readable labels for contract enums (Phase 2.18B display rules).
 *
 * Lifecycle status (contract state) and transaction finality are separate:
 * `DECIDED` means an assessment was stored, not that it is final.
 * Labels never imply a legal judgment, guaranteed truth, payment or enforcement.
 */
import {
  CASE_STATUSES,
  CONFIDENCE_LEVELS,
  DETERMINATIONS,
  OUTCOMES,
  RESPONSE_STATES,
  isOneOf,
  type CaseStatus,
  type ConfidenceLevel,
  type Determination,
  type Outcome,
  type ResponseState,
} from "../contract/enums";

const CASE_STATUS_LABELS: Record<CaseStatus, string> = {
  AWAITING_RESPONSE: "Awaiting the respondent's reply",
  READY_FOR_ASSESSMENT: "Record locked; an assessment can be requested",
  ASSESSMENT_PENDING: "Reserved state (never stored by the contract)",
  DECIDED: "Assessment recorded",
  ASSESSMENT_FAILED:
    "No valid assessment could be produced after 2 attempts. This says nothing about the merits of the claim.",
};

const RESPONSE_STATE_LABELS: Record<ResponseState, string> = {
  PENDING: "No reply recorded yet",
  SUBMITTED: "The respondent replied",
  NO_RESPONSE_BY_DEADLINE: "No reply was recorded before the deadline",
};

const OUTCOME_LABELS: Record<Outcome, string> = {
  CLAIM_SUPPORTED: "Every issue was found supported by the record",
  CLAIM_PARTIALLY_SUPPORTED: "At least one issue was found at least partly supported by the record",
  CLAIM_NOT_SUPPORTED: "No issue was found supported; every issue was found not supported by the record",
  INCONCLUSIVE: "The record did not allow a determination of the claim",
};

const DETERMINATION_LABELS: Record<Determination, string> = {
  SUPPORTED: "The record supports the claimant on this issue",
  PARTIALLY_SUPPORTED: "The record supports part of the claimant's position on this issue",
  NOT_SUPPORTED: "The record does not support the claimant on this issue",
  UNRESOLVED: "The record does not establish this issue either way",
};

const CONFIDENCE_WORDS: Record<ConfidenceLevel, string> = { LOW: "Low", MEDIUM: "Medium", HIGH: "High" };

export function unrecognised(kind: string, value: unknown): string {
  return `Unrecognised ${kind}: ${String(value)}`;
}

export function caseStatusLabel(status: unknown): string {
  return isOneOf(CASE_STATUSES, status) ? CASE_STATUS_LABELS[status] : unrecognised("case status", status);
}

export function responseStateLabel(state: unknown): string {
  return isOneOf(RESPONSE_STATES, state) ? RESPONSE_STATE_LABELS[state] : unrecognised("response state", state);
}

export function outcomeLabel(outcome: unknown): string {
  return isOneOf(OUTCOMES, outcome) ? OUTCOME_LABELS[outcome] : unrecognised("outcome", outcome);
}

/** CLAIM_PARTIALLY_SUPPORTED covers a wide range: the UI must always show per-issue determinations with it. */
export function outcomeNeedsIssueDetail(outcome: unknown): boolean {
  return outcome !== "CLAIM_SUPPORTED";
}

export function determinationLabel(determination: unknown): string {
  return isOneOf(DETERMINATIONS, determination)
    ? DETERMINATION_LABELS[determination]
    : unrecognised("determination", determination);
}

export function confidenceLabel(level: unknown): string {
  const word = isOneOf(CONFIDENCE_LEVELS, level) ? CONFIDENCE_WORDS[level] : unrecognised("confidence", level);
  return `Model's self-reported certainty in this determination: ${word} (not validator-checked, not a probability)`;
}

// ---------------------------------------------------------------------------
// Finality: separate from lifecycle status.
// ---------------------------------------------------------------------------

export type Finality = "not_checked" | "not_final" | "final";

/**
 * Finality of the current case state, judged only from reads at both
 * transaction-hash variants. `final` requires a latest-final read that shows
 * the same status as latest-nonfinal. A status alone (even DECIDED) is never
 * evidence of finality.
 */
export function finalityFromReads(nonfinalStatus: unknown, finalStatus: unknown | null): Finality {
  if (finalStatus === null || finalStatus === undefined) return "not_checked";
  return finalStatus === nonfinalStatus ? "final" : "not_final";
}

const FINALITY_LABELS: Record<Finality, string> = {
  not_checked: "Finality not checked",
  not_final: "Not yet final",
  final: "Final (confirmed by a latest-final read)",
};

export function finalityLabel(finality: Finality): string {
  return FINALITY_LABELS[finality];
}

/** Headline for a case: lifecycle label plus a separate finality qualifier. */
export function caseHeadline(status: unknown, finality: Finality): { status: string; finality: string } {
  return { status: caseStatusLabel(status), finality: finalityLabel(finality) };
}
