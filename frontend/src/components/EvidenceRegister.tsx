/**
 * The evidence register: metadata and references exactly as the contract
 * stores them. The contract never opened a link or file; a fingerprint is an
 * integrity reference only. All party text renders as text.
 */
import { EXTERNAL_LINKS_CAN_CHANGE, FILE_HASH_NOTE } from "../contract/copy";
import type { CaseIssue, EvidenceView } from "../contract/types";
import { describeCitedItem } from "../display/citations";
import { formatUtc, roleLabel } from "../display/caseText";
import { ExternalLink } from "./ExternalLink";

const TYPE_LABELS: Record<string, string> = {
  LINK: "Link",
  TEXT: "Text excerpt",
  FILE_DIGEST: "File fingerprint (SHA-256)",
};

function Reference({ item }: { item: EvidenceView }) {
  if (item.evidence_type === "LINK") return <ExternalLink href={item.content_ref} />;
  if (item.evidence_type === "TEXT") return <blockquote className="pre-wrap break">{item.content_ref}</blockquote>;
  return item.content_ref === "" ? <span className="hint">No file name given</span> : <span className="pre-wrap break">File name: {item.content_ref}</span>;
}

export function EvidenceRegister({ evidence, issues }: { evidence: readonly EvidenceView[]; issues: readonly CaseIssue[] }) {
  const hasLink = evidence.some((e) => e.evidence_type === "LINK");
  const hasHash = evidence.some((e) => e.sha256 !== "");
  return (
    <div>
      {evidence.length === 0 ? <p>No evidence has been submitted.</p> : null}
      <ol className="evidence-list">
        {evidence.map((e) => {
          const meta = describeCitedItem(e.evidence_id, evidence);
          return (
            <li key={e.evidence_id} className="evidence-slip" aria-label={`Evidence ${e.evidence_id}`}>
              <p className="evidence-slip__head">
                <code className="evidence-slip__id">{e.evidence_id}</code> <strong className="break">{e.label}</strong>
              </p>
              <dl className="facts">
                <dt>Type</dt>
                <dd>{TYPE_LABELS[e.evidence_type] ?? `Unrecognised type: ${e.evidence_type}`}</dd>
                <dt>Submitted by</dt>
                <dd>
                  {roleLabel(e.submitter_role)} <code className="break">{e.submitter}</code>
                </dd>
                <dt>Submitted at</dt>
                <dd>{formatUtc(e.submitted_at)}</dd>
                <dt>Issues</dt>
                <dd>
                  {e.issue_ids
                    .map((id) => {
                      const issue = issues.find((i) => i.issue_id === id);
                      return issue ? `${id}` : `${id} (unknown issue)`;
                    })
                    .join(", ")}
                </dd>
                <dt>Description</dt>
                <dd className="pre-wrap break">{e.description}</dd>
                <dt>Reference</dt>
                <dd>
                  <Reference item={e} />
                </dd>
                {e.sha256 !== "" ? (
                  <>
                    <dt>SHA-256</dt>
                    <dd>
                      <code className="break">{e.sha256}</code>
                    </dd>
                  </>
                ) : null}
                <dt>Checked by the contract?</dt>
                <dd>{meta.inspection}</dd>
                <dt>In the locked record</dt>
                <dd>{e.in_locked_snapshot ? "Yes: frozen for assessment" : "Not yet (the record is not locked)"}</dd>
              </dl>
            </li>
          );
        })}
      </ol>
      {hasLink ? <p className="hint">{EXTERNAL_LINKS_CAN_CHANGE}</p> : null}
      {hasHash ? <p className="hint">{FILE_HASH_NOTE}</p> : null}
      <p className="hint">
        The register records metadata and references supplied by the parties. The contract does not open links or files and does not check that
        any item is accurate.
      </p>
    </div>
  );
}
