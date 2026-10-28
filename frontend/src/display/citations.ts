/**
 * Citation display (Phase 2.18B, F1/F6).
 *
 * The field names `supporting_evidence_ids` / `counter_evidence_ids` do not
 * establish what an item means. Direction is shown only for definite
 * determinations, and only the list in the determination's direction was
 * overlap-checked across agreeing validators. For UNRESOLVED both lists are
 * merged and shown without any direction.
 */
import type { EvidenceView, IssueFindingView } from "../contract/types";

export const EMPTY_CITATIONS_TEXT = "No evidence was cited for this finding.";
export const UNRESOLVED_HEADING = "Evidence the assessment considered — no direction established";
export const DIRECTION_CHECKED_HEADING =
  "Evidence cited for this finding (each agreeing validator cited at least one of these; the list itself is the leader's)";
export const OPPOSITE_TO_CLAIMANT_UNCOMPARED =
  "Also cited by the leader's model as cutting the other way (not compared across validators)";
export const TOWARD_CLAIMANT_UNCOMPARED =
  "Also cited by the leader's model as favouring the claimant (not compared across validators)";
export const UNKNOWN_DETERMINATION_HEADING = "Evidence cited (direction not established)";
/** Provenance note for citation lists of a finding without an overlap-checked direction. */
export const UNCOMPARED_CITATIONS_NOTE =
  "Every listed item exists in the locked record. For this determination, citations are not compared across validators.";

const DIRECTION_CHECKED = ["SUPPORTED", "PARTIALLY_SUPPORTED", "NOT_SUPPORTED"];

/**
 * Whether agreeing validators overlap-checked this finding's citations. Only
 * definite determinations are checked (one shared id in the determination's
 * direction); UNRESOLVED citations are informational and never compared.
 */
export function citationsWereOverlapChecked(determination: unknown): boolean {
  return typeof determination === "string" && DIRECTION_CHECKED.includes(determination);
}

export interface CitationGroup {
  key: "direction_checked" | "uncompared" | "considered";
  heading: string;
  ids: string[];
  /** Shown when ids is empty; null when an empty group should not be shown at all. */
  emptyText: string | null;
}

function merged(a: readonly string[], b: readonly string[]): string[] {
  return [...a, ...b.filter((id) => !a.includes(id))];
}

export function citationGroups(
  finding: Pick<IssueFindingView, "determination" | "supporting_evidence_ids" | "counter_evidence_ids">,
): CitationGroup[] {
  const supporting = [...finding.supporting_evidence_ids];
  const counter = [...finding.counter_evidence_ids];
  switch (finding.determination) {
    case "SUPPORTED":
    case "PARTIALLY_SUPPORTED":
      return [
        { key: "direction_checked", heading: DIRECTION_CHECKED_HEADING, ids: supporting, emptyText: EMPTY_CITATIONS_TEXT },
        { key: "uncompared", heading: OPPOSITE_TO_CLAIMANT_UNCOMPARED, ids: counter, emptyText: null },
      ];
    case "NOT_SUPPORTED":
      return [
        { key: "direction_checked", heading: DIRECTION_CHECKED_HEADING, ids: counter, emptyText: EMPTY_CITATIONS_TEXT },
        { key: "uncompared", heading: TOWARD_CLAIMANT_UNCOMPARED, ids: supporting, emptyText: null },
      ];
    case "UNRESOLVED":
      return [{ key: "considered", heading: UNRESOLVED_HEADING, ids: merged(supporting, counter), emptyText: EMPTY_CITATIONS_TEXT }];
    default:
      return [
        { key: "considered", heading: UNKNOWN_DETERMINATION_HEADING, ids: merged(supporting, counter), emptyText: EMPTY_CITATIONS_TEXT },
      ];
  }
}

/** Groups that should be rendered (drops empty groups that have no empty-state text). */
export function visibleCitationGroups(
  finding: Pick<IssueFindingView, "determination" | "supporting_evidence_ids" | "counter_evidence_ids">,
): CitationGroup[] {
  return citationGroups(finding).filter((g) => g.ids.length > 0 || g.emptyText !== null);
}

export interface CitedItem {
  id: string;
  label: string;
  submittedBy: string;
  inspection: string;
}

const INSPECTION_NOTE: Record<string, string> = {
  TEXT: "Text supplied by a party; its accuracy was not checked",
  LINK: "Link reference only; the contract did not open it",
  FILE_DIGEST: "File fingerprint only; the contract did not open the file",
};

/** Metadata for a cited id. Never states that the item supports or opposes anything. */
export function describeCitedItem(id: string, evidence: readonly EvidenceView[]): CitedItem {
  const item = evidence.find((e) => e.evidence_id === id);
  if (item === undefined) {
    return { id, label: "Not found in the locked record", submittedBy: "Unknown", inspection: "Unknown" };
  }
  const submittedBy =
    item.submitter_role === "CLAIMANT" ? "Claimant" : item.submitter_role === "RESPONDENT" ? "Respondent" : "Unknown";
  return {
    id,
    label: item.label,
    submittedBy,
    inspection: INSPECTION_NOTE[item.evidence_type] ?? "Unknown evidence type",
  };
}
