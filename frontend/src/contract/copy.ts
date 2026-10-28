/**
 * Mandatory product copy, verbatim from VeriCourt_Claude_Code_Build_Brief.md §10
 * and VeriCourt_Product_Protocol_Design_Spec.md §13 / Journey F. Never
 * paraphrased; copy.test.ts reads both documents so these cannot drift.
 */

/** Bold lead-in of the "Before you submit" warning (rendered in <strong>). */
export const BEFORE_YOU_SUBMIT_LEAD = "Before you submit:";

/** Body of the "Before you submit" warning, shown before case creation and evidence submission. */
export const BEFORE_YOU_SUBMIT_BODY =
  "Information written to a public blockchain may be visible and permanent. Do not submit passwords, private keys, " +
  "confidential information, or personal data you do not have permission to share. VeriCourt provides an AI-assisted " +
  "assessment, not legal advice or a guarantee of a legally binding result.";

export const EXTERNAL_LINKS_CAN_CHANGE = "External links can change or become unavailable.";

export const FILE_HASH_NOTE = "A file hash helps verify file integrity; it does not prove that the file is authentic or true.";

export const CONSENSUS_NOT_TRUTH = "Protocol consensus is not a guarantee of objective truth.";

export const MISSING_RESPONSE_NOTE =
  "A missing response is recorded as a procedural fact, not automatic proof against the non-responding party.";

export const REPORT_LABEL = "VeriCourt case report — not a court judgment or legal opinion.";

/**
 * Supplementary evidence guidance (not in the brief; shown next to, never
 * instead of, the mandatory warning). VeriCourt has no upload: only metadata
 * and references are written.
 */
export const REDACTION_NOTE =
  "Remove or redact sensitive details before you reference a document. VeriCourt does not upload files: only the label, " +
  "description, reference and optional fingerprint you enter are written on chain.";

/** Every sentence above that legitimately contains wording the display scan otherwise bans. */
export const MANDATORY_SENTENCES: readonly string[] = [
  `${BEFORE_YOU_SUBMIT_LEAD} ${BEFORE_YOU_SUBMIT_BODY}`,
  BEFORE_YOU_SUBMIT_BODY,
  EXTERNAL_LINKS_CAN_CHANGE,
  FILE_HASH_NOTE,
  CONSENSUS_NOT_TRUTH,
  MISSING_RESPONSE_NOTE,
  REPORT_LABEL,
];
