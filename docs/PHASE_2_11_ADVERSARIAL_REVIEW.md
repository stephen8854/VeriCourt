# VeriCourt v2 - Phase 2.11 Adversarial Review and Pre-Integration Audit

> **Status update (Phase 2.12, local only):** H1 and M2 addressed (inconsistent remedy
> replaced by `CANNOT_ASSESS`; validators validate their own sample on decision fields only);
> H2 addressed in the prompt (silence is not acceptance or evidence; own assertions never
> become established by non-response) - prompt-only, not enforceable by the contract;
> L1 provenance wording corrected. M1 (harness), M3, L2-L4 and M4's inherent limits remain.
> None of the Phase 2.12 changes has been exercised on StudioNet. The findings below are the
> original Phase 2.11 record and describe the code as it was then.

Scope: read-only review of the Phase 2.10 implementation. Repository files reviewed (md5 at
review time): `contracts/vericourt.py` (`9b5b98b7...`), `tests/direct/test_equivalence.py`,
`test_outcome_mapping.py`, `test_assessment_v2.py`, `test_assessment_validation.py`,
`test_assessment.py`, `tests/integration/test_studionet_smoke.py`, `docs/ASSESSMENT_NOTES.md`,
`docs/ASSESSMENT_AGREEMENT_DESIGN.md`. No repository file other than this report was created
or modified. No network calls were made.

Evidence sources:

- **Project suite** (unmodified): `pytest tests/direct/` in WSL -> 294 passed.
- **Independent adversarial script** (NOT part of the project suite):
  `scratchpad/adv/tests/direct/test_zz_adversarial.py`, run only inside a scratch copy of the
  repository in genlayer-test direct mode with mocked LLM output, no network. 19 checks, all
  executed; referenced below as `ADV-xx`. Each asserts the *observed* behaviour.
- Line numbers refer to `contracts/vericourt.py` at the md5 above.

All case examples are **fictional**.

---

## 1. Executive verdict

**READY WITH CONDITIONS.**

The core v2 logic is correct against its specification: the outcome mapping, the issue-level
agreement matrix and the multi-issue comparison match independent re-implementations
exhaustively, are symmetric, and are well defended by tests. Lifecycle and storage behaviour
is unchanged from the version whose failure semantics were observed on StudioNet.

Two HIGH findings should be resolved (each needs an implementation decision from you) before
a v2 integration run, because each would distort or invalidate what that run measures:

1. **H1** - the advisory remedy can still block validator agreement and can terminally fail a
   case (`ASSESSMENT_FAILED`), contradicting the documented "remedy excluded from equivalence".
2. **H2** - the v2 rubric lets a party's own uncorroborated statement establish a fact when the
   other side did not reply, i.e. silence can function as proof.

Plus one MEDIUM harness condition (**M1**): the integration harness still has no request
timeouts and only the ambiguous Phase 2.8 record, so a v2 run would likely hang or merely
re-observe disagreement without exercising a successful assessment.

---

## 2. Findings ranked by severity

| ID | Severity | Title |
|---|---|---|
| H1 | High | Advisory remedy still gates validator votes and can consume attempts / terminally fail a case |
| H2 | High | Rubric loophole: undisputed-by-silence self-assertions can establish facts |
| M1 | Medium | Integration harness: no request timeouts; only an ambiguous record |
| M2 | Medium | Validation of non-compared fields in each validator's own sample gates its vote |
| M3 | Medium | `CLAIM_PARTIALLY_SUPPORTED` spans "one issue partly supported" to "four of five contradicted" |
| M4 | Medium | Evidence semantics (relevance, self-assertion, issue scope) are model-dependent only |
| L1 | Low | Provenance and notes text overstate/understate what is compared |
| L2 | Low | SUPPORTED~PARTIALLY_SUPPORTED tolerance is negated by the exact outcome check in common cases |
| L3 | Low | Remedy `SUPPORTED` permitted while some issues are contradicted |
| L4 | Low | Shared citation ids do not show shared interpretation (polarity conflicts accepted) |

### H1 - Advisory remedy still gates validator votes and can terminally fail a case

**Mechanism.**
- Remedy is excluded from `_assessments_equivalent` (662-679). But each validator's *own*
  model output passes through full `_normalize_assessment` via `_run_assessment` (770, 753-759),
  including the remedy-consistency rules (619-622). A validator whose own remedy is
  inconsistent raises `[LLM_ERROR]` and votes DISAGREE (771-772) even if its findings match.
- On the leader-error path, a validator agrees whenever its own output also fails with
  *any* `[LLM_ERROR]` (779-786), including a remedy-only error. Agreement records a failed
  attempt (`request_assessment`, failure branch); two such attempts set `ASSESSMENT_FAILED`,
  which is terminal.
- The prompt asks the model to compute the v2 outcome itself to pick a legal remedy
  (735-736). For `[NOT_SUPPORTED, UNRESOLVED]` the natural advisory view ("the remedy is not
  supported") is `NOT_SUPPORTED`, which is now illegal because v2 derives `INCONCLUSIVE`.

**Evidence.**
- ADV-B2: for `(N, U)` the only accepted remedy is `CANNOT_ASSESS`.
- ADV-B3: identical findings, validator remedy `NOT_SUPPORTED` -> vote `False`.
- ADV-B4: leader remedy-only `[LLM_ERROR]` + validator same -> vote `True` (failure agreed).
- ADV-B5: two remedy-only errors through `request_assessment` -> `ATTEMPT_FAILED` twice,
  case `ASSESSMENT_FAILED`.
- Project test `test_assessment_v2.py::test_remedy_must_be_cannot_assess_when_derived_outcome_is_inconclusive`
  asserts the attempt-consuming rejection (it documents, rather than guards against, H1).

**Fictional counterexample.** A logo commission with issues "colours wrong" (contradicted by
the approved-swatch email -> N) and "late delivery" (only conflicting statements -> U). Every
model judges the requested full refund `NOT_SUPPORTED`. All outputs are rejected as invalid;
validators agree on the failure twice; the case ends `ASSESSMENT_FAILED` with no assessment,
solely because of an advisory field.

**Why it matters.** It contradicts `docs/ASSESSMENT_NOTES.md` section 2 ("Not compared:
`remedy_assessment` (advisory)") and the Phase 2.10 report; it can permanently deny both
parties an assessment; and on StudioNet it would be indistinguishable from genuine finding
disagreement, contaminating the integration measurement.

**Remediation (needs your decision; not implemented).** Options:
(a) deterministically coerce an inconsistent remedy to `CANNOT_ASSESS` in normalisation
(documented rule, applied identically by leader and validators, recorded in provenance);
(b) validate the remedy only for the leader payload, not for a validator's own sample, and
exclude remedy-only errors from the agreed-failure path; (c) keep as is and accept the risk.
Recommended: (a) - smallest change, removes the failure mode, keeps the remedy constrained.

### H2 - Rubric loophole: silence can make a self-assertion sufficient

**Mechanism.** Rubric step 4 (704-707) says an uncorroborated assertion "does not establish a
fact *when the other party's claim or reply disputes it*", and the UNRESOLVED definition
(715-717) repeats "that the other side disputes". When the respondent never replied, nothing
formally disputes the claimant's assertion, so the rubric itself permits treating it as
established. The contract enforces only that a definite finding cites at least one id
(591-594); it cannot tell a party's own statement from a document.

**Evidence.** ADV-E5: no reply, the claimant's only evidence is their own TEXT item "I never
received the files" -> `CLAIM_SUPPORTED` accepted and stored (the procedural notice is
present, but the outcome rests on silence plus self-assertion). ADV-E1/E2 show the same
mechanics are available to either party when a reply exists (symmetric, model-dependent).

**Fictional counterexample.** A copywriter is away during the reply window. The client files
"articles never delivered", attaching only their own note saying so. A model following the
rubric literally can return SUPPORTED; validators following the same rubric may agree.

**Why it matters.** Directly conflicts with the fairness rule that a missing reply is not proof
(also stated at 694-695, so the prompt is internally inconsistent).

**Remediation (prompt only; not implemented).** Reword step 4 and the UNRESOLVED definition so
a party's own uncorroborated assertion never establishes a disputed fact, and state that the
claim is disputed unless the other party expressly accepted it; a missing reply is not
acceptance. Add a direct test asserting the new wording. Effect on models is unverified until
measured.

### M1 - Integration harness not ready for a meaningful v2 run

- No request timeout: the Phase 2.8 run hung ~27 min on a stalled HTTPS read inside
  genlayer-py; `test_studionet_smoke.py` still has no timeout (grep: none).
- Only the deliberately ambiguous Phase 2.8 record (line 78). The Phase 2.10 replay already
  predicts the same material split on it; a run would most likely re-observe
  `MAJORITY_DISAGREE` and never exercise a stored v2 assessment, provenance on-chain, or
  finality of a successful assessment.
- Compatible with v2 otherwise (asserts `leader_generated_unverified` exists, 266; consensus
  status check, 255).

Remediation: add bounded reads (verify the genlayer-py mechanism first, or wrap calls with a
process-level timeout) and a clear-cut fictional record; both are harness changes requiring
approval.

### M2 - Non-compared fields still gate each validator's vote

Every field of a validator's own sample is validated (summary length, open-question count,
confidence enum, ...). ADV-D1: identical findings but a 1,201-character validator summary ->
vote `False`. This is defensible (a malformed sample is not evidence of agreement) but it means
"not compared" fields still affect liveness. Same mechanism as H1, lower stakes because it
only causes disagreement (no attempt is consumed unless the leader also fails).

### M3 - Breadth of `CLAIM_PARTIALLY_SUPPORTED` (product decision)

ADV-A2: `[S, N]`, `[P, N]`, `[S, N, N, N, N]`, `[P, N, N, N, N]`, `[P]`, `[S, U, U, U, U]`,
`[P, P]`, `[S, S, P]` all map to `CLAIM_PARTIALLY_SUPPORTED`. The mapping matches the approved
specification (ADV-A1, project `test_outcome_mapping.py`), and is defensible as "at least part
of the claim is established", but the same label covers a claim that is four-fifths
contradicted. Fairness implication: the label can read as favourable to the claimant when the
record mostly favours the respondent. Mitigation already required by the notes (always show
per-issue determinations). Options for a product decision: a distinct `MIXED` outcome when
both favourable and NOT_SUPPORTED issues exist, or keep the label and rely on the per-issue
display. No change recommended without your decision.

### M4 - Evidence semantics are model-dependent only

Not enforced by the contract (verified):
- Citations need not be tagged to the issue (ADV-E3; project
  `test_valid_but_irrelevant_citation_passes_validation`).
- Relevance is inferred from ids only; a shared id does not show relevance (provenance text says
  so).
- A party's own assertion can be the sole support (ADV-E1) or sole counter evidence (ADV-E2).
  Treatment is symmetric in the contract; consistency depends entirely on the model.
- Free-text explanation can contradict the structured findings (ADV-E4: findings `N, N`,
  reasoning "the claimant is clearly right", summary "full refund") - accepted; labelled
  `leader_generated_unverified`. Project `test_semantically_inconsistent_prose_passes_validation`.

Enforced (verified): every cited id exists (`_out_id_list` 492-507; project
`test_assessment_validation.py` unknown-id cases); definite findings need a citation in the right
list (591-594); no id in both lists (586-588); malformed ids rejected, whitespace/case
normalised (ADV-D2). These are inherent limits of an id-based mechanism and must stay visible in
the UI (the notes already require this).

### L1 - Provenance and notes text precision

- Contract provenance (210-211) and notes table section 1: determinations "must match exactly,
  or both be SUPPORTED/PARTIALLY_SUPPORTED with a shared supporting id". Inaccurate: an exact
  match also requires a shared id (S/S, P/P supporting; N/N counter). ADV-C1 confirms exact
  matches with disjoint citations disagree. The text understates the requirement.
- Notes section 2 "Not compared: `remedy_assessment`" omits H1.

### L2 - Degree tolerance negated by the outcome check

ADV-C4: `[S]` vs `[P]` and `[S, S]` vs `[S, P]` disagree because the derived outcomes differ,
although each issue pair is "agree" at issue level. S~P tolerance only helps when the outcome is
already `CLAIM_PARTIALLY_SUPPORTED` on both sides. Correct (safe direction) but it limits the
liveness benefit the table suggests. Document; no change recommended.

### L3 - Remedy `SUPPORTED` allowed with contradicted issues

ADV-B2: for `(S, N)` every remedy is accepted, including `SUPPORTED` (full remedy) although an
issue is contradicted. Advisory only and labelled, but could overstate. Product decision.

### L4 - Shared ids do not show shared interpretation

ADV-C2: one validator cites E2 as supporting, the other as counter; they agree because they also
share E1. Documented limitation (design doc 3.3). Not detectable without storing validator
samples.

---

## 3. Verified vs inferred

| Property | Status | Evidence |
|---|---|---|
| Outcome mapping equals the approved spec, n = 0..5 | **Verified (direct)** | ADV-A1 (1,365 combos, 0 mismatches); project `test_outcome_mapping.py` |
| UNRESOLVED never yields CLAIM_NOT_SUPPORTED | **Verified (direct)** | project `test_unresolved_never_counts_against_the_claimant` |
| Model cannot set the outcome | **Verified (direct)** | `_normalize_assessment` 612-614; project `test_model_cannot_choose_claim_not_supported_with_unresolved_issue` |
| Issue matrix equals the spec, symmetric, no wrong-list agreement | **Verified (direct)** | ADV-C1 (7,056 pairs, all citation configs over 3 ids); project `test_findings_agree_matches_table` |
| Multi-issue comparison equals the spec (n = 2) | **Verified (direct)** | ADV-C5 (1,024 cases) |
| One disagreeing issue blocks; remedy ignored by the comparison function | **Verified (direct)** | ADV-C3; project `test_validator_ignores_remedy_when_findings_identical` |
| Remedy cannot affect votes | **False** | H1 (ADV-B3, B4, B5) |
| Every finding combination admits a legal remedy | **Verified (direct)** | ADV-B1 (`CANNOT_ASSESS` always legal) |
| UNDETERMINED persists nothing, consumes no attempt | **Verified on StudioNet for v1** (Phase 2.8: attempts 0, `READY_FOR_ASSESSMENT` at both read levels); **inferred for v2** (state writes in `request_assessment` structurally unchanged) | `integration-logs/studionet-rerun-readonly-verification.json` |
| No partial state on failure | **Verified (direct)** for reverts (all writes follow the non-deterministic call); **runtime rollback** documented and observed in Phase 2.8 | project `test_model_call_failure_changes_nothing`, `test_record_is_immutable` |
| Valid assessment -> `DECIDED`, attempt counted | **Verified (direct)**; not yet observed on-chain | project `test_successful_assessment_is_stored` |
| Agreed invalid output -> attempt; 2 -> `ASSESSMENT_FAILED` | **Verified (direct)**; not observed on-chain | project `test_attempt_limit_leads_to_terminal_failure` |
| Validator agreement rates under v2 | **Unknown** | none |
| Closure serialisation, real model output passing validation | **Verified on StudioNet for v1** (Phase 2.8); **inferred for v2** (same mechanism) | Phase 2.8 logs |
| v1/v2 version handling | **Verified (direct)**: v1 echo rejected, stored versions v2, case schema v1 | project `test_model_echoing_v1_schema_version_is_rejected`, `test_version_identifiers` |
| Case storage and Phase 1 lifecycle intact | **Verified**: storage dataclasses identical to pre-2.10 (diff), Phase 1 test files unchanged and passing | Phase 2.10 diff; 294 passed |
| Repeated disagreement communicated honestly | **Documented only** (notes section 4); no frontend exists; the contract cannot signal it (no state is written) | `docs/ASSESSMENT_NOTES.md` |

Direct tests run only the leader path in-process and never exercise real validator consensus.

---

## 4. Prioritised remediation list (none implemented)

1. **H1** - decide remedy handling; recommended: deterministic coercion of an inconsistent
   remedy to `CANNOT_ASSESS` (leader and validators alike), provenance note, tests replacing the
   current attempt-consuming expectation.
2. **H2** - reword rubric step 4 and the UNRESOLVED definition (silence is not acceptance;
   own uncorroborated assertions never establish disputed facts); prompt-text test.
3. **L1** - correct the provenance determination text (contract string, user-facing) and the
   notes; this is a contract string change, so bundle it with 1-2.
4. **M1** - harness: bounded reads and a clear-cut fictional record (approval needed;
   no other plan changes).
5. **M3 / L3** - product decisions: `MIXED` outcome or label policy; whether a fully supported
   remedy may accompany contradicted issues.
6. **M2, M4, L2, L4** - keep as documented limitations; ensure the Phase 3 UI shows per-issue
   findings, provenance classes and the "explanation not verified" notice.

---

## 5. Recommendation for the next phase

Phase 2.12 (local, no network): implement items 1-3 with tests and update the notes, after
your decisions on H1 option and H2 wording. Then Phase 2.13: harness changes (item 4) and a
controlled StudioNet run on two fictional records (the Phase 2.8 ambiguous record and a
clear-cut one), each a separate approval. Running the current v2 on StudioNet now would mostly
measure H1 and the known ambiguity rather than the v2 agreement design.
