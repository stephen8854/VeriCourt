# VeriCourt assessment — implementation notes

Status: Phase 2.12 (assessment schema `vericourt-assessment-v2`, methodology
`vericourt-method-v2`; Phase 2.12 hardening of remedy handling, validator
sample validation and the silence rules - see §2-§4 and §6). Applies to `contracts/vericourt.py` (GenVM v0.2.16,
runner `py-genlayer:1jb45aa8…`). These notes are binding guidance for the
Phase 3 frontend. They complement, and do not replace, the two product
specifications. Design rationale: `docs/ASSESSMENT_AGREEMENT_DESIGN.md`.

## 1. What the network actually agreed on (provenance)

Every assessment returned by `get_assessment` carries a `provenance` object
(also exposed in `get_contract_info().assessment.provenance`). The frontend
**must** render each field according to its provenance class:

| Class | Fields | What it means | How to present it |
|---|---|---|---|
| `consensus_compared` | `outcome`, `issue_findings[].determination` | Each validator independently re-ran the assessment and accepted the leader's value only if its own matched under §2: outcome exactly; and for every issue, both UNRESOLVED, or both SUPPORTED/PARTIALLY_SUPPORTED sharing at least one supporting evidence id, or both NOT_SUPPORTED sharing at least one counter evidence id. An exact label match without the shared id is a disagreement. The stored value is the leader's. | The decision. May be labelled as accepted through validator agreement — never as "true", "proven" or "legally binding". |
| `partially_checked` | `supporting_evidence_ids`, `counter_evidence_ids` | Every id exists in the locked record. For agreeing definite findings, each validator shared at least one id in the list for the same direction. The full list is the leader's. A shared id does not show that the item is relevant. | Show as "evidence cited for this finding". Do not imply every listed item was confirmed relevant by validators. |
| `leader_generated_constrained` | `remedy_assessment` | **Advisory.** Written by the leader's model, **not compared across validators** and not read from validators' own samples. If it contradicts the derived outcome the contract replaces it with `CANNOT_ASSESS` (§3), so `CANNOT_ASSESS` can mean either the model's view or a replaced value. | Show as an advisory note on the requested remedy, outside the decision block, labelled as AI-generated and not validator-verified. |
| `leader_generated_unverified` | `summary`, `finding`, `reasoning`, `confidence`, `open_questions`, `limitations` | Written by the leader's model. Format- and length-checked only. **Not** checked for accuracy, completeness, neutrality, or consistency with the decision. | Visually separate from the decision, under a heading such as "Explanation (AI-generated, not independently verified)", and show `provenance.display_notice` next to it. `confidence` is the model's self-report, not a probability. |
| `contract_generated` | `notices`, `standard_notices`, `response_state`, `snapshot_digest` | Written deterministically by the contract. | Show verbatim. |

Rules for the UI:

1. Never place leader-generated prose or the remedy view under a heading or
   badge that implies consensus verification (e.g. "Validated reasoning",
   "Verified remedy").
2. Never present citation overlap as proof that an explanation is truthful or
   unbiased, or that an item is relevant.
3. Always show `notices` and `standard_notices` with any outcome.
4. A no-response case must show the contract's procedural notice; never
   describe silence as an admission.
5. Always show the per-issue determinations next to the overall outcome:
   `CLAIM_PARTIALLY_SUPPORTED` covers a wide range of situations.
6. Nothing in VeriCourt executes a remedy. **Before any future feature lets
   the remedy affect money, legal rights or other consequential actions, the
   remedy must be made a consensus-compared field again and this section
   revisited.**

## 2. Validator equivalence (exact rules)

Implemented in `_validate_leader`, `_assessments_equivalent` and
`_findings_agree`. A validator agrees with the leader only if **all** hold:

1. The leader payload re-normalises to itself under **full** validation
   (schema, types, lengths, every issue/evidence id exists in the locked
   record, citation rules, derived outcome, remedy replaced if inconsistent).
   The leader's output is what gets stored.
2. The validator's own independent model call passes **decision-only**
   validation: issue coverage, determinations, citation lists (ids exist, no
   id in both lists, SUPPORTED/PARTIALLY_SUPPORTED need a supporting id,
   NOT_SUPPORTED needs a counter id), the derived outcome, and any echoed
   `case_id`, `schema_version` or `outcome`. Explanatory fields and the
   remedy in a validator's own sample are never compared or stored, so they
   are not read; a problem in them does not cause a disagreement.
3. `outcome` is identical.
4. Every issue agrees under this table (symmetric; "shared" means at least one
   id in common in the named list):

| Leader \ Validator | SUPPORTED | PARTIALLY_SUPPORTED | NOT_SUPPORTED | UNRESOLVED |
|---|---|---|---|---|
| SUPPORTED | shared supporting id | shared supporting id | disagree | disagree |
| PARTIALLY_SUPPORTED | shared supporting id | shared supporting id | disagree | disagree |
| NOT_SUPPORTED | disagree | disagree | shared counter id | disagree |
| UNRESOLVED | disagree | disagree | disagree | agree |

Not compared: `remedy_assessment` (advisory), summary, finding, reasoning,
confidence, open questions, limitations, and cited ids beyond the required
overlap. Direction (favourable / against / undecided) and definiteness are
material: NOT_SUPPORTED vs UNRESOLVED and PARTIALLY_SUPPORTED vs either of
them always disagree.

These rules decide each validator's vote. GenLayer's Optimistic Democracy
(leader rotation, appeals, finality) is unchanged and remains the only source
of protocol finality. Prompting cannot remove model or sampling variation;
real agreement rates under these rules are not yet measured.

## 3. Overall outcome and remedy consistency

`_derive_outcome` (first match wins; no thresholds):

1. no issues → `INCONCLUSIVE` (unreachable: cases have 1–5 issues)
2. every issue SUPPORTED → `CLAIM_SUPPORTED`
3. every issue NOT_SUPPORTED → `CLAIM_NOT_SUPPORTED`
4. any SUPPORTED or PARTIALLY_SUPPORTED → `CLAIM_PARTIALLY_SUPPORTED`
5. otherwise (only NOT_SUPPORTED and UNRESOLVED) → `INCONCLUSIVE`

UNRESOLVED never counts towards `CLAIM_NOT_SUPPORTED`. The model cannot choose
the outcome: a model-supplied outcome that differs from the derived one is
rejected.

Remedy consistency (deterministic, `_consistent_remedy`): `INCONCLUSIVE` allows
only `CANNOT_ASSESS`; `CLAIM_NOT_SUPPORTED` allows `NOT_SUPPORTED` or
`CANNOT_ASSESS`; the other outcomes allow any remedy view. Since Phase 2.12 an
inconsistent remedy is **replaced by `CANNOT_ASSESS`**, never rejected, so the
advisory remedy cannot cause a disagreement, consume an attempt or lead to
`ASSESSMENT_FAILED`. An unknown remedy value or a missing remedy field in the
leader's output is still a schema error.

## 4. Attempts and failure semantics

| Event | On-chain effect |
|---|---|
| Valid assessment, validators agree | `DECIDED`; assessment stored; `assessment_attempts` +1 |
| Invalid leader output, and validators' own samples also have invalid **decision** fields | `assessment_attempts` +1, `last_assessment_error = INVALID_MODEL_OUTPUT`; at 2 → `ASSESSMENT_FAILED` (terminal) |
| Invalid leader output, validators' samples have valid decision fields (e.g. the leader failed only on prose length) | validator disagrees → leader rotation; if never resolved → UNDETERMINED → **no state change**, attempt not consumed |
| Remedy contradicts the derived outcome (leader or validator) | not an error: replaced by `CANNOT_ASSESS` (leader) or not read (validator sample) |
| Validators disagree with a valid leader result | leader rotation; if never resolved → UNDETERMINED (`MAJORITY_DISAGREE`) → **no state change**; attempt not consumed |
| Model/provider call fails (leader or validator) | validators disagree → **no state change**; attempt not consumed |
| Any revert (`[EXPECTED]` business rule) | **no state change** |

Consequences for the UI:

- `assessment_attempts` counts only attempts that reached agreement. Users
  may have submitted more transactions than this number.
- Repeated disagreement must be described as "Validators could not agree on
  these findings. Nothing was recorded and no assessment attempt was used.
  This usually means the record is ambiguous." — never as "validation failed".
- Requests that never reach consensus can be repeated by the parties; there
  is no on-chain cap on them (the runtime cannot record a failed-consensus
  transaction). Disable the request button while a request is pending.
- `ASSESSMENT_PENDING` is never stored. "Assessment in progress" must come
  from the transaction status, not the case status.

Direct-mode caveat: direct tests run only the leader path, so a leader that
fails only on an explanatory field appears there as `ATTEMPT_FAILED`. On the
network, validators with valid decision fields disagree instead (tested via
`run_validator` in `tests/direct/test_hardening.py`) and no attempt is used.

## 5. Finality

`status == DECIDED` is set when the assessment transaction is accepted. An
accepted transaction can still be appealed until it is finalized. The
frontend must distinguish:

- transaction submitted / pending consensus (transaction status),
- decided but not final: `DECIDED` at `latest-nonfinal`, not at `latest-final`,
- final: `DECIDED` when read with `transactionHashVariant: latest-final`.

`latest-nonfinal` and `latest-final` reads were verified on StudioNet in
Phase 2.7/2.8 (with genlayer-py; genlayer-js uses the same RPC variants).

## 6. Fairness limitation (approved MVP behaviour)

The respondent's reply locks the record. The claimant cannot add evidence or
respond to the reply. The assessment sees both parties' evidence and the
reply, but the claimant has no rebuttal round. The UI should say so before
case creation.

Silence (Phase 2.12): the prompt states that a missing reply is not
acceptance, admission, corroboration or evidence; that silence must not
support a finding for either party; that a party's own uncorroborated
assertion never becomes established because the other side did not respond;
and that insufficient evidence means UNRESOLVED. These are **prompt rules
only**. The contract can enforce that a definite finding cites at least one
evidence id, but it cannot tell a party's own statement from a document: a
model that ignores the rubric and cites a claimant's own statement as support
is still accepted (`test_silent_case_disobeying_model_is_not_blocked_by_contract`).
Only validator disagreement can catch that on the network. The contract-written
no-response notice is always attached.

## 7. Verification status in real GenVM

Verified on StudioNet (Phase 2.8, v1 contract): closure serialisation through
`run_nondet_unsafe`; real model calls; four real model outputs passing full
validation; deterministic code running after the non-deterministic block;
`latest-final` reads.

Not yet verified: any v2 or Phase 2.12 rule on the network (remedy
replacement, decision-only validator samples, the silence rubric); validator
agreement rates under §2; whether models follow the silence rules; a stored
assessment and its provenance on-chain; the agreed-invalid-output path
(`ATTEMPT_FAILED`); finality of a successful assessment; prompt-size limits.
Direct tests do not prove consensus.
