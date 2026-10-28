/**
 * Mirror of the enum values in contracts/vericourt.py (schema vericourt-case-v1,
 * assessment vericourt-assessment-v2). Kept in sync by enums.test.ts, which
 * parses the contract source. Do not edit these by hand without the contract.
 */

export const CASE_SCHEMA_VERSION = "vericourt-case-v1";
export const ASSESSMENT_SCHEMA_VERSION = "vericourt-assessment-v2";
export const METHODOLOGY_VERSION = "vericourt-method-v2";

export const CASE_STATUSES = [
  "AWAITING_RESPONSE",
  "READY_FOR_ASSESSMENT",
  "ASSESSMENT_PENDING", // reserved in the contract; never stored
  "DECIDED",
  "ASSESSMENT_FAILED",
] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export const RESPONSE_STATES = ["PENDING", "SUBMITTED", "NO_RESPONSE_BY_DEADLINE"] as const;
export type ResponseState = (typeof RESPONSE_STATES)[number];

export const LOCK_REASONS = ["REPLY_SUBMITTED", "REPLY_WINDOW_EXPIRED"] as const;
export type LockReason = (typeof LOCK_REASONS)[number];

export const ROLES = ["CLAIMANT", "RESPONDENT"] as const;
export type Role = (typeof ROLES)[number];

export const HISTORY_ACTIONS = [
  "CASE_CREATED",
  "EVIDENCE_SUBMITTED",
  "REPLY_SUBMITTED",
  "REPLY_WINDOW_EXPIRED",
  "SNAPSHOT_LOCKED",
  "ASSESSMENT_DECIDED",
  "ASSESSMENT_ATTEMPT_FAILED",
  "ASSESSMENT_UNAVAILABLE",
] as const;
export type HistoryAction = (typeof HISTORY_ACTIONS)[number];

export const CATEGORIES = ["SOFTWARE", "DESIGN", "WRITING", "OTHER"] as const;
export type Category = (typeof CATEGORIES)[number];

export const EVIDENCE_TYPES = ["LINK", "TEXT", "FILE_DIGEST"] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

export const OUTCOMES = ["CLAIM_SUPPORTED", "CLAIM_PARTIALLY_SUPPORTED", "CLAIM_NOT_SUPPORTED", "INCONCLUSIVE"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const DETERMINATIONS = ["SUPPORTED", "PARTIALLY_SUPPORTED", "NOT_SUPPORTED", "UNRESOLVED"] as const;
export type Determination = (typeof DETERMINATIONS)[number];

export const REMEDY_ASSESSMENTS = ["SUPPORTED", "PARTIALLY_SUPPORTED", "NOT_SUPPORTED", "CANNOT_ASSESS"] as const;
export type RemedyAssessment = (typeof REMEDY_ASSESSMENTS)[number];

export const CONFIDENCE_LEVELS = ["LOW", "MEDIUM", "HIGH"] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

/** Determinations that find (fully or partly) in the claimant's favour (contract FAVOURABLE_DETERMINATIONS). */
export const FAVOURABLE_DETERMINATIONS: readonly Determination[] = ["SUPPORTED", "PARTIALLY_SUPPORTED"];

/** Return value of request_assessment when consensus agreed the model output was invalid. */
export const ATTEMPT_FAILED = "ATTEMPT_FAILED";
export const MAX_ASSESSMENT_ATTEMPTS = 2;

export function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}
