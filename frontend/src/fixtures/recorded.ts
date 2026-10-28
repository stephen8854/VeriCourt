/**
 * Recorded StudioNet data (verbatim copies from the git-ignored integration-logs/).
 * Contract reads were made at latest-final by the Python harness (genlayer-py),
 * so these are real contract return values, not genlayer-js responses.
 */
import type { CaseView, EvidenceView, HistoryEntryView, StoredAssessmentView } from "../contract/types";
import clear from "./recorded/phase-2-14-clear.json";
import ambiguous from "./recorded/phase-2-15-ambiguous.json";
import noReply from "./recorded/phase-2-17c-no-reply.json";
import phase28Tx from "./recorded/phase-2-8-assessment-tx.json";

export interface RecordedRun {
  source: string;
  /** Raw latest-final reads exactly as recorded (get_case, get_case_evidence, get_case_history, get_assessment_status, get_assessment). */
  reads: Record<string, unknown>;
  case: CaseView;
  evidence: EvidenceView[];
  history: HistoryEntryView[];
  assessment: StoredAssessmentView;
  harnessLastViews: Record<string, Record<string, unknown>>;
}

function run(raw: unknown): RecordedRun {
  const r = raw as {
    source: string;
    reads_latest_final: {
      get_case: CaseView;
      get_case_evidence: EvidenceView[];
      get_case_history: HistoryEntryView[];
      get_assessment: StoredAssessmentView;
    };
    harness_last_views: Record<string, Record<string, unknown>>;
  };
  return {
    source: r.source,
    reads: r.reads_latest_final as unknown as Record<string, unknown>,
    case: r.reads_latest_final.get_case,
    evidence: r.reads_latest_final.get_case_evidence,
    history: r.reads_latest_final.get_case_history,
    assessment: r.reads_latest_final.get_assessment,
    harnessLastViews: r.harness_last_views,
  };
}

export const RECORDED_CLEAR = run(clear);
export const RECORDED_AMBIGUOUS = run(ambiguous);
export const RECORDED_NO_REPLY = run(noReply);

/** Raw StudioNet eth_getTransactionByHash result for the Phase 2.8 assessment transaction. */
export const RECORDED_PHASE_2_8_TX: Record<string, unknown> = phase28Tx as Record<string, unknown>;
