/**
 * Create-case wizard (spec §10.3): category and title; agreement and
 * deliverable; claim, remedy and issues; other party and reply window; then
 * the review screen. Templates only suggest wording: they never change a
 * contract rule. The draft lives in memory only (nothing is stored).
 */
import { useState } from "react";
import { FormField } from "../components/FormField";
import { CATEGORIES, type Category } from "../contract/enums";
import { CREATE_CASE_LIMITS as L, validateCreateCase, type CreateCaseInput } from "../write/createCase";

export interface CreateDraft {
  category: Category;
  title: string;
  agreementSummary: string;
  expectedDeliverable: string;
  claim: string;
  requestedRemedy: string;
  issues: string[];
  respondent: string;
  replyWindowHours: string;
}

export const EMPTY_DRAFT: CreateDraft = {
  category: "SOFTWARE",
  title: "",
  agreementSummary: "",
  expectedDeliverable: "",
  claim: "",
  requestedRemedy: "",
  issues: [""],
  respondent: "",
  replyWindowHours: "72",
};

const TEMPLATES: Record<Category, { label: string; title: string; agreement: string; deliverable: string; issue: string }> = {
  SOFTWARE: {
    label: "Software development",
    title: "e.g. Checkout feature not delivered as agreed",
    agreement: "What was agreed, as written: features, acceptance criteria, price, dates.",
    deliverable: "The software to be delivered, how it would be accepted, and any milestone date.",
    issue: "e.g. The payment step was not included in the delivered build",
  },
  DESIGN: {
    label: "Design / branding",
    title: "e.g. Logo package missing agreed formats",
    agreement: "What was agreed, as written: concepts, revision rounds, file formats, usage rights, dates.",
    deliverable: "The design files to be delivered, their formats, and any milestone date.",
    issue: "e.g. Only one of the three agreed concepts was delivered",
  },
  WRITING: {
    label: "Writing / content",
    title: "e.g. Article series delivered late and short",
    agreement: "What was agreed, as written: topics, word counts, style, revisions, dates.",
    deliverable: "The texts to be delivered, their length and format, and any milestone date.",
    issue: "e.g. Two of the five articles were below the agreed length",
  },
  OTHER: {
    label: "Other digital deliverable",
    title: "e.g. Video edit not delivered in the agreed format",
    agreement: "What was agreed, as written: scope, quality criteria, formats, price, dates.",
    deliverable: "What was to be delivered, how it would be accepted, and any milestone date.",
    issue: "e.g. The final file was delivered in the wrong resolution",
  },
};

const STEPS = ["Category and title", "Agreement and deliverable", "Claim, remedy and issues", "Other party and reply window"] as const;

/** Which validation messages belong to which step (by the field name the message starts with). */
const STEP_FIELDS: readonly (readonly string[])[] = [
  ["category", "title"],
  ["agreement_summary", "expected_deliverable"],
  ["claim", "requested_remedy", "issues", "issue", "duplicate issue"],
  ["respondent", "claimant and respondent", "reply_window_seconds"],
];

export function draftToInput(d: CreateDraft): CreateCaseInput {
  const hours = Number(d.replyWindowHours);
  return {
    respondent: d.respondent.trim(),
    category: d.category,
    title: d.title,
    agreementSummary: d.agreementSummary,
    expectedDeliverable: d.expectedDeliverable,
    claim: d.claim,
    requestedRemedy: d.requestedRemedy,
    issues: d.issues.filter((i) => i.trim() !== ""),
    replyWindowSeconds: Number.isFinite(hours) ? Math.round(hours * 3600) : Number.NaN,
  };
}

const READABLE: Record<string, string> = {
  agreement_summary: "agreement summary",
  expected_deliverable: "expected deliverable",
  requested_remedy: "requested remedy",
  reply_window_seconds: "reply window",
};

function readable(problem: string): string {
  let out = problem;
  for (const [k, v] of Object.entries(READABLE)) out = out.replace(k, v);
  return out.replace(/reply window must be between 3600 and 2592000/, "reply window must be between 1 and 720 hours");
}

export function stepProblems(d: CreateDraft, account: string | null, step: number): string[] {
  const fields = STEP_FIELDS[step] ?? [];
  return validateCreateCase(draftToInput(d), account)
    .filter((p) => fields.some((f) => p.startsWith(f)))
    .map(readable);
}

function firstFor(problems: readonly string[], prefix: string): string | null {
  return problems.find((p) => p.startsWith(prefix)) ?? null;
}

export function CreateCaseWizard({
  draft,
  setDraft,
  account,
  onReview,
}: {
  draft: CreateDraft;
  setDraft: (d: CreateDraft) => void;
  account: string | null;
  onReview: (input: CreateCaseInput) => void;
}) {
  const [step, setStep] = useState(0);
  const [shown, setShown] = useState<string[]>([]);
  const t = TEMPLATES[draft.category];
  const set = (patch: Partial<CreateDraft>) => setDraft({ ...draft, ...patch });

  const next = () => {
    const problems = stepProblems(draft, account, step);
    setShown(problems);
    if (problems.length > 0) return;
    if (step < STEPS.length - 1) setStep(step + 1);
    else onReview(draftToInput(draft));
  };

  const err = (prefix: string) => firstFor(shown, prefix);

  return (
    <section aria-labelledby="wizard-heading">
      <h2 id="wizard-heading">Start a case</h2>
      <ol className="steps" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li key={s} aria-current={i === step ? "step" : undefined}>
            {i + 1}. {s}
          </li>
        ))}
        <li>5. Review</li>
      </ol>
      <p className="hint">
        Step {step + 1} of 5: {STEPS[step]}. You are the claimant. The draft is kept only on this page until you leave it.
      </p>

      {shown.length > 0 ? (
        <div className="callout" role="alert">
          <p>
            <strong>Please fix:</strong>
          </p>
          <ul>
            {shown.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {step === 0 ? (
        <>
          <fieldset>
            <legend>Category</legend>
            {CATEGORIES.map((c) => (
              <label key={c} className="block">
                <input type="radio" name="category" value={c} checked={draft.category === c} onChange={() => set({ category: c })} /> {TEMPLATES[c].label}
              </label>
            ))}
            <span className="hint block">The category is stored with the case. The examples below are only suggestions.</span>
          </fieldset>
          <FormField label="Title" value={draft.title} onChange={(v) => set({ title: v })} max={L.MAX_TITLE_LEN} placeholder={t.title} hint={`${L.MIN_TITLE_LEN}–${L.MAX_TITLE_LEN} characters.`} error={err("title")} required />
        </>
      ) : null}

      {step === 1 ? (
        <>
          <FormField label="Agreement summary" multiline value={draft.agreementSummary} onChange={(v) => set({ agreementSummary: v })} max={L.MAX_AGREEMENT_LEN} hint={t.agreement} error={err("agreement summary")} required />
          <FormField
            label="Expected deliverable"
            multiline
            value={draft.expectedDeliverable}
            onChange={(v) => set({ expectedDeliverable: v })}
            max={L.MAX_DELIVERABLE_LEN}
            hint={`${t.deliverable} The contract has no separate milestone field: include any date here.`}
            error={err("expected deliverable")}
            required
          />
        </>
      ) : null}

      {step === 2 ? (
        <>
          <FormField label="Claim" multiline value={draft.claim} onChange={(v) => set({ claim: v })} max={L.MAX_CLAIM_LEN} hint="What went wrong, in your own words. It is recorded as your account, not as a fact." error={err("claim")} required />
          <FormField
            label="Requested remedy"
            multiline
            value={draft.requestedRemedy}
            onChange={(v) => set({ requestedRemedy: v })}
            max={L.MAX_REMEDY_LEN}
            hint="What you are asking for. Advisory only: VeriCourt does not pay, refund, hold or enforce anything."
            error={err("requested remedy")}
            required
          />
          <fieldset>
            <legend>Disputed issues (1 to {L.MAX_ISSUES})</legend>
            <span className="hint block">Each issue is assessed separately. The contract numbers them I1, I2… in this order.</span>
            {draft.issues.map((issue, i) => (
              <div key={i}>
                <FormField
                  label={`Issue I${i + 1}`}
                  value={issue}
                  onChange={(v) => set({ issues: draft.issues.map((x, j) => (j === i ? v : x)) })}
                  max={L.MAX_ISSUE_LEN}
                  placeholder={i === 0 ? t.issue : undefined}
                  wide
                />
                {draft.issues.length > 1 ? (
                  <button className="button button--small button--secondary" type="button" onClick={() => set({ issues: draft.issues.filter((_, j) => j !== i) })}>
                    Remove issue I{i + 1}
                  </button>
                ) : null}
              </div>
            ))}
            {draft.issues.length < L.MAX_ISSUES ? (
              <div className="actions">
                <button className="button button--secondary" type="button" onClick={() => set({ issues: [...draft.issues, ""] })}>
                  Add an issue
                </button>
              </div>
            ) : null}
            {err("issue") ?? err("duplicate issue") ? <p className="field-error">{err("issue") ?? err("duplicate issue")}</p> : null}
          </fieldset>
        </>
      ) : null}

      {step === 3 ? (
        <>
          <FormField
            label="Respondent's wallet address"
            value={draft.respondent}
            onChange={(v) => set({ respondent: v })}
            placeholder="0x…"
            hint="The other party's StudioNet address. Only this address can reply."
            error={err("respondent") ?? err("claimant and respondent")}
            monospace
            required
            wide
          />
          <FormField
            label="Reply window (hours)"
            value={draft.replyWindowHours}
            onChange={(v) => set({ replyWindowHours: v })}
            inputMode="numeric"
            hint="Between 1 and 720 hours (30 days), counted from when the transaction runs. Evidence from both parties is accepted until the deadline."
            error={err("reply window")}
            required
          />
        </>
      ) : null}

      <div className="actions">
        {step > 0 ? (
          <button className="button button--secondary" type="button" onClick={() => (setShown([]), setStep(step - 1))}>
            Back
          </button>
        ) : null}
        <button className="button" type="button" onClick={next}>
          {step < STEPS.length - 1 ? "Next" : "Review the transaction"}
        </button>
      </div>
    </section>
  );
}
