/**
 * Inputs for the four case-level writes (submit_evidence, submit_reply,
 * process_reply_deadline, request_assessment). As with write/createCase.ts,
 * ONE object feeds both the review screen and the encoded call, so what the
 * user approves is what gets encoded.
 *
 * Validation mirrors contracts/vericourt.py (limits, URL and SHA-256 rules,
 * issue references; caseActions.test.ts parses the contract so the limits
 * cannot drift). Lengths count Unicode code points, as Python's len() does.
 * The contract remains the authority: state rules (role, deadline, lock,
 * quotas, attempts) are re-checked from fresh reads in the write preflight.
 *
 * Pure module: no SDK, no wallet, no network, no storage.
 */
import { EVIDENCE_TYPES, type EvidenceType } from "../contract/enums";

export const CASE_ACTION_LIMITS = {
  MAX_EVIDENCE_LABEL_LEN: 120,
  MAX_EVIDENCE_DESCRIPTION_LEN: 1000,
  MAX_EVIDENCE_TEXT_LEN: 2000,
  MAX_EVIDENCE_URL_LEN: 512,
  MAX_EVIDENCE_FILE_NAME_LEN: 200,
  MAX_ISSUES_PER_EVIDENCE: 5,
  SHA256_HEX_LEN: 64,
  MAX_REPLY_LEN: 4000,
} as const;

const CASE_ID = /^VC-\d{6,}$/;

function codePoints(s: string): number {
  return [...s].length;
}

/** Same rules as the contract's _check_text. */
export function textProblem(field: string, value: unknown, max: number, min = 1): string | null {
  if (typeof value !== "string") return `${field} must be text`;
  if (codePoints(value.trim()) < min) return min <= 1 ? `${field} is required` : `${field} must be at least ${min} characters`;
  if (codePoints(value) > max) return `${field} exceeds ${max} characters`;
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if ((code < 32 && ch !== "\n" && ch !== "\t") || code === 127) return `${field} contains control characters`;
  }
  return null;
}

/** Same rules as the contract's _check_url (after _check_text). */
export function urlProblem(value: string): string | null {
  const t = textProblem("link", value, CASE_ACTION_LIMITS.MAX_EVIDENCE_URL_LEN);
  if (t !== null) return t;
  if (!(value.startsWith("https://") || value.startsWith("http://"))) return "link must be an http(s) URL";
  if (/\s/u.test(value)) return "link must not contain whitespace";
  const rest = value.split("://", 2)[1] ?? "";
  if (rest === "" || rest.startsWith("/")) return "link has no host";
  return null;
}

export function sha256Problem(value: string): string | null {
  return /^[0-9a-fA-F]{64}$/.test(value) ? null : "SHA-256 must be 64 hexadecimal characters";
}

function caseIdProblem(caseId: string): string | null {
  return CASE_ID.test(caseId) ? null : "case ID must look like VC-000001";
}

// ---------------------------------------------------------------------------
// submit_evidence
// ---------------------------------------------------------------------------

export interface SubmitEvidenceInput {
  caseId: string;
  evidenceType: EvidenceType;
  label: string;
  description: string;
  /** LINK: the URL. TEXT: the excerpt. FILE_DIGEST: optional file name. */
  contentRef: string;
  /** Hex SHA-256, or "" (required for FILE_DIGEST, optional for LINK, not accepted for TEXT). */
  sha256: string;
  issueIds: string[];
}

/** `knownIssueIds` comes from a fresh read of the case. */
export function validateSubmitEvidence(input: SubmitEvidenceInput, knownIssueIds: readonly string[]): string[] {
  const L = CASE_ACTION_LIMITS;
  const out: string[] = [];
  const push = (p: string | null) => {
    if (p !== null) out.push(p);
  };
  push(caseIdProblem(input.caseId));
  if (!(EVIDENCE_TYPES as readonly string[]).includes(input.evidenceType)) out.push(`evidence type must be one of ${EVIDENCE_TYPES.join(", ")}`);
  push(textProblem("label", input.label, L.MAX_EVIDENCE_LABEL_LEN));
  push(textProblem("description", input.description, L.MAX_EVIDENCE_DESCRIPTION_LEN));
  if (input.evidenceType === "LINK") {
    push(urlProblem(input.contentRef));
    if (input.sha256 !== "") push(sha256Problem(input.sha256));
  } else if (input.evidenceType === "TEXT") {
    push(textProblem("text excerpt", input.contentRef, L.MAX_EVIDENCE_TEXT_LEN));
    if (input.sha256 !== "") out.push("a SHA-256 is not accepted for a text excerpt");
  } else if (input.evidenceType === "FILE_DIGEST") {
    if (input.contentRef !== "") push(textProblem("file name", input.contentRef, L.MAX_EVIDENCE_FILE_NAME_LEN));
    push(sha256Problem(input.sha256));
  }
  if (input.issueIds.length < 1 || input.issueIds.length > L.MAX_ISSUES_PER_EVIDENCE) {
    out.push(`choose between 1 and ${L.MAX_ISSUES_PER_EVIDENCE} issues`);
  }
  const seen = new Set<string>();
  for (const id of input.issueIds) {
    if (!knownIssueIds.includes(id)) out.push(`unknown issue ${id}`);
    if (seen.has(id)) out.push(`issue ${id} is listed twice`);
    seen.add(id);
  }
  return out;
}

/** Positional arguments in contract order. The digest is sent in lowercase, as the contract stores it. */
export function submitEvidenceArgs(input: SubmitEvidenceInput): (string | string[])[] {
  return [input.caseId, input.evidenceType, input.label, input.description, input.contentRef, input.sha256.toLowerCase(), [...input.issueIds]];
}

// ---------------------------------------------------------------------------
// submit_reply
// ---------------------------------------------------------------------------

export interface SubmitReplyInput {
  caseId: string;
  reply: string;
}

export function validateSubmitReply(input: SubmitReplyInput): string[] {
  return [caseIdProblem(input.caseId), textProblem("reply", input.reply, CASE_ACTION_LIMITS.MAX_REPLY_LEN)].filter((p): p is string => p !== null);
}

export function submitReplyArgs(input: SubmitReplyInput): string[] {
  return [input.caseId, input.reply];
}

// ---------------------------------------------------------------------------
// process_reply_deadline, request_assessment
// ---------------------------------------------------------------------------

export function validateCaseIdOnly(caseId: string): string[] {
  const p = caseIdProblem(caseId);
  return p === null ? [] : [p];
}

// ---------------------------------------------------------------------------
// Review rows (exact values that will be encoded)
// ---------------------------------------------------------------------------

export interface ReviewRow {
  label: string;
  value: string | string[];
  note?: string;
}

const EVIDENCE_TYPE_TEXT: Record<EvidenceType, string> = {
  LINK: "LINK (a URL; the contract does not open it)",
  TEXT: "TEXT (a short excerpt written on chain)",
  FILE_DIGEST: "FILE_DIGEST (a file fingerprint; the file itself is not sent)",
};

export function describeSubmitEvidence(input: SubmitEvidenceInput): ReviewRow[] {
  const rows: ReviewRow[] = [
    { label: "Case", value: input.caseId },
    { label: "Evidence type", value: EVIDENCE_TYPE_TEXT[input.evidenceType] ?? input.evidenceType },
    { label: "Label", value: input.label },
    { label: "Description", value: input.description },
    {
      label: input.evidenceType === "LINK" ? "Link" : input.evidenceType === "TEXT" ? "Text excerpt" : "File name",
      value: input.contentRef === "" ? "(none)" : input.contentRef,
    },
    { label: "SHA-256", value: input.sha256 === "" ? "(none)" : input.sha256.toLowerCase() },
    { label: "Issues", value: [...input.issueIds] },
  ];
  return rows;
}

export function describeSubmitReply(input: SubmitReplyInput): ReviewRow[] {
  return [
    { label: "Case", value: input.caseId },
    { label: "Reply", value: input.reply, note: "Recorded as the respondent's reply. It locks the record: no evidence can be added afterwards." },
  ];
}
