/**
 * The full read-only case record: header, agreement and claim, reply window,
 * evidence register, timeline and assessment. Shared by the case page and the
 * printable report. Only validated sections render; contradictions between
 * reads are listed and the affected sections are flagged, never repaired.
 */
import type { CaseData } from "../cases/caseReads";
import type { KnownTransaction } from "../cases/knownTransactions";
import { MISSING_RESPONSE_NOTE } from "../contract/copy";
import { STANDARD_NOTICES } from "../contract/notices";
import { formatUtc, lockReasonLabel, replyWindowView, roleLabel, DEVICE_CLOCK_NOTE, type ViewerRole } from "../display/caseText";
import { caseStatusLabel, outcomeNeedsIssueDetail, responseStateLabel } from "../display/labels";
import { AssessmentBlocks } from "./AssessmentView";
import { CaseTimeline } from "./CaseTimeline";
import { EvidencePanel } from "./EvidencePanel";
import { EvidenceRegister } from "./EvidenceRegister";

const CATEGORY_LABELS: Record<string, string> = {
  SOFTWARE: "Software development",
  DESIGN: "Design / branding",
  WRITING: "Writing / content",
  OTHER: "Other digital deliverable",
};

export function FinalityBadge({ data }: { data: CaseData }) {
  const f = data.finality;
  if (f.kind === "final") return <span className="tag tag--ok">Final (confirmed by a latest-final read)</span>;
  if (f.kind === "pending_changes") return <span className="tag tag--warn">Final record shown; newer changes are not final yet</span>;
  return <span className="tag tag--warn">Not yet final</span>;
}

function Problems({ title, problems }: { title: string; problems: string[] }) {
  return (
    <EvidencePanel title={title} tone="warning">
      <p role="alert">This section's data did not have the expected shape, so it is not shown.</p>
      <ul>
        {problems.slice(0, 8).map((p) => (
          <li key={p}>
            <code className="break">{p}</code>
          </li>
        ))}
      </ul>
    </EvidencePanel>
  );
}

export function CaseRecord({
  data,
  viewer,
  nowSeconds,
  transactions,
  headingLevel = 2,
}: {
  data: CaseData;
  viewer: ViewerRole;
  nowSeconds: number;
  transactions: readonly KnownTransaction[];
  headingLevel?: 2;
}) {
  const c = data.case;
  const H = headingLevel === 2 ? "h2" : "h3";
  const reply = replyWindowView(c, nowSeconds);
  const evidence = data.evidence.ok ? data.evidence.value : [];
  const inconsistent = data.inconsistencies.length > 0;
  return (
    <>
      <header className="case-header">
        <p className="case-number mono" aria-label={`Case ${c.case_id}`}>
          {c.case_id}
        </p>
        <p className="case-title break">{c.title}</p>
        <dl className="facts">
          <dt>Case status</dt>
          <dd>{caseStatusLabel(c.status)}</dd>
          <dt>Record finality</dt>
          <dd>
            <FinalityBadge data={data} />
          </dd>
          <dt>Category</dt>
          <dd>{CATEGORY_LABELS[c.category] ?? `Unrecognised category: ${c.category}`}</dd>
          <dt>Claimant</dt>
          <dd>
            <code className="break">{c.claimant}</code>
            {viewer === "CLAIMANT" ? <span className="tag tag--info">You</span> : null}
          </dd>
          <dt>Respondent</dt>
          <dd>
            <code className="break">{c.respondent}</code>
            {viewer === "RESPONDENT" ? <span className="tag tag--info">You</span> : null}
          </dd>
          <dt>Created</dt>
          <dd>{formatUtc(c.created_at)}</dd>
          <dt>Your role</dt>
          <dd>{viewer === null ? "Not a party (or no wallet connected): read-only" : roleLabel(viewer)}</dd>
        </dl>
      </header>

      {data.finality.kind === "pending_changes" ? (
        <EvidencePanel title="Newer changes are not final yet" tone="procedural">
          <p role="status">
            The record below is the latest final state. A newer, non-final state exists (status: {caseStatusLabel(data.finality.nonfinalStatus)}). It
            is not shown as the record until the network finalizes it.
          </p>
          <p className="hint">Differs at: {data.finality.differences.slice(0, 6).join(", ")}</p>
        </EvidencePanel>
      ) : null}
      {data.finality.kind === "not_final_yet" ? (
        <EvidencePanel title="Not yet final" tone="procedural">
          <p role="status">This case exists only in the latest non-final state. It is shown for information and may still change.</p>
        </EvidencePanel>
      ) : null}
      {inconsistent ? (
        <EvidencePanel title="The reads contradict each other" tone="warning">
          <p role="alert">Parts of this case's data disagree, so treat the sections below with caution:</p>
          <ul>
            {data.inconsistencies.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </EvidencePanel>
      ) : null}

      <section className="section" aria-labelledby="agreement-heading">
        <H id="agreement-heading">Agreement and claim</H>
        <p className="hint">Each party's text is that party's own account. The contract does not check it.</p>
        <dl className="facts">
          <dt>Agreement summary</dt>
          <dd className="pre-wrap break">{c.agreement_summary}</dd>
          <dt>Expected deliverable</dt>
          <dd className="pre-wrap break">{c.expected_deliverable}</dd>
          <dt>Claim</dt>
          <dd className="pre-wrap break">{c.claim}</dd>
          <dt>Requested remedy</dt>
          <dd>
            <span className="pre-wrap break">{c.requested_remedy}</span>
            <span className="block hint">Requested by the claimant. VeriCourt does not pay, refund, hold or enforce anything.</span>
          </dd>
        </dl>
        <h3>Issues</h3>
        <ol className="issue-list">
          {c.issues.map((i) => (
            <li key={i.issue_id}>
              <code>{i.issue_id}</code> <span className="pre-wrap break">{i.description}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="section" aria-labelledby="reply-heading">
        <H id="reply-heading">Reply and deadline</H>
        <EvidencePanel title={reply.headline} tone={reply.tone === "closed_unprocessed" ? "warning" : "procedural"}>
          {reply.detail !== "" ? <p>{reply.detail}</p> : null}
          <dl className="facts">
            <dt>Reply state</dt>
            <dd>{responseStateLabel(c.response_state)}</dd>
            <dt>Reply deadline</dt>
            <dd>{formatUtc(c.reply_deadline)}</dd>
            <dt>Record</dt>
            <dd>{c.snapshot_locked ? `Locked at ${formatUtc(c.locked_at)}: ${lockReasonLabel(c.lock_reason)}` : "Open (not locked)"}</dd>
            {c.snapshot_locked ? (
              <>
                <dt>Snapshot digest</dt>
                <dd>
                  <code className="break">{c.snapshot_digest}</code>
                </dd>
              </>
            ) : null}
          </dl>
          {c.response_state === "NO_RESPONSE_BY_DEADLINE" ? <p className="hint">{MISSING_RESPONSE_NOTE}</p> : null}
          {reply.tone === "open" || reply.tone === "closed_unprocessed" ? <p className="hint">{DEVICE_CLOCK_NOTE}</p> : null}
        </EvidencePanel>
        {c.response_state === "SUBMITTED" ? (
          <EvidencePanel title="The respondent's reply">
            <p className="pre-wrap break">{c.reply}</p>
          </EvidencePanel>
        ) : null}
      </section>

      <section className="section" aria-labelledby="evidence-heading">
        <H id="evidence-heading">Evidence register</H>
        <p className="hint">
          {c.evidence_count} item{c.evidence_count === 1 ? "" : "s"}: {c.claimant_evidence_count} from the claimant, {c.respondent_evidence_count} from the
          respondent.
        </p>
        {data.evidence.ok ? <EvidenceRegister evidence={data.evidence.value} issues={c.issues} /> : <Problems title="Evidence not shown" problems={data.evidence.problems} />}
      </section>

      <section className="section" aria-labelledby="timeline-heading">
        <H id="timeline-heading">Timeline</H>
        {data.history.ok ? (
          <CaseTimeline history={data.history.value} claimant={c.claimant} respondent={c.respondent} transactions={transactions} />
        ) : (
          <Problems title="Timeline not shown" problems={data.history.problems} />
        )}
      </section>

      <section className="section" aria-labelledby="assessment-heading">
        <H id="assessment-heading">Assessment</H>
        {data.assessmentStatus.ok ? (
          <dl className="facts">
            <dt>Assessment state</dt>
            <dd>{caseStatusLabel(c.status)}</dd>
            <dt>Attempts used</dt>
            <dd>
              {data.assessmentStatus.value.attempts} of {data.assessmentStatus.value.max_attempts}
            </dd>
            {data.assessmentStatus.value.last_error !== "" ? (
              <>
                <dt>Last attempt</dt>
                <dd>
                  Produced no valid result (<code>{data.assessmentStatus.value.last_error}</code>). This says nothing about the merits of the claim.
                </dd>
              </>
            ) : null}
          </dl>
        ) : (
          <Problems title="Assessment status not shown" problems={data.assessmentStatus.problems} />
        )}
        {!data.assessment.ok ? (
          <Problems title="Assessment not shown" problems={data.assessment.problems} />
        ) : data.assessment.value.exists ? (
          inconsistent ? (
            <EvidencePanel title="Assessment withheld" tone="warning">
              <p role="alert">An assessment is stored, but the reads contradict each other (listed above), so it is not displayed as this case's result.</p>
            </EvidencePanel>
          ) : (
            <>
              {data.finality.kind !== "final" ? (
                <p role="note" className="callout">
                  This assessment is part of a record that is not confirmed final in every respect (see the finality notice above).
                </p>
              ) : null}
              {outcomeNeedsIssueDetail(data.assessment.value.outcome) ? (
                <p className="hint">Read the per-issue determinations below: the overall outcome alone does not describe this result.</p>
              ) : null}
              <AssessmentBlocks a={data.assessment.value} evidence={evidence} />
            </>
          )
        ) : (
          <EvidencePanel title="No assessment stored" tone="procedural">
            <p>The contract has no stored assessment for this case.</p>
            <ul className="hint">
              {STANDARD_NOTICES.slice(0, 2).map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </EvidencePanel>
        )}
      </section>
    </>
  );
}
