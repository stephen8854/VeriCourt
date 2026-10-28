/**
 * Runtime validation of decoded contract reads. A response that does not match
 * the contract's view shape is reported as malformed and is never rendered as
 * case data. Field lists follow contracts/vericourt.py (get_* views).
 */
import type {
  AssessmentView,
  CaseView,
  EvidenceView,
  HistoryEntryView,
  StoredAssessmentView,
} from "../contract/types";
import type { ReadMethod } from "./gateway";

export type Validation<T> = { ok: true; value: T } | { ok: false; problems: string[] };

type Kind = "string" | "number" | "boolean" | "string[]" | "object" | "array";

function check(obj: unknown, fields: Record<string, Kind>, where: string): string[] {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return [`${where}: not an object`];
  const o = obj as Record<string, unknown>;
  const problems: string[] = [];
  for (const [key, kind] of Object.entries(fields)) {
    const v = o[key];
    const ok =
      kind === "string[]"
        ? Array.isArray(v) && v.every((x) => typeof x === "string")
        : kind === "array"
          ? Array.isArray(v)
          : kind === "object"
            ? typeof v === "object" && v !== null && !Array.isArray(v)
            : typeof v === kind && !(kind === "number" && !Number.isFinite(v));
    if (!ok) problems.push(`${where}.${key}: expected ${kind}, got ${v === null ? "null" : Array.isArray(v) ? "array" : typeof v}`);
  }
  return problems;
}

const CASE_FIELDS: Record<string, Kind> = {
  case_id: "string", schema_version: "string", claimant: "string", respondent: "string", category: "string",
  title: "string", agreement_summary: "string", expected_deliverable: "string", claim: "string",
  requested_remedy: "string", issues: "array", created_at: "number", reply_window_seconds: "number",
  reply_deadline: "number", status: "string", response_state: "string", reply: "string", replied_at: "number",
  evidence_count: "number", claimant_evidence_count: "number", respondent_evidence_count: "number",
  snapshot_locked: "boolean", locked_at: "number", lock_reason: "string", locked_evidence_count: "number",
  assessment_attempts: "number", max_assessment_attempts: "number", last_assessment_error: "string",
  snapshot_digest: "string", history_count: "number",
};
const CASE_STATUS_FIELDS: Record<string, Kind> = {
  case_id: "string", status: "string", response_state: "string", created_at: "number", reply_deadline: "number",
  snapshot_locked: "boolean", locked_at: "number", lock_reason: "string",
};
const EVIDENCE_FIELDS: Record<string, Kind> = {
  evidence_id: "string", submitter: "string", submitter_role: "string", evidence_type: "string", label: "string",
  description: "string", content_ref: "string", sha256: "string", submitted_at: "number", issue_ids: "string[]",
  in_locked_snapshot: "boolean",
};
const HISTORY_FIELDS: Record<string, Kind> = { seq: "number", action: "string", actor: "string", at: "number", detail: "string" };
const ASSESSMENT_STATUS_FIELDS: Record<string, Kind> = {
  case_id: "string", status: "string", has_assessment: "boolean", attempts: "number", max_attempts: "number",
  remaining_attempts: "number", can_request: "boolean", last_error: "string", schema_version: "string",
};
const STORED_ASSESSMENT_FIELDS: Record<string, Kind> = {
  schema_version: "string", methodology_version: "string", case_id: "string", outcome: "string",
  remedy_assessment: "string", summary: "string", issue_findings: "array", limitations: "string[]",
  notices: "string[]", standard_notices: "string[]", provenance: "object", response_state: "string",
  snapshot_digest: "string", attempt: "number", assessed_at: "number",
};
const MISSING_ASSESSMENT_FIELDS: Record<string, Kind> = { case_id: "string", status: "string", attempts: "number", schema_version: "string" };
const FINDING_FIELDS: Record<string, Kind> = {
  issue_id: "string", determination: "string", confidence: "string", finding: "string", reasoning: "string",
  supporting_evidence_ids: "string[]", counter_evidence_ids: "string[]", open_questions: "string[]",
};
const CONTRACT_INFO_FIELDS: Record<string, Kind> = {
  schema_version: "string", case_count: "number", statuses: "string[]", categories: "string[]",
  evidence_types: "string[]", limits: "object", assessment: "object",
};

function listOf(value: unknown, fields: Record<string, Kind>, where: string): string[] {
  if (!Array.isArray(value)) return [`${where}: not an array`];
  return value.flatMap((item, i) => check(item, fields, `${where}[${i}]`));
}

function result<T>(value: unknown, problems: string[]): Validation<T> {
  return problems.length === 0 ? { ok: true, value: value as T } : { ok: false, problems };
}

export function validateCase(v: unknown): Validation<CaseView> {
  const problems = check(v, CASE_FIELDS, "get_case");
  if (problems.length === 0) problems.push(...listOf((v as CaseView).issues, { issue_id: "string", description: "string" }, "get_case.issues"));
  return result(v, problems);
}

export function validateAssessment(v: unknown): Validation<AssessmentView> {
  if (typeof v !== "object" || v === null) return { ok: false, problems: ["get_assessment: not an object"] };
  const exists = (v as { exists?: unknown }).exists;
  if (exists === false) return result(v, check(v, MISSING_ASSESSMENT_FIELDS, "get_assessment"));
  if (exists !== true) return { ok: false, problems: ["get_assessment.exists: expected boolean"] };
  const problems = check(v, STORED_ASSESSMENT_FIELDS, "get_assessment");
  if (problems.length === 0) {
    problems.push(...listOf((v as StoredAssessmentView).issue_findings, FINDING_FIELDS, "get_assessment.issue_findings"));
  }
  return result(v, problems);
}

export interface PartyCaseIdsView {
  total: number;
  case_ids: string[];
}

export function validatePartyCaseIds(v: unknown): Validation<PartyCaseIdsView> {
  const problems = check(v, { total: "number", case_ids: "string[]" }, "get_party_case_ids");
  if (problems.length === 0) {
    const p = v as PartyCaseIdsView;
    if (!Number.isSafeInteger(p.total) || p.total < 0) problems.push("get_party_case_ids.total: expected a non-negative integer");
    if (p.case_ids.length > p.total) problems.push("get_party_case_ids: more ids than the reported total");
  }
  return result(v, problems);
}

/** Validates any read method's decoded result. */
export function validateRead(method: ReadMethod, v: unknown): Validation<unknown> {
  switch (method) {
    case "get_contract_info":
      return result(v, check(v, CONTRACT_INFO_FIELDS, method));
    case "get_case_count":
      return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? { ok: true, value: v } : { ok: false, problems: [`${method}: expected a non-negative integer`] };
    case "get_case":
      return validateCase(v);
    case "get_case_status":
      return result(v, check(v, CASE_STATUS_FIELDS, method));
    case "get_case_evidence":
      return result<EvidenceView[]>(v, listOf(v, EVIDENCE_FIELDS, method));
    case "get_case_history":
      return result<HistoryEntryView[]>(v, listOf(v, HISTORY_FIELDS, method));
    case "get_assessment_status":
      return result(v, check(v, ASSESSMENT_STATUS_FIELDS, method));
    case "get_assessment":
      return validateAssessment(v);
    case "get_party_case_ids":
      return validatePartyCaseIds(v);
  }
}

/** Paths where two decoded values differ (first `limit` only). */
export function diffPaths(a: unknown, b: unknown, path = "$", limit = 20, out: string[] = []): string[] {
  if (out.length >= limit) return out;
  if (Object.is(a, b)) return out;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") {
    out.push(path);
    return out;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    out.push(path);
    return out;
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  for (const k of new Set([...ka, ...kb])) {
    diffPaths((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`, limit, out);
    if (out.length >= limit) break;
  }
  return out;
}
