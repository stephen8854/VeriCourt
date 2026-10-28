/**
 * Provenance classes, mirroring contracts/vericourt.py `_provenance()`.
 * Decides which display block a stored assessment field belongs to and how it
 * is labelled. Leader-generated text is never labelled as validator-verified.
 */

export type ProvenanceClass =
  | "consensus_compared"
  | "partially_checked"
  | "leader_generated_constrained"
  | "leader_generated_unverified"
  | "contract_generated";

const FIELD_CLASS: Record<string, ProvenanceClass> = {
  outcome: "consensus_compared",
  "issue_findings[].determination": "consensus_compared",
  "issue_findings[].supporting_evidence_ids": "partially_checked",
  "issue_findings[].counter_evidence_ids": "partially_checked",
  remedy_assessment: "leader_generated_constrained",
  summary: "leader_generated_unverified",
  "issue_findings[].finding": "leader_generated_unverified",
  "issue_findings[].reasoning": "leader_generated_unverified",
  "issue_findings[].confidence": "leader_generated_unverified",
  "issue_findings[].open_questions": "leader_generated_unverified",
  limitations: "leader_generated_unverified",
  notices: "contract_generated",
  standard_notices: "contract_generated",
  response_state: "contract_generated",
  snapshot_digest: "contract_generated",
};

const CLASS_LABELS: Record<ProvenanceClass, string> = {
  consensus_compared: "Accepted through validator agreement (a majority of the validators that voted)",
  partially_checked:
    "Every listed item exists in the locked record; agreeing validators shared at least one item; relevance was not checked",
  leader_generated_constrained: "Advisory: written by the leader's model, not compared across validators",
  leader_generated_unverified: "AI-generated explanation: not independently verified",
  contract_generated: "Written by the contract",
};

/** The decision block holds only consensus-compared fields; everything else is advisory or procedural. */
export type DisplayBlock = "decision" | "evidence" | "advisory" | "procedural";

const CLASS_BLOCK: Record<ProvenanceClass, DisplayBlock> = {
  consensus_compared: "decision",
  partially_checked: "evidence",
  leader_generated_constrained: "advisory",
  leader_generated_unverified: "advisory",
  contract_generated: "procedural",
};

export function provenanceOf(field: string): ProvenanceClass | null {
  return FIELD_CLASS[field] ?? null;
}

export function provenanceLabel(cls: ProvenanceClass): string {
  return CLASS_LABELS[cls];
}

export function displayBlockOf(field: string): DisplayBlock | null {
  const cls = provenanceOf(field);
  return cls === null ? null : CLASS_BLOCK[cls];
}

export const ADVISORY_BLOCK_HEADING = "Explanation (AI-generated, not independently verified)";
export const DECISION_BLOCK_HEADING = "Decision fields accepted through validator agreement";
