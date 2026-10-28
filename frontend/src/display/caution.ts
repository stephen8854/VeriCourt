/**
 * Phase 2.18B F2: the contract cannot tell a party's own statement from a
 * document, so a favourable finding in a no-reply case that rests only on
 * claimant-submitted items gets a caution. The check is deterministic: it uses
 * only the response state, each item's recorded submitter role and the cited ids.
 */
import { FAVOURABLE_DETERMINATIONS, isOneOf } from "../contract/enums";
import type { EvidenceView, IssueFindingView } from "../contract/types";
import { isNoResponse } from "./notices";

export const CLAIMANT_ONLY_CAUTION =
  "Every item cited for this finding was submitted by the claimant, and the respondent did not reply. " +
  "The contract cannot check whether these items are more than the claimant's own account.";

export function claimantOnlyCaution(
  finding: Pick<IssueFindingView, "determination" | "supporting_evidence_ids">,
  responseState: unknown,
  evidence: readonly Pick<EvidenceView, "evidence_id" | "submitter_role">[],
): string | null {
  if (!isNoResponse(responseState)) return null;
  if (!isOneOf(FAVOURABLE_DETERMINATIONS, finding.determination)) return null;
  const cited = finding.supporting_evidence_ids;
  if (cited.length === 0) return null;
  const allClaimant = cited.every(
    (id) => evidence.find((e) => e.evidence_id === id)?.submitter_role === "CLAIMANT",
  );
  return allClaimant ? CLAIMANT_ONLY_CAUTION : null;
}
