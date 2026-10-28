/**
 * Shared rendering of a stored assessment (Phase 2.18B display rules), used by
 * the live-check diagnostic and the general case view. Decision fields and
 * AI-generated explanation are kept in separate, labelled blocks; citations
 * never claim a direction the validators did not compare; stored notices are
 * shown verbatim. All values render as text.
 */
import { PROVENANCE_NOTICE, STANDARD_NOTICES } from "../contract/notices";
import type { EvidenceView, IssueFindingView, StoredAssessmentView } from "../contract/types";
import { claimantOnlyCaution } from "../display/caution";
import {
  UNCOMPARED_CITATIONS_NOTE,
  citationsWereOverlapChecked,
  describeCitedItem,
  visibleCitationGroups,
} from "../display/citations";
import { confidenceLabel, determinationLabel, finalityLabel, outcomeLabel, type Finality } from "../display/labels";
import { checkStoredNotices } from "../display/notices";
import { ADVISORY_BLOCK_HEADING, DECISION_BLOCK_HEADING, provenanceLabel } from "../display/provenance";
import { remedyDisplay } from "../display/remedy";
import { EvidencePanel } from "./EvidencePanel";

export function FinalityTag({ finality }: { finality: Finality }) {
  const tone = finality === "final" ? "tag--ok" : finality === "not_final" ? "tag--warn" : "tag--neutral";
  return <span className={`tag ${tone}`}>{finalityLabel(finality)}</span>;
}

function Citations({ finding, evidence }: { finding: IssueFindingView; evidence: readonly EvidenceView[] }) {
  return (
    <>
      {visibleCitationGroups(finding).map((group) => (
        <div key={group.key}>
          <p>
            <strong>{group.heading}</strong>
          </p>
          {group.ids.length === 0 ? (
            <p>{group.emptyText}</p>
          ) : (
            <ul>
              {group.ids.map((id) => {
                const item = describeCitedItem(id, evidence);
                return (
                  <li key={id}>
                    <code>{item.id}</code> — {item.label} (submitted by: {item.submittedBy}; {item.inspection})
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ))}
    </>
  );
}

export function AssessmentBlocks({ a, evidence }: { a: StoredAssessmentView; evidence: readonly EvidenceView[] }) {
  const remedy = remedyDisplay(a.remedy_assessment);
  const notices = checkStoredNotices(a.notices, a.response_state);
  const displayNotice = typeof a.provenance.display_notice === "string" ? a.provenance.display_notice : PROVENANCE_NOTICE;
  return (
    <>
      <EvidencePanel title={DECISION_BLOCK_HEADING}>
        <p className="hint">{provenanceLabel("consensus_compared")}</p>
        <p>
          <strong>Outcome:</strong> {outcomeLabel(a.outcome)}
        </p>
        {a.issue_findings.map((f) => {
          const caution = claimantOnlyCaution(f, a.response_state, evidence);
          return (
            <section key={f.issue_id} aria-label={`Issue ${f.issue_id}`}>
              <h4>
                Issue <code>{f.issue_id}</code>: {determinationLabel(f.determination)}
              </h4>
              {caution !== null && (
                <p role="note" className="evidence-panel--warning">
                  {caution}
                </p>
              )}
              <p className="hint">
                {citationsWereOverlapChecked(f.determination) ? provenanceLabel("partially_checked") : UNCOMPARED_CITATIONS_NOTE}
              </p>
              <Citations finding={f} evidence={evidence} />
            </section>
          );
        })}
      </EvidencePanel>

      <EvidencePanel title={ADVISORY_BLOCK_HEADING} tone="procedural">
        <p className="hint">{displayNotice}</p>
        <p>
          <strong>Summary:</strong> {a.summary}
        </p>
        {a.issue_findings.map((f) => (
          <div key={f.issue_id}>
            <p>
              <strong>
                Issue <code>{f.issue_id}</code> explanation:
              </strong>{" "}
              {f.finding}
            </p>
            <p>{f.reasoning}</p>
            <p className="hint">{confidenceLabel(f.confidence)}</p>
            {f.open_questions.length > 0 && (
              <ul aria-label={`Open questions for ${f.issue_id}`}>
                {f.open_questions.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ul>
            )}
          </div>
        ))}
        {a.limitations.length > 0 && (
          <ul aria-label="Limitations">
            {a.limitations.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        )}
        <p>
          <strong>Remedy view:</strong> {remedy.label}
        </p>
        <p className="hint">{remedy.provenance}</p>
        {remedy.note !== null && <p className="hint">{remedy.note}</p>}
        <p className="hint">{remedy.disclaimer}</p>
      </EvidencePanel>

      <EvidencePanel title="Notices written by the contract" tone="procedural">
        {notices.mismatch !== null && <p role="alert">{notices.mismatch}</p>}
        <ul>
          {notices.notices.map((n) => (
            <li key={n}>{n}</li>
          ))}
          {STANDARD_NOTICES.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </EvidencePanel>
    </>
  );
}
