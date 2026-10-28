/**
 * Every generated label for every contract enum value is scanned for wording
 * the Phase 2.18B audit bans: legal/verdict language, implied intent from
 * silence, payment/enforcement, and certainty claims.
 */
import { describe, expect, it } from "vitest";
import { CASE_STATUSES, CONFIDENCE_LEVELS, DETERMINATIONS, OUTCOMES, REMEDY_ASSESSMENTS, RESPONSE_STATES } from "../contract/enums";
import { caseStatusLabel, confidenceLabel, determinationLabel, finalityLabel, outcomeLabel, responseStateLabel } from "./labels";
import { provenanceLabel, type ProvenanceClass } from "./provenance";
import { remedyDisplay } from "./remedy";
import { citationGroups } from "./citations";
import { DEVICE_CLOCK_NOTE, historyActionLabel, lockReasonLabel, replyWindowView } from "./caseText";
import { HISTORY_ACTIONS, LOCK_REASONS } from "../contract/enums";
import { caseActions } from "../cases/actions";
import type { CaseView } from "../contract/types";

const FORBIDDEN = [
  /\bverdict/i,
  /\bruling/i,
  /\bjudg(e)?ment/i,
  /\bguilty/i,
  /\bliab(le|ility)/i,
  /\bwinner|\bwins?\b|\blos(e|es|er)\b/i,
  /\bproven?\b|\bproof\b/i,
  /\btrue\b|\btruth/i,
  /\badmi(t|ssion)/i,
  /\bdeclin/i,
  /\brefus/i,
  /\bignor/i,
  /\bdefault/i,
  /\buncontested/i,
  /\bpay(s|ment)?\b|\brefund|\bescrow|\benforc/i,
];

function allLabels(): string[] {
  const classes: ProvenanceClass[] = [
    "consensus_compared",
    "partially_checked",
    "leader_generated_constrained",
    "leader_generated_unverified",
    "contract_generated",
  ];
  return [
    ...CASE_STATUSES.map(caseStatusLabel),
    ...RESPONSE_STATES.map(responseStateLabel),
    ...OUTCOMES.map(outcomeLabel),
    ...DETERMINATIONS.map(determinationLabel),
    ...CONFIDENCE_LEVELS.map(confidenceLabel),
    ...(["not_checked", "not_final", "final"] as const).map(finalityLabel),
    ...REMEDY_ASSESSMENTS.flatMap((r) => {
      const d = remedyDisplay(r);
      return [d.label, d.provenance, d.note ?? ""];
    }),
    ...classes.map(provenanceLabel),
    ...HISTORY_ACTIONS.map(historyActionLabel),
    ...LOCK_REASONS.map(lockReasonLabel),
    DEVICE_CLOCK_NOTE,
    ...caseTextSamples(),
    ...DETERMINATIONS.flatMap((d) =>
      citationGroups({ determination: d, supporting_evidence_ids: ["E1"], counter_evidence_ids: ["E2"] }).map((g) => g.heading),
    ),
  ];
}

/** Reply-window wording and action notes for every state and role combination. */
function caseTextSamples(): string[] {
  const base = {
    status: "AWAITING_RESPONSE", response_state: "PENDING", reply_deadline: 100, replied_at: 50, snapshot_locked: false,
    claimant_evidence_count: 0, respondent_evidence_count: 0, evidence_count: 0,
  } as unknown as CaseView;
  const variants: CaseView[] = [
    base,
    { ...base, response_state: "SUBMITTED", status: "READY_FOR_ASSESSMENT", snapshot_locked: true },
    { ...base, response_state: "NO_RESPONSE_BY_DEADLINE", status: "READY_FOR_ASSESSMENT", snapshot_locked: true },
    { ...base, claimant_evidence_count: 10, respondent_evidence_count: 10, evidence_count: 20 },
  ];
  const status = { case_id: "", status: "", has_assessment: false, attempts: 1, max_attempts: 2, remaining_attempts: 1, can_request: true, last_error: "", schema_version: "" };
  const out: string[] = [];
  for (const c of variants) {
    for (const now of [10, 1000]) {
      const r = replyWindowView(c, now);
      out.push(r.headline, r.detail);
      for (const role of ["CLAIMANT", "RESPONDENT", null] as const) {
        for (const s of [status, { ...status, can_request: false }, null]) {
          for (const a of caseActions(c, role, s, [], now)) out.push(a.label, a.note);
        }
      }
    }
  }
  return [...new Set(out)].filter((x) => x !== "");
}

describe("generated labels avoid banned wording", () => {
  it.each(allLabels().map((l) => [l]))("%s", (label) => {
    for (const pattern of FORBIDDEN) expect(label).not.toMatch(pattern);
  });
});
