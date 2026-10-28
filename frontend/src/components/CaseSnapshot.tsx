/**
 * Read-only rendering of live case data through the Phase 2.18B display
 * helpers. Data that fails validation is never rendered; an explicit message is
 * shown instead. All values are rendered as text.
 */
import type { EvidenceView } from "../contract/types";
import { describeCitedItem } from "../display/citations";
import { caseStatusLabel, finalityFromReads, responseStateLabel } from "../display/labels";
import { noResponseNotice } from "../display/notices";
import type { CaseReads } from "../live/readCheck";
import { validateAssessment, validateCase, validateRead } from "../live/validate";
import { AssessmentBlocks, FinalityTag } from "./AssessmentView";
import { EvidencePanel } from "./EvidencePanel";

interface Props {
  nonfinal: Partial<CaseReads> | undefined;
  final: Partial<CaseReads> | undefined;
}

export function CaseSnapshot({ nonfinal, final }: Props) {
  const source = final ?? nonfinal;
  const c = validateCase(source?.get_case);
  const ev = validateRead("get_case_evidence", source?.get_case_evidence);
  const as = validateAssessment(source?.get_assessment);
  if (!c.ok || !ev.ok || !as.ok) {
    return (
      <EvidencePanel title="Case data not shown" tone="warning">
        <p role="alert">
          The live reads did not all return the expected shape, so no case data is displayed. See the read results above.
        </p>
      </EvidencePanel>
    );
  }
  const nonfinalCase = validateCase(nonfinal?.get_case);
  const finalCase = validateCase(final?.get_case);
  const finality = finalityFromReads(
    nonfinalCase.ok ? nonfinalCase.value.status : undefined,
    finalCase.ok ? finalCase.value.status : null,
  );
  const kase = c.value;
  const evidence = ev.value as EvidenceView[];
  const notice = noResponseNotice(kase.response_state);
  return (
    <section className="section" aria-labelledby="snapshot-heading">
      <h2 id="snapshot-heading">
        Live case <code>{kase.case_id}</code>
      </h2>
      <EvidencePanel title={kase.title}>
        <dl className="facts">
          <dt>Case status</dt>
          <dd>{caseStatusLabel(kase.status)}</dd>
          <dt>Finality</dt>
          <dd>
            <FinalityTag finality={finality} />
          </dd>
          <dt>Claimant</dt>
          <dd>
            <code>{kase.claimant}</code>
          </dd>
          <dt>Respondent</dt>
          <dd>
            <code>{kase.respondent}</code>
          </dd>
          <dt>Reply</dt>
          <dd>{responseStateLabel(kase.response_state)}</dd>
        </dl>
        {notice !== null && <p role="note">{notice}</p>}
        <h4>Issues</h4>
        <ul>
          {kase.issues.map((i) => (
            <li key={i.issue_id}>
              <code>{i.issue_id}</code> {i.description}
            </li>
          ))}
        </ul>
        <h4>Evidence register</h4>
        <ul>
          {evidence.map((e) => {
            const item = describeCitedItem(e.evidence_id, evidence);
            return (
              <li key={e.evidence_id}>
                <code>{e.evidence_id}</code> — {item.label} (submitted by: {item.submittedBy}; {item.inspection})
              </li>
            );
          })}
        </ul>
      </EvidencePanel>
      {as.value.exists ? (
        <AssessmentBlocks a={as.value} evidence={evidence} />
      ) : (
        <EvidencePanel title="No assessment stored" tone="procedural">
          <p>The contract has no stored assessment for this case.</p>
        </EvidencePanel>
      )}
    </section>
  );
}
