/**
 * Cross-read consistency checks (pure). Each read is validated on its own;
 * these checks look for contradictions BETWEEN reads of the same case. A
 * contradiction is reported to the user; the affected section is never shown
 * as authoritative and nothing is "repaired".
 */
import {
  CASE_SCHEMA_VERSION,
  CASE_STATUSES,
  CATEGORIES,
  DETERMINATIONS,
  EVIDENCE_TYPES,
  HISTORY_ACTIONS,
  LOCK_REASONS,
  OUTCOMES,
  RESPONSE_STATES,
  ROLES,
  isOneOf,
} from "../contract/enums";
import type { CaseData } from "./caseReads";

export function checkConsistency(d: Pick<CaseData, "caseId" | "case" | "evidence" | "history" | "assessmentStatus" | "assessment">): string[] {
  const out: string[] = [];
  const c = d.case;
  if (c.case_id !== d.caseId) out.push(`The contract returned case ${c.case_id} when ${d.caseId} was requested.`);
  if (c.schema_version !== CASE_SCHEMA_VERSION) out.push(`Unexpected case schema version ${c.schema_version}.`);
  if (!isOneOf(CASE_STATUSES, c.status)) out.push(`Unrecognised case status ${c.status}.`);
  if (c.status === "ASSESSMENT_PENDING") out.push("The case reports ASSESSMENT_PENDING, a state the contract never stores.");
  if (!isOneOf(RESPONSE_STATES, c.response_state)) out.push(`Unrecognised response state ${c.response_state}.`);
  if (!isOneOf(CATEGORIES, c.category)) out.push(`Unrecognised category ${c.category}.`);
  if (c.snapshot_locked && !isOneOf(LOCK_REASONS, c.lock_reason)) out.push(`Unrecognised lock reason ${c.lock_reason}.`);
  if (c.status !== "AWAITING_RESPONSE" && !c.snapshot_locked) out.push(`Status ${c.status} requires a locked record, but the record is not locked.`);
  if (c.status === "AWAITING_RESPONSE" && c.snapshot_locked) out.push("The record is locked but the case still reports AWAITING_RESPONSE.");
  if (c.response_state === "PENDING" && c.status !== "AWAITING_RESPONSE") out.push(`No reply state is recorded, but the case status is ${c.status}.`);
  if (c.claimant_evidence_count + c.respondent_evidence_count !== c.evidence_count) out.push("The per-party evidence counts do not add up to the case's evidence count.");
  if (c.assessment_attempts > c.max_assessment_attempts) out.push("The case reports more assessment attempts than the contract allows.");
  if (c.reply_deadline !== c.created_at + c.reply_window_seconds) out.push("The reply deadline does not equal the creation time plus the reply window.");

  if (d.evidence.ok) {
    const ev = d.evidence.value;
    if (ev.length !== c.evidence_count) out.push(`The case reports ${c.evidence_count} evidence item(s), but the register lists ${ev.length}.`);
    if (c.snapshot_locked && c.locked_evidence_count !== ev.length) out.push("The register differs from the evidence count frozen when the record was locked.");
    const claimantItems = ev.filter((e) => e.submitter_role === "CLAIMANT").length;
    if (claimantItems !== c.claimant_evidence_count) out.push("The claimant's evidence count differs from the register.");
    const known = new Set(c.issues.map((i) => i.issue_id));
    ev.forEach((e, i) => {
      if (e.evidence_id !== `E${i + 1}`) out.push(`Evidence item ${i + 1} has id ${e.evidence_id}.`);
      if (!isOneOf(EVIDENCE_TYPES, e.evidence_type)) out.push(`${e.evidence_id}: unrecognised evidence type ${e.evidence_type}.`);
      if (!isOneOf(ROLES, e.submitter_role)) out.push(`${e.evidence_id}: unrecognised submitter role ${e.submitter_role}.`);
      const expectedSubmitter = e.submitter_role === "CLAIMANT" ? c.claimant : e.submitter_role === "RESPONDENT" ? c.respondent : null;
      if (expectedSubmitter !== null && e.submitter.toLowerCase() !== expectedSubmitter.toLowerCase()) {
        out.push(`${e.evidence_id}: the submitter address does not match the ${e.submitter_role.toLowerCase()}.`);
      }
      if (e.in_locked_snapshot !== c.snapshot_locked) out.push(`${e.evidence_id}: its lock flag differs from the case's.`);
      for (const id of e.issue_ids) if (!known.has(id)) out.push(`${e.evidence_id}: refers to unknown issue ${id}.`);
    });
  }

  if (d.history.ok) {
    const h = d.history.value;
    if (h.length !== c.history_count) out.push(`The case reports ${c.history_count} history entr(ies), but the timeline lists ${h.length}.`);
    h.forEach((e, i) => {
      if (e.seq !== i + 1) out.push(`History entry ${i + 1} has sequence number ${e.seq}.`);
      if (!isOneOf(HISTORY_ACTIONS, e.action)) out.push(`History entry ${e.seq}: unrecognised action ${e.action}.`);
    });
    if (h.length > 0 && h[0]?.action !== "CASE_CREATED") out.push("The timeline does not start with the case's creation.");
  }

  if (d.assessmentStatus.ok) {
    const s = d.assessmentStatus.value;
    if (s.case_id !== c.case_id || s.status !== c.status || s.attempts !== c.assessment_attempts) {
      out.push("The assessment status read disagrees with the case read.");
    }
  }

  if (d.assessment.ok) {
    const a = d.assessment.value;
    if (a.case_id !== c.case_id) out.push("The stored assessment belongs to another case.");
    if (a.exists) {
      if (c.status !== "DECIDED") out.push(`An assessment is stored, but the case status is ${c.status}.`);
      if (a.snapshot_digest !== c.snapshot_digest) out.push("The assessment's snapshot digest differs from the case's locked record.");
      if (a.response_state !== c.response_state) out.push("The assessment's response state differs from the case's.");
      if (!isOneOf(OUTCOMES, a.outcome)) out.push(`Unrecognised outcome ${a.outcome}.`);
      const issueIds = c.issues.map((i) => i.issue_id);
      const findingIds = a.issue_findings.map((f) => f.issue_id);
      if (findingIds.join(",") !== issueIds.join(",")) out.push("The assessment's findings do not cover exactly the case's issues, in order.");
      const evidenceIds = d.evidence.ok ? new Set(d.evidence.value.map((e) => e.evidence_id)) : null;
      for (const f of a.issue_findings) {
        if (!isOneOf(DETERMINATIONS, f.determination)) out.push(`Issue ${f.issue_id}: unrecognised determination ${f.determination}.`);
        if (evidenceIds !== null) {
          for (const id of [...f.supporting_evidence_ids, ...f.counter_evidence_ids]) {
            if (!evidenceIds.has(id)) out.push(`Issue ${f.issue_id} cites ${id}, which is not in the evidence register.`);
          }
        }
      }
    } else if (c.status === "DECIDED") {
      out.push("The case status is DECIDED, but no assessment is stored.");
    }
  }
  return out;
}
