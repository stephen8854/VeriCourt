/**
 * Exact notice strings written by contracts/vericourt.py. Displayed verbatim,
 * never paraphrased. Kept in sync by enums.test.ts, which parses the contract.
 */

export const NOTICE_NO_RESPONSE =
  "The respondent did not reply before the deadline. This is recorded as a procedural " +
  "fact only; it is not treated as evidence that the claim is correct.";

export const NOTICE_REPLY_CONSIDERED = "The respondent's reply was part of the assessed record.";

export const NOTICE_EXTERNAL_NOT_OPENED =
  "Linked documents and hashed files were not opened. Only the labels, descriptions and " +
  "references supplied by the parties were assessed.";

export const STANDARD_NOTICES = [
  "This is an AI-assisted assessment of the submitted record, not legal advice, a court " +
    "judgment, or a binding arbitration award.",
  "Validator consensus means independent validators agreed on the result; it is not a " +
    "guarantee of objective truth.",
  "A file hash helps verify file integrity; it does not prove that a file is authentic or true.",
] as const;

export const PROVENANCE_NOTICE =
  "The outcome and issue determinations were accepted through contract validation and " +
  "validator agreement. The remedy view is an advisory note from the leader's model: it was " +
  "not compared across validators, and the contract replaces it with CANNOT_ASSESS if it " +
  "contradicts the outcome. The summary, findings, reasoning, confidence, open questions and " +
  "limitations were written by the leader's model and were not independently checked for " +
  "accuracy, completeness or neutrality.";
