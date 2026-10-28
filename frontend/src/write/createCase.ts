/**
 * The `create_case` input: one object feeds BOTH the confirmation screen and
 * the encoded call, so what the user approves is what gets encoded.
 *
 * Validation mirrors contracts/vericourt.py `create_case` (_check_text,
 * _check_string_list, _check_address and the constants; a test parses the
 * contract so the limits cannot drift). Lengths count Unicode code points, as
 * Python's len() does. The contract remains the authority; this is a
 * pre-flight so the user is not asked to sign a call that would fail.
 *
 * Pure module: no SDK, no wallet, no network. It is the only part of
 * src/write that UI code may import.
 */
import { CATEGORIES, type Category } from "../contract/enums";

export const CREATE_CASE_LIMITS = {
  MIN_TITLE_LEN: 5,
  MAX_TITLE_LEN: 120,
  MAX_AGREEMENT_LEN: 2000,
  MAX_DELIVERABLE_LEN: 1000,
  MAX_CLAIM_LEN: 4000,
  MAX_REMEDY_LEN: 1000,
  MIN_ISSUES: 1,
  MAX_ISSUES: 5,
  MAX_ISSUE_LEN: 300,
  MIN_REPLY_WINDOW_SECONDS: 3600,
  MAX_REPLY_WINDOW_SECONDS: 30 * 24 * 3600,
} as const;

export interface CreateCaseInput {
  respondent: string;
  category: Category;
  title: string;
  agreementSummary: string;
  expectedDeliverable: string;
  claim: string;
  requestedRemedy: string;
  issues: string[];
  replyWindowSeconds: number;
}

/** Contract argument order of `create_case`. */
export const CREATE_CASE_PARAMS = [
  "respondent",
  "category",
  "title",
  "agreement_summary",
  "expected_deliverable",
  "claim",
  "requested_remedy",
  "issues",
  "reply_window_seconds",
] as const;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO = `0x${"0".repeat(40)}`;

function codePoints(s: string): number {
  return [...s].length;
}

function textProblem(field: string, value: unknown, max: number, min = 1): string | null {
  if (typeof value !== "string") return `${field} must be text`;
  if (codePoints(value.trim()) < min) return min <= 1 ? `${field} is required` : `${field} must be at least ${min} characters`;
  if (codePoints(value) > max) return `${field} exceeds ${max} characters`;
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if ((code < 32 && ch !== "\n" && ch !== "\t") || code === 127) return `${field} contains control characters`;
  }
  return null;
}

/** Returns every problem found (empty when the input is acceptable). `claimant` is the connected account. */
export function validateCreateCase(input: CreateCaseInput, claimant: string | null): string[] {
  const L = CREATE_CASE_LIMITS;
  const problems: string[] = [];
  const push = (p: string | null) => {
    if (p !== null) problems.push(p);
  };
  if (!ADDRESS.test(input.respondent)) problems.push("respondent must be a 0x-prefixed 20-byte hex address");
  else if (input.respondent.toLowerCase() === ZERO) problems.push("respondent must not be the zero address");
  else if (claimant !== null && input.respondent.toLowerCase() === claimant.toLowerCase()) {
    problems.push("claimant and respondent must be different addresses");
  }
  if (!(CATEGORIES as readonly string[]).includes(input.category)) problems.push(`category must be one of ${CATEGORIES.join(", ")}`);
  push(textProblem("title", input.title, L.MAX_TITLE_LEN, L.MIN_TITLE_LEN));
  push(textProblem("agreement_summary", input.agreementSummary, L.MAX_AGREEMENT_LEN));
  push(textProblem("expected_deliverable", input.expectedDeliverable, L.MAX_DELIVERABLE_LEN));
  push(textProblem("claim", input.claim, L.MAX_CLAIM_LEN));
  push(textProblem("requested_remedy", input.requestedRemedy, L.MAX_REMEDY_LEN));
  if (!Array.isArray(input.issues) || input.issues.length < L.MIN_ISSUES || input.issues.length > L.MAX_ISSUES) {
    problems.push(`issues must contain between ${L.MIN_ISSUES} and ${L.MAX_ISSUES} items`);
  } else {
    const seen = new Set<string>();
    for (const issue of input.issues) {
      push(textProblem("issue", issue, L.MAX_ISSUE_LEN));
      const key = typeof issue === "string" ? issue.split(/\s+/).filter(Boolean).join(" ").toLowerCase() : "";
      if (seen.has(key)) problems.push("duplicate issue description");
      seen.add(key);
    }
  }
  if (!Number.isSafeInteger(input.replyWindowSeconds)) problems.push("reply_window_seconds must be an integer");
  else if (input.replyWindowSeconds < L.MIN_REPLY_WINDOW_SECONDS || input.replyWindowSeconds > L.MAX_REPLY_WINDOW_SECONDS) {
    problems.push(`reply_window_seconds must be between ${L.MIN_REPLY_WINDOW_SECONDS} and ${L.MAX_REPLY_WINDOW_SECONDS}`);
  }
  return problems;
}

export type CreateCaseArg = string | bigint | string[];

/** Positional arguments in contract order (the integer is a bigint so it encodes as an int). */
export function createCaseArgs(input: CreateCaseInput): CreateCaseArg[] {
  return [
    input.respondent,
    input.category,
    input.title,
    input.agreementSummary,
    input.expectedDeliverable,
    input.claim,
    input.requestedRemedy,
    [...input.issues],
    BigInt(input.replyWindowSeconds),
  ];
}

export interface ConfirmationField {
  param: (typeof CREATE_CASE_PARAMS)[number];
  label: string;
  /** Exactly the value that will be encoded, as text (never interpreted as HTML). */
  value: string | string[];
  note?: string;
}

function windowText(seconds: number): string {
  const hours = seconds / 3600;
  return Number.isInteger(hours) ? `${hours} hour${hours === 1 ? "" : "s"}` : `${seconds} seconds`;
}

/** Human-readable rows for the confirmation screen, in contract order. */
export function describeCreateCase(input: CreateCaseInput): ConfirmationField[] {
  return [
    { param: "respondent", label: "Respondent (other party)", value: input.respondent },
    { param: "category", label: "Category", value: input.category },
    { param: "title", label: "Title", value: input.title },
    { param: "agreement_summary", label: "Agreement summary", value: input.agreementSummary },
    { param: "expected_deliverable", label: "Expected deliverable", value: input.expectedDeliverable },
    { param: "claim", label: "Claim", value: input.claim },
    { param: "requested_remedy", label: "Requested remedy", value: input.requestedRemedy, note: "Advisory only; the contract cannot enforce it." },
    { param: "issues", label: "Issues", value: [...input.issues], note: "Numbered I1, I2… by the contract." },
    {
      param: "reply_window_seconds",
      label: "Reply window",
      value: `${input.replyWindowSeconds} seconds (${windowText(input.replyWindowSeconds)})`,
      note: "Starts when the transaction executes.",
    },
  ];
}
