/**
 * Forms for the four case-level writes, each ending in a prepared review.
 * The case is read first (read-only, after the contract check) so the form
 * can show the issues, the deadline, the viewer's role, quotas and attempts.
 * The write's own preflight re-checks everything from fresh reads.
 */
import { useState, type ReactNode } from "react";
import { EVIDENCE_TYPES, type EvidenceType } from "../contract/enums";
import { EXTERNAL_LINKS_CAN_CHANGE, FILE_HASH_NOTE, MISSING_RESPONSE_NOTE, REDACTION_NOTE } from "../contract/copy";
import { NOTICE_EXTERNAL_NOT_OPENED } from "../contract/notices";
import type { CaseData } from "../cases/caseReads";
import { caseActions } from "../cases/actions";
import { BeforeYouSubmit, type ConfirmationRow } from "../components/WriteConfirmation";
import { FormField } from "../components/FormField";
import { formatUtc, replyWindowView, viewerRole, DEVICE_CLOCK_NOTE } from "../display/caseText";
import { caseStatusLabel, responseStateLabel } from "../display/labels";
import {
  CASE_ACTION_LIMITS as L,
  describeSubmitEvidence,
  describeSubmitReply,
  validateSubmitEvidence,
  validateSubmitReply,
  type SubmitEvidenceInput,
} from "../write/caseActions";
import type { ContractWriteMethod } from "../write/methods";
import { processDeadlineSpec, requestAssessmentSpec, submitEvidenceSpec, submitReplySpec, type WriteSpec } from "./createCaseFlow";

export interface PreparedReview {
  caseId: string;
  method: ContractWriteMethod;
  functionSummary: string;
  rowsHeading: string;
  rows: ConfirmationRow[];
  beforeYouSubmit: boolean;
  warnings: { title: string; body: ReactNode }[];
  acknowledgement: string;
  inputProblems: string[];
  /** An extra confirmation the review must collect (e.g. the last assessment attempt). */
  extraConfirmation: string | null;
  buildSpec: (extraConfirmed: boolean) => WriteSpec;
}

export const MAX_HASHED_FILE_BYTES = 256 * 1024 * 1024;

/** SHA-256 of a user-selected file, computed in this browser. The file is never uploaded. */
export async function sha256OfFile(file: Blob): Promise<string> {
  if (file.size > MAX_HASHED_FILE_BYTES) throw new Error("the file is larger than 256 MB; compute its SHA-256 elsewhere and paste it");
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function ActionUnavailable({ note }: { note: string }) {
  return (
    <div className="callout" role="status">
      <p>
        <strong>Not available now:</strong> {note}
      </p>
    </div>
  );
}

function Step({ onReview, label = "Review the transaction" }: { onReview: () => void; label?: string }) {
  return (
    <div className="actions">
      <button className="button" type="button" onClick={onReview}>
        {label}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

const TYPE_TEXT: Record<EvidenceType, string> = {
  LINK: "Link to a document or page",
  TEXT: "Short text excerpt (written on chain)",
  FILE_DIGEST: "File fingerprint (SHA-256; the file stays on your device)",
};

/** This device's time when the form opened (Unix seconds); the contract decides with its own. */
function useOpenedAt(): number {
  const [now] = useState(() => Math.floor(Date.now() / 1000));
  return now;
}

export function EvidenceForm({ data, account, onReview }: { data: CaseData; account: string | null; onReview: (r: PreparedReview) => void }) {
  const c = data.case;
  const now = useOpenedAt();
  const action = caseActions(c, viewerRole(c, account), null, data.evidence.ok ? data.evidence.value : null, now).find(
    (a) => a.method === "submit_evidence",
  );
  const [input, setInput] = useState<SubmitEvidenceInput>({
    caseId: c.case_id,
    evidenceType: "LINK",
    label: "",
    description: "",
    contentRef: "",
    sha256: "",
    issueIds: [],
  });
  const [problems, setProblems] = useState<string[]>([]);
  const [hashState, setHashState] = useState<string | null>(null);
  const set = (patch: Partial<SubmitEvidenceInput>) => setInput({ ...input, ...patch });
  const issueIds = c.issues.map((i) => i.issue_id);

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    setHashState("Computing the SHA-256 in this browser…");
    try {
      const hex = await sha256OfFile(file);
      setInput((cur) => ({ ...cur, sha256: hex, contentRef: cur.evidenceType === "FILE_DIGEST" && cur.contentRef === "" ? file.name.slice(0, L.MAX_EVIDENCE_FILE_NAME_LEN) : cur.contentRef }));
      setHashState(`SHA-256 of ${file.name} computed locally. The file was not uploaded.`);
    } catch (err) {
      setHashState(`Could not compute the fingerprint: ${(err as Error).message}`);
    }
  };

  const review = () => {
    const p = validateSubmitEvidence(input, issueIds);
    setProblems(p);
    if (p.length > 0) return;
    onReview({
      caseId: c.case_id,
      method: "submit_evidence",
      functionSummary: "adds one evidence item to this case's register, as your submission",
      rowsHeading: "Evidence that will be written",
      rows: describeSubmitEvidence(input),
      beforeYouSubmit: true,
      warnings: [
        {
          title: "What the contract does with evidence",
          body: (
            <>
              <p>{NOTICE_EXTERNAL_NOT_OPENED}</p>
              <p>{REDACTION_NOTE}</p>
              {input.evidenceType === "LINK" ? <p>{EXTERNAL_LINKS_CAN_CHANGE}</p> : null}
              {input.sha256 !== "" ? <p>{FILE_HASH_NOTE}</p> : null}
              <p>Evidence cannot be edited or removed after it is recorded. Each party may add at most 10 items.</p>
            </>
          ),
        },
      ],
      acknowledgement: "I understand this evidence will be recorded on chain, may be public, and cannot be edited or deleted.",
      inputProblems: [],
      extraConfirmation: null,
      buildSpec: () => submitEvidenceSpec(input),
    });
  };

  if (action && !action.available) return <ActionUnavailable note={action.note} />;
  return (
    <section aria-labelledby="evidence-form-heading">
      <h2 id="evidence-form-heading">Submit evidence to {c.case_id}</h2>
      <BeforeYouSubmit />
      <p className="hint">{REDACTION_NOTE}</p>
      {action ? <p className="hint">{action.note}</p> : null}
      {problems.length > 0 ? (
        <div className="callout" role="alert">
          <p>
            <strong>Please fix:</strong>
          </p>
          <ul>
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <fieldset>
        <legend>Evidence type</legend>
        {EVIDENCE_TYPES.map((t) => (
          <label key={t} className="block">
            <input type="radio" name="evidence-type" checked={input.evidenceType === t} onChange={() => set({ evidenceType: t, contentRef: "", sha256: t === "TEXT" ? "" : input.sha256 })} />{" "}
            {TYPE_TEXT[t]}
          </label>
        ))}
      </fieldset>
      <FormField label="Label" value={input.label} onChange={(v) => set({ label: v })} max={L.MAX_EVIDENCE_LABEL_LEN} hint="A short name the assessment and the other party will see." required />
      <FormField
        label="Description"
        multiline
        value={input.description}
        onChange={(v) => set({ description: v })}
        max={L.MAX_EVIDENCE_DESCRIPTION_LEN}
        hint="What this item shows and why it matters. It is your account, not a fact."
        required
      />
      {input.evidenceType === "LINK" ? (
        <FormField label="Link (http or https)" value={input.contentRef} onChange={(v) => set({ contentRef: v })} max={L.MAX_EVIDENCE_URL_LEN} hint={EXTERNAL_LINKS_CAN_CHANGE} monospace required wide />
      ) : input.evidenceType === "TEXT" ? (
        <FormField label="Text excerpt" multiline value={input.contentRef} onChange={(v) => set({ contentRef: v })} max={L.MAX_EVIDENCE_TEXT_LEN} hint="Quote only what is needed. It is written on chain." required />
      ) : (
        <FormField label="File name (optional)" value={input.contentRef} onChange={(v) => set({ contentRef: v })} max={L.MAX_EVIDENCE_FILE_NAME_LEN} />
      )}
      {input.evidenceType !== "TEXT" ? (
        <fieldset>
          <legend>{input.evidenceType === "FILE_DIGEST" ? "File fingerprint (required)" : "File fingerprint (optional)"}</legend>
          <label className="block">
            Choose a file to fingerprint locally{" "}
            <input type="file" onChange={(e) => void pickFile(e.target.files?.[0])} />
          </label>
          {hashState !== null ? (
            <p role="status" className="hint">
              {hashState}
            </p>
          ) : null}
          <FormField label="SHA-256 (hex)" value={input.sha256} onChange={(v) => set({ sha256: v.trim() })} hint={FILE_HASH_NOTE} monospace wide />
        </fieldset>
      ) : null}
      <fieldset>
        <legend>Which issues does it concern? (1 to {L.MAX_ISSUES_PER_EVIDENCE})</legend>
        {c.issues.map((i) => (
          <label key={i.issue_id} className="block">
            <input
              type="checkbox"
              checked={input.issueIds.includes(i.issue_id)}
              onChange={(e) => set({ issueIds: e.target.checked ? [...input.issueIds, i.issue_id] : input.issueIds.filter((x) => x !== i.issue_id) })}
            />{" "}
            <code>{i.issue_id}</code> <span className="break">{i.description}</span>
          </label>
        ))}
      </fieldset>
      <Step onReview={review} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Reply
// ---------------------------------------------------------------------------

export function ReplyForm({ data, account, onReview }: { data: CaseData; account: string | null; onReview: (r: PreparedReview) => void }) {
  const c = data.case;
  const now = useOpenedAt();
  const action = caseActions(c, viewerRole(c, account), null, null, now).find((a) => a.method === "submit_reply");
  const [reply, setReply] = useState("");
  const [problems, setProblems] = useState<string[]>([]);
  const lockWarning = (
    <p>
      <strong>Submitting your reply locks the record.</strong> After it, neither party can add evidence, and the case becomes ready for an assessment. Add any
      evidence you want considered <strong>before</strong> you reply.
    </p>
  );
  const review = () => {
    const input = { caseId: c.case_id, reply };
    const p = validateSubmitReply(input);
    setProblems(p);
    if (p.length > 0) return;
    onReview({
      caseId: c.case_id,
      method: "submit_reply",
      functionSummary: "records your reply as the respondent and locks the record",
      rowsHeading: "Reply that will be written",
      rows: describeSubmitReply(input),
      beforeYouSubmit: true,
      warnings: [{ title: "This locks the record", body: lockWarning }],
      acknowledgement: "I understand my reply will be recorded on chain, may be public, cannot be changed, and locks the record.",
      inputProblems: [],
      extraConfirmation: null,
      buildSpec: () => submitReplySpec(input),
    });
  };
  if (action && !action.available) return <ActionUnavailable note={action.note} />;
  return (
    <section aria-labelledby="reply-form-heading">
      <h2 id="reply-form-heading">Reply to {c.case_id}</h2>
      <EvidenceSummary data={data} />
      <div className="callout" role="note">
        {lockWarning}
      </div>
      <BeforeYouSubmit />
      {problems.length > 0 ? (
        <p className="field-error" role="alert">
          {problems.join("; ")}
        </p>
      ) : null}
      <FormField label="Your reply" multiline value={reply} onChange={setReply} max={L.MAX_REPLY_LEN} hint="Your account of the dispute, in your own words. It is recorded as your statement." required />
      <p className="hint">
        {replyWindowView(c, now).headline}. {DEVICE_CLOCK_NOTE}
      </p>
      <Step onReview={review} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Missed deadline
// ---------------------------------------------------------------------------

export function DeadlineForm({ data, account, onReview }: { data: CaseData; account: string | null; onReview: (r: PreparedReview) => void }) {
  const c = data.case;
  const now = useOpenedAt();
  const action = caseActions(c, viewerRole(c, account), null, null, now).find((a) => a.method === "process_reply_deadline");
  if (action && !action.available) return <ActionUnavailable note={action.note} />;
  const review = () =>
    onReview({
      caseId: c.case_id,
      method: "process_reply_deadline",
      functionSummary: "records that no reply was received before the deadline, and locks the record",
      rowsHeading: "What will be recorded",
      rows: [
        { label: "Case", value: c.case_id },
        { label: "Reply deadline", value: formatUtc(c.reply_deadline), note: "Checked before your wallet is asked: this device's clock must be at least 10 minutes past it. The contract decides with the transaction's own time; if it disagreed, the transaction would revert and change nothing." },
      ],
      beforeYouSubmit: false,
      warnings: [
        {
          title: "This locks the record",
          body: (
            <>
              <p>No more evidence or reply can be added afterwards, and the case becomes ready for an assessment.</p>
              <p>{MISSING_RESPONSE_NOTE}</p>
            </>
          ),
        },
      ],
      acknowledgement: "I understand this records a missed reply deadline on chain and locks the record.",
      inputProblems: [],
      extraConfirmation: null,
      buildSpec: () => processDeadlineSpec(c.case_id),
    });
  return (
    <section aria-labelledby="deadline-form-heading">
      <h2 id="deadline-form-heading">Record the missed reply deadline for {c.case_id}</h2>
      <p>
        The reply deadline was {formatUtc(c.reply_deadline)}. No reply is recorded. Either party can ask the contract to record this. {MISSING_RESPONSE_NOTE}
      </p>
      <p className="hint">{DEVICE_CLOCK_NOTE}</p>
      <Step onReview={review} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Assessment request
// ---------------------------------------------------------------------------

function EvidenceSummary({ data }: { data: CaseData }) {
  const ev = data.evidence.ok ? data.evidence.value : [];
  return (
    <details>
      <summary>
        The record so far: {data.case.issues.length} issue(s), {ev.length} evidence item(s)
      </summary>
      <ul>
        {data.case.issues.map((i) => (
          <li key={i.issue_id}>
            <code>{i.issue_id}</code> <span className="break">{i.description}</span>
          </li>
        ))}
      </ul>
      <ul>
        {ev.map((e) => (
          <li key={e.evidence_id}>
            <code>{e.evidence_id}</code> <span className="break">{e.label}</span> ({e.submitter_role.toLowerCase()})
          </li>
        ))}
      </ul>
    </details>
  );
}

export function AssessmentForm({ data, account, onReview }: { data: CaseData; account: string | null; onReview: (r: PreparedReview) => void }) {
  const c = data.case;
  const now = useOpenedAt();
  const status = data.assessmentStatus.ok ? data.assessmentStatus.value : null;
  const action = caseActions(c, viewerRole(c, account), status, null, now).find((a) => a.method === "request_assessment");
  if (action && !action.available) return <ActionUnavailable note={action.note} />;
  const last = status !== null && status.remaining_attempts <= 1;
  const ev = data.evidence.ok ? data.evidence.value : [];
  const review = () =>
    onReview({
      caseId: c.case_id,
      method: "request_assessment",
      functionSummary: "asks the contract to assess the locked record (an AI-assisted assessment, accepted only through validator agreement)",
      rowsHeading: "The locked record that will be assessed",
      rows: [
        { label: "Case", value: c.case_id },
        { label: "Snapshot digest", value: c.snapshot_digest, note: "The contract refuses the assessment if the record no longer matches this digest." },
        { label: "Reply", value: responseStateLabel(c.response_state) },
        { label: "Issues", value: c.issues.map((i) => `${i.issue_id}: ${i.description}`) },
        { label: "Evidence", value: ev.length === 0 ? "(none)" : ev.map((e) => `${e.evidence_id}: ${e.label} (${e.evidence_type}, ${e.submitter_role.toLowerCase()})`) },
        { label: "Attempts", value: status === null ? "unknown" : `${status.attempts} used of ${status.max_attempts}; this would be attempt ${status.attempts + 1}` },
      ],
      beforeYouSubmit: false,
      warnings: [
        {
          title: "What an assessment request does",
          body: (
            <>
              <p>
                The contract runs an AI model on the locked record; validators must agree on the outcome and the issue determinations. It can take several
                minutes. The result is an AI-assisted assessment, not legal advice, a court judgment or a binding award, and it moves no money.
              </p>
              <p>
                A transaction that fails or ends without agreement changes nothing and uses no attempt. An attempt whose model output is agreed to be invalid
                does use one; after {status?.max_attempts ?? 2} such attempts no assessment can be produced for this case.
              </p>
              <p>Never send this request twice: if the outcome is unclear, check the case first.</p>
            </>
          ),
        },
      ],
      acknowledgement: "I understand this requests an AI-assisted assessment on chain, which cannot be withdrawn.",
      inputProblems: [],
      extraConfirmation: last ? "This is the last allowed attempt for this case. I understand that if it produces no valid result, no assessment can ever be produced for it." : null,
      buildSpec: (extra) => requestAssessmentSpec(c.case_id, { lastAttemptAcknowledged: extra }),
    });
  return (
    <section aria-labelledby="assessment-form-heading">
      <h2 id="assessment-form-heading">Request the assessment of {c.case_id}</h2>
      <p>
        Status: {caseStatusLabel(c.status)}. {action?.note}
      </p>
      <EvidenceSummary data={data} />
      {last ? (
        <p className="callout" role="note">
          Only one attempt remains for this case.
        </p>
      ) : null}
      <Step onReview={review} />
    </section>
  );
}
