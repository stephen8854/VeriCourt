/**
 * Advisory remedy display. The remedy is written by the leader's model, is
 * not compared across validators, and is replaced by CANNOT_ASSESS when it
 * contradicts the derived outcome. A stored CANNOT_ASSESS therefore cannot be
 * attributed to the model or to the replacement.
 */
import { REMEDY_ASSESSMENTS, isOneOf, type RemedyAssessment } from "../contract/enums";
import { unrecognised } from "./labels";

export const REMEDY_PROVENANCE = "Advisory: AI-generated, not checked by validators";
export const NO_ENFORCEMENT_DISCLAIMER = "VeriCourt does not pay, refund, hold or enforce anything.";
export const CANNOT_ASSESS_NOTE =
  "This may be the model's own view, or the contract's automatic replacement when the outcome is inconclusive or contradicts the remedy view.";

const REMEDY_LABELS: Record<RemedyAssessment, string> = {
  SUPPORTED: "The leader's model considered the requested remedy supported by the record",
  PARTIALLY_SUPPORTED: "The leader's model considered the requested remedy partly supported by the record",
  NOT_SUPPORTED: "The leader's model considered the requested remedy not supported by the record",
  CANNOT_ASSESS: "No view on the requested remedy",
};

export interface RemedyDisplay {
  label: string;
  provenance: string;
  note: string | null;
  disclaimer: string;
}

export function remedyDisplay(remedy: unknown): RemedyDisplay {
  const known = isOneOf(REMEDY_ASSESSMENTS, remedy);
  return {
    label: known ? REMEDY_LABELS[remedy] : unrecognised("remedy view", remedy),
    provenance: REMEDY_PROVENANCE,
    note: remedy === "CANNOT_ASSESS" ? CANNOT_ASSESS_NOTE : null,
    disclaimer: NO_ENFORCEMENT_DISCLAIMER,
  };
}
