/**
 * Read-only checks for a write's intended effect in contract state, per
 * method. Used after finality (success needs the effect at latest-final) and
 * by reconciliation of an uncertain write (the effect at latest-final proves
 * the write happened and must not be repeated).
 *
 * Rules:
 * - Only changes after the recorded baseline count (create_case: the sender's
 *   party-case count; submit_evidence: the case's evidence count;
 *   request_assessment: the case's attempt count).
 * - More than one matching change is "ambiguous", never success.
 * - A failed or timed-out read throws; callers turn that into "unknown",
 *   never into "absent".
 */
import { withTimeout } from "../live/errors";
import type { PendingRecord } from "./pendingStore";
import type { ReconciliationReader } from "./reconcileReader";

export type Variant = "latest-final" | "latest-nonfinal";

export type EffectMatch =
  | { kind: "match"; caseId: string; detail: string }
  | { kind: "none"; detail: string }
  | { kind: "ambiguous"; detail: string };

const PAGE = 50;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export async function matchEffect(reader: ReconciliationReader, r: PendingRecord, variant: Variant, timeoutMs: number): Promise<EffectMatch> {
  const eff = r.expectedEffect;
  if (eff === null) throw new Error("no effect check is defined for this operation");
  const readCase = async (caseId: string): Promise<Obj> => {
    const c = await withTimeout(reader.readContract(r.contract, "get_case", [caseId], variant), timeoutMs, `get_case ${caseId}`);
    if (!isObj(c) || c.case_id !== caseId) throw new Error(`malformed get_case ${caseId}`);
    return c;
  };

  if (!("kind" in eff)) {
    // create_case
    if (r.baselinePartyCaseCount === null) throw new Error("no baseline was recorded");
    const page = await withTimeout(
      reader.readContract(r.contract, "get_party_case_ids", [r.sender, r.baselinePartyCaseCount, PAGE], variant),
      timeoutMs,
      "party cases",
    );
    if (!isObj(page) || !Array.isArray(page.case_ids)) throw new Error("malformed case list");
    const matches: string[] = [];
    for (const id of page.case_ids) {
      if (typeof id !== "string") throw new Error("malformed case id");
      const c = (await withTimeout(reader.readContract(r.contract, "get_case", [id], variant), timeoutMs, `get_case ${id}`)) as Obj | null;
      if (
        c &&
        String(c.claimant).toLowerCase() === r.sender.toLowerCase() &&
        String(c.respondent).toLowerCase() === eff.respondent.toLowerCase() &&
        c.title === eff.title
      ) {
        matches.push(id);
      }
    }
    if (matches.length > 1) return { kind: "ambiguous", detail: `more than one matching case (${matches.join(", ")}): investigate before trusting either` };
    const [only] = matches;
    return only === undefined
      ? { kind: "none", detail: `no case after the baseline (${r.baselinePartyCaseCount}) matches` }
      : { kind: "match", caseId: only, detail: `${only} matches the intended case` };
  }

  switch (eff.kind) {
    case "submit_evidence": {
      const list = await withTimeout(reader.readContract(r.contract, "get_case_evidence", [eff.caseId], variant), timeoutMs, `get_case_evidence ${eff.caseId}`);
      if (!Array.isArray(list)) throw new Error("malformed evidence list");
      const matches = list.slice(eff.baselineEvidenceCount).filter(
        (e): e is Obj =>
          isObj(e) &&
          String(e.submitter).toLowerCase() === r.sender.toLowerCase() &&
          e.label === eff.label &&
          e.description === eff.description &&
          e.content_ref === eff.contentRef &&
          e.sha256 === eff.sha256,
      );
      if (matches.length > 1) return { kind: "ambiguous", detail: `${matches.length} identical new evidence items in ${eff.caseId}: investigate` };
      const [m] = matches;
      return m === undefined
        ? { kind: "none", detail: `no matching evidence after item ${eff.baselineEvidenceCount} in ${eff.caseId}` }
        : { kind: "match", caseId: eff.caseId, detail: `${String(m.evidence_id)} in ${eff.caseId} matches the intended evidence` };
    }
    case "submit_reply": {
      const c = await readCase(eff.caseId);
      if (c.response_state === "SUBMITTED" && c.reply === eff.reply && String(c.respondent).toLowerCase() === r.sender.toLowerCase()) {
        return { kind: "match", caseId: eff.caseId, detail: `the reply is recorded in ${eff.caseId}` };
      }
      return { kind: "none", detail: `${eff.caseId} shows response state ${String(c.response_state)}` };
    }
    case "process_reply_deadline": {
      const c = await readCase(eff.caseId);
      return c.response_state === "NO_RESPONSE_BY_DEADLINE"
        ? { kind: "match", caseId: eff.caseId, detail: `${eff.caseId} records that no reply was received before the deadline` }
        : { kind: "none", detail: `${eff.caseId} shows response state ${String(c.response_state)}` };
    }
    case "request_assessment": {
      const c = await readCase(eff.caseId);
      const attempts = c.assessment_attempts;
      if (typeof attempts !== "number") throw new Error("malformed attempt count");
      if (attempts <= eff.baselineAttempts) return { kind: "none", detail: `${eff.caseId} still shows ${attempts} attempt(s)` };
      return {
        kind: "match",
        caseId: eff.caseId,
        detail: `${eff.caseId} now shows ${attempts} attempt(s) (was ${eff.baselineAttempts}); status ${String(c.status)}`,
      };
    }
  }
}

/** Short description of the intended effect, for messages. */
export function effectNoun(method: PendingRecord["method"]): string {
  switch (method) {
    case "create_case":
      return "creating the case";
    case "submit_evidence":
      return "recording the evidence";
    case "submit_reply":
      return "recording the reply";
    case "process_reply_deadline":
      return "recording the missed deadline";
    case "request_assessment":
      return "recording an assessment attempt";
  }
}
