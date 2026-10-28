/**
 * Shapes returned by the contract's view methods (contracts/vericourt.py,
 * get_case / get_case_status / get_case_evidence / get_case_history /
 * get_assessment_status / get_assessment). Field names are verified from the
 * contract source and from StudioNet read-backs recorded in Phases 2.14-2.17C
 * (via genlayer-py). How genlayer-js 1.1.8 decodes them in a browser is not
 * yet verified (Phase 3.3); readers must validate before trusting a shape.
 */

export interface CaseIssue {
  issue_id: string;
  description: string;
}

export interface CaseView {
  case_id: string;
  schema_version: string;
  claimant: string;
  respondent: string;
  category: string;
  title: string;
  agreement_summary: string;
  expected_deliverable: string;
  claim: string;
  requested_remedy: string;
  issues: CaseIssue[];
  created_at: number;
  reply_window_seconds: number;
  reply_deadline: number;
  status: string;
  response_state: string;
  reply: string;
  replied_at: number;
  evidence_count: number;
  claimant_evidence_count: number;
  respondent_evidence_count: number;
  snapshot_locked: boolean;
  locked_at: number;
  lock_reason: string;
  locked_evidence_count: number;
  assessment_attempts: number;
  max_assessment_attempts: number;
  last_assessment_error: string;
  snapshot_digest: string;
  history_count: number;
}

export interface EvidenceView {
  evidence_id: string;
  submitter: string;
  submitter_role: string;
  evidence_type: string;
  label: string;
  description: string;
  content_ref: string;
  sha256: string;
  submitted_at: number;
  issue_ids: string[];
  in_locked_snapshot: boolean;
}

export interface HistoryEntryView {
  seq: number;
  action: string;
  actor: string;
  at: number;
  detail: string;
}

export interface IssueFindingView {
  issue_id: string;
  determination: string;
  confidence: string;
  finding: string;
  reasoning: string;
  supporting_evidence_ids: string[];
  counter_evidence_ids: string[];
  open_questions: string[];
}

export interface StoredAssessmentView {
  exists: true;
  schema_version: string;
  methodology_version: string;
  case_id: string;
  outcome: string;
  remedy_assessment: string;
  summary: string;
  issue_findings: IssueFindingView[];
  limitations: string[];
  notices: string[];
  standard_notices: string[];
  provenance: Record<string, unknown>;
  response_state: string;
  snapshot_digest: string;
  attempt: number;
  assessed_at: number;
}

export interface MissingAssessmentView {
  exists: false;
  case_id: string;
  status: string;
  attempts: number;
  schema_version: string;
}

export type AssessmentView = StoredAssessmentView | MissingAssessmentView;
