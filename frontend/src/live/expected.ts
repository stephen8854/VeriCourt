/**
 * Expected values for the live check: the Phase 2.17C latest-final read-back,
 * recorded on StudioNet by the Python harness (genlayer-py). Imports only that
 * fixture so the large Phase 2.8 transaction fixture stays out of the app bundle.
 */
import noReply from "../fixtures/recorded/phase-2-17c-no-reply.json";
import type { CaseReads } from "./readCheck";

const CASE_STATUS_KEYS = [
  "case_id", "status", "response_state", "created_at", "reply_deadline", "snapshot_locked", "locked_at", "lock_reason",
] as const;

/**
 * get_case_status was not recorded by the harness; its expected value is DERIVED
 * from the recorded get_case (every get_case_status field is also a get_case field).
 */
export function recordedNoReplyCaseReads(): CaseReads {
  const reads = (noReply as unknown as { reads_latest_final: Record<string, unknown> }).reads_latest_final;
  const recordedCase = reads.get_case as Record<string, unknown>;
  return {
    get_case: reads.get_case,
    get_case_status: Object.fromEntries(CASE_STATUS_KEYS.map((k) => [k, recordedCase[k]])),
    get_case_evidence: reads.get_case_evidence,
    get_case_history: reads.get_case_history,
    get_assessment_status: reads.get_assessment_status,
    get_assessment: reads.get_assessment,
  };
}
