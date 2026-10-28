# Phase 2.16: post-integration results audit (read-only)

**Scope:** an offline audit of what Phases 2.14 and 2.15 establish. I inspected only local reports, logs, source and tests. A local script (in the session scratchpad, outside the repo) parsed the JSON logs to cross-check numbers. Nothing was executed against the network, and no repository file other than this report was created or changed.

## 1. Executive summary

**The two run reports are accurate in substance.** Every transaction ID, consensus result, vote list, return value, request count, stored determination, remedy, snapshot digest and nonfinal-vs-final comparison in them matches the per-step logs.

**Corrections needed**, all minor; none changes a conclusion:
- **(I-1) Finality timing:** "finalised N s after acceptance" overstates what was measured.
- **(I-2) Finality evidence:** the Phase 2.15 "independently FINALIZED" claim rests on an artifact whose generating script is not in the repository, and which stores classified fields, not the raw transactions.
- **(I-3) Validator answers:** claims about what validators *concluded* are inferences from contract code, not observations. The logs record votes, not validators' own outputs.

**What is now established on StudioNet** (each from a single run):
- the v2 contract deploys and runs end to end;
- a clear-cut record yields an agreed, stored, finalised `CLAIM_SUPPORTED`;
- an ambiguous record yields an agreed, stored, finalised `INCONCLUSIVE`, with both issues UNRESOLVED;
- all 12 writes across both runs were sent exactly once;
- latest-nonfinal and latest-final reads matched in full.

**Not established on StudioNet for v2:**
- validator disagreement;
- no-reply cases;
- remedy replacement;
- agreed invalid output and attempt consumption;
- a retry after UNDETERMINED;
- partial-support outcomes.

Disagreement leaving state unchanged *was* observed on StudioNet, but in Phase 2.8 on the **v1** contract.

**Recommended next test:** a **no-reply** scenario (§5). It probes the main remaining fairness risk: H2, silence treated as admission, is enforced by the prompt only. It can be set up deterministically without changing the contract. It does require a new fixture and a small, reviewable harness change, both needing approval.

## 2. Verification of the integration reports

**Sources:**
- `integration-logs/studionet-smoke-2026-10-16T05-39-17.680948+00-00.json` (2.14 log);
- `integration-logs/studionet-smoke-2026-10-16T08-56-13.587740+00-00.json` (2.15 log);
- `integration-logs/studionet-phase-2-15-finality-readback.json` (2.15 readback);
- `integration-logs/studionet-phase-2-1{4,5}-pytest-output.txt`;
- `integration-logs/studionet-rerun-readonly-verification.json` (Phase 2.8).

| Claim | Report | Artifact check | Status |
|---|---|---|---|
| 6 planned writes, 6 attempted, in order, none halted, no problems or warnings | 2.14 §2, 2.15 §2 | `summary` step: `writes_attempted == writes_planned` (6), `halted: null`, `problems: []` in both logs | Confirmed |
| Exactly one `eth_sendRawTransaction` per write | 2.14 §2, 2.15 §2 | `rpc_request_counts.eth_sendRawTransaction = 6` in both | Confirmed |
| 64 / 70 RPC requests, all ok | 2.14 §2, 2.15 §2 | Counts total 64 and 70; `rpc_failures: []` | Confirmed |
| Fresh accounts | 2.14 §1, 2.15 §1 | `preflight.account_nonces` all 0 | Confirmed |
| Each write ACCEPTED + MAJORITY_AGREE + leader SUCCESS/`return` | 2.14 §2, 2.15 §2 | `last_view` of every write step | Confirmed |
| Vote lists (e.g. 2.14 create_case 3 AGREE / 2 IDLE; 2.15 deploy 3 AGREE / 2 IDLE) | both §2 | `last_view.votes` | Confirmed. Last round only |
| Return values `VC-000001`, `E1`, `E2`, outcome strings | both §2 | `last_view.leader_result_payload` | Confirmed |
| Assessment FINALIZED_SUCCESS | 2.14 §2, 2.15 §2 | `*.request_assessment.finality` step: FINALIZED / MAJORITY_AGREE | Confirmed |
| "finalised 21.1 s after acceptance" (2.14); "+22.5 s" (2.15) | 2.14 §2, 2.15 §2 | 21.1 / 22.5 s is the duration of the *finality poll*. That poll starts only after the five latest-nonfinal reads, so the real time from acceptance was longer and was not measured | **Imprecise (I-1)** |
| Stored assessment: 2.14 I1 SUPPORTED [E1,E2], remedy SUPPORTED; 2.15 I1/I2 UNRESOLVED, no IDs, remedy CANNOT_ASSESS | 2.14 §3, 2.15 §4 | `reads_latest_final.reads.get_assessment` | Confirmed |
| Digest case == assessment; nonfinal reads == final reads | 2.14 §2, 2.15 §3 | All five reads identical across variants in both logs; digests equal | Confirmed |
| 2.15 digest equals Phase 2.8 digest | 2.15 §1 | `7e8533fb…137a` in both the 2.15 log and the Phase 2.8 `digest_check.on_chain`. Consistent with `_snapshot_record` (`contracts/vericourt.py:883-911`), which covers content and roles but not addresses or timestamps | Confirmed |
| Fixture identical to the Phase 2.8 record | 2.15 §1 | Field comparison was done by a scratch script (not in the repo). The identical digest independently corroborates it | Confirmed (digest) |
| All six 2.15 transactions FINALIZED in round 1 | 2.15 §2 | `finality-readback.json`: six entries, FINALIZED/MAJORITY_AGREE, `num_of_rounds "1"`; transaction IDs equal the run log's. The generating script is not in the repo, and the file holds classified fields, not raw transactions | **Supported, with a provenance gap (I-2)** |
| 2.14 earlier writes final | 2.14 §4 | Only indirect: their effects appear in `latest-final` reads. No per-transaction status was ever read. Rounds not recorded | Correctly labelled "assumed" in 2.14 |
| "validators reached agreement on an all-UNRESOLVED result"; "E2 was not treated as establishing the scope change" | 2.15 §4, §7 | The logs show the leader's stored output and validators' AGREE votes only. That validators' own samples were U/U follows from `_findings_agree` (an AGREE vote is impossible otherwise), not from observed validator outputs | **Inference from code (I-3)** |
| Phase 2.8: UNDETERMINED / MAJORITY_DISAGREE after 4 rounds, state unchanged | 2.15 §5 | `studionet-rerun-readonly-verification.json`: 4 rounds, MAJORITY_DISAGREE; final `assessment_status` attempts 0, READY_FOR_ASSESSMENT, `has_assessment: false` (schema v1) | Confirmed (v1 contract) |
| No key material in logs | 2.14 §6, 2.15 §8 | The only 64-hex strings in each log are its snapshot digest | Confirmed |
| Phase 2.13 local results (419 tests, 17/17 mutations) | 2.13 §6 | Not re-run in this phase. The test files exist as cited | Not re-checked |

### Inconsistencies and unsupported claims

1. **I-1, timing wording** (2.14 §2, 2.15 §2). "Finalised N s after acceptance" should read "observed FINALIZED within N s of starting the finality poll". The time from acceptance to finality is unknown.
2. **I-2, finality evidence provenance** (2.15 §2). The independent finality check was a one-off read-only script kept in the session scratchpad, not in the repository. Its output stores the harness's classification (status, result, rounds, votes), not raw transactions. The claim is supported by the artifact, but the artifact can't be regenerated from the repo, and the raw transactions weren't kept.
3. **I-3, validator conclusions are inferred** (2.15 §4, §7; 2.14 §3). Neither log stores validator receipts, validator models or leader identity. Statements about what validators concluded rely on the contract's agreement rule (`_findings_agree`, `_assessments_equivalent`) plus the AGREE votes.
4. **IDLE votes are unexplained.** In 2.14 (create_case, reply, assessment) and 2.15 (deploy, reply, assessment), only 3 of 5 validators voted. Both reports correctly label "did not vote" as an assumption. The artifacts don't show whether 3 AGREE out of 5 selected is the normal quorum.
5. **2.14 rounds not recorded.** The 2.14 log has no round count, so leader rotation in 2.14 can't be excluded from the artifacts. The 2.14 report doesn't claim it, so this isn't an error, just a gap.
6. **Remedy provenance in 2.15.** The stored `CANNOT_ASSESS` can't be attributed. The model may have produced it, or `_consistent_remedy` may have replaced another value. The logs don't contain the raw leader output. The 2.15 report doesn't claim replacement; it is listed here so no one infers it.

## 3. Evidence matrix

Classes: **SN** = verified on StudioNet; **Local** = verified only in direct or offline tests; **Not tested**; **Unclear**.

| # | Behaviour | Class | Evidence |
|---|---|---|---|
| 1 | Clear-cut supported assessment | **SN (v2, n=1)** | 2.14 log steps `clear.request_assessment`, `clear.reads_latest_final`; `docs/PHASE_2_14_STUDIONET_RUN_REPORT.md` §2-3. Local: `tests/direct/test_integration_fixtures.py::test_clear_expected_output_stores_claim_supported` |
| 2 | Ambiguous all-unresolved assessment | **SN (v2, n=1)** | 2.15 log steps `ambiguous.request_assessment`, `ambiguous.reads_latest_final`; finality readback; `docs/PHASE_2_15_STUDIONET_AMBIGUOUS_REPORT.md` §2-4. Local: `test_integration_fixtures.py::test_ambiguous_rubric_output_is_inconclusive`. Validators' U/U is inferred (I-3) |
| 3 | Validator disagreement with no state change | **SN for v1 only; Local for v2** | v1: Phase 2.8 `studionet-rerun-readonly-verification.json` (MAJORITY_DISAGREE, 4 rounds; attempts 0, READY, no assessment at latest-final), `assessment-tx-raw.json`. v2 local: `test_equivalence.py` (`run_validator` → False cases), `test_hardening.py` validator tests, `test_integration_fixtures.py::test_ambiguous_phase_2_8_split_under_v2_rules`; harness `tests/harness/test_harness_offline.py::test_runner_full_plan_success_and_disagreement`, `::test_runner_disagreement_with_changed_state_is_a_problem`. "No state change" itself is a GenVM runtime property that direct mode can't exercise |
| 4 | No-reply assessment | **Local only** | `test_assessment.py::test_no_response_record_is_explicit`, `::test_no_response_without_evidence_is_inconclusive`, `::test_no_response_without_evidence_cannot_favour_claimant`, `::test_no_response_with_evidence_requires_citations`; `test_hardening.py::test_silent_case_*` (including `test_silent_case_disobeying_model_is_not_blocked_by_contract`, the H2 limitation); `test_lifecycle.py` deadline tests; contract `process_reply_deadline` (`vericourt.py:1131-1150`) |
| 5 | Remedy normalisation (`_consistent_remedy`) | **Local only** (on the network: Unclear) | `test_hardening.py` remedy table; `test_assessment_v2.py::test_inconsistent_remedy_for_inconclusive_is_replaced`, `::test_remedy_only_inconsistency_cannot_reach_assessment_failed`; `test_assessment_validation.py::test_inconsistent_remedy_is_replaced_not_rejected`. 2.15's stored `CANNOT_ASSESS` is consistent with the rule but can't be attributed (§2 item 6) |
| 6 | Agreed invalid-output failure and attempt consumption | **Local only** | `test_assessment.py::test_failed_attempt_is_recorded_and_retryable`, `::test_retry_after_failure_can_succeed`, `::test_attempt_limit_leads_to_terminal_failure`; `test_hardening.py::test_decision_invalid_output_is_still_agreed_as_failure`; harness handling of `ATTEMPT_FAILED`: `harness.py` `Runner._check_assessment_state`. Never observed on any network |
| 7 | Retry after `UNDETERMINED` | **Not tested** (precondition SN, v1) | No run has re-requested after UNDETERMINED. Phase 2.8 (v1) shows the precondition at latest-final: `can_request: true`, `remaining_attempts: 2`. Guard logic: `vericourt.py:1163-1170`. The harness deliberately never retries (`WriteGuard`) |
| 8 | Partial-support outcome | **Local only** | `test_outcome_mapping.py::test_any_favourable_issue_is_partial_unless_all_supported`; `test_equivalence.py::test_validator_rejects_partial_vs_*`; `test_integration_fixtures.py::test_clear_agreement_depends_on_supported_vs_partial`. Phase 2.8 (v1) leader proposals were partial but were never stored |
| 9 | Explanation and citation integrity | **Citations: SN (existence) + Local (rules). Prose: unverifiable by design** | SN: stored citations `[E1, E2]` (2.14) are IDs present in `get_case_evidence` at latest-final; 2.15 stored no citations (consistent with U). Local: citation rules in `test_assessment_validation.py`, `test_hardening.py` decision-mode tests; `test_assessment_v2.py::test_valid_but_irrelevant_citation_passes_validation`, `::test_semantically_inconsistent_prose_passes_validation` (documented limits). Relevance, interpretation and prose accuracy: `leader_generated_unverified` / `partially_checked` in provenance; not checkable by contract or harness |
| 10 | Per-transaction finality reporting | **2.15: SN** (ad-hoc artifact, I-2); **2.14: Unclear** (indirect only); **harness: Local** | 2.15 `finality-readback.json` (six FINALIZED, round 1). 2.14: only the assessment finality poll plus effects in latest-final reads. The harness polls only the assessment to finality (`harness.py` `Runner.run_fixture`); the final-mode logic is tested offline (`test_harness_offline.py::test_finality_poll_waits_past_accepted_and_undetermined`) |

## 4. Recommended next test: comparison

| Criterion | No-reply | Validator disagreement | Partial support |
|---|---|---|---|
| Risk addressed | **H2:** silence or self-assertion treated as proof. A fairness risk enforced **only by the prompt**; the contract can't block it (`test_silent_case_disobeying_model_is_not_blocked_by_contract`) | v2 "no state change, attempt not consumed" on the network | M3 breadth; whether validators agree on mixed S/P/U findings |
| Already known | Local only | v1 path verified on StudioNet (Phase 2.8); v2 locally | Mapping is deterministic and fully tested locally; network adds only an agreement-rate data point |
| Controllable without a contract change? | **Yes.** Deterministic setup: claimant-only uncorroborated TEXT evidence, no reply, deadline processed | **No.** Disagreement can't be induced honestly. Forcing it would mean adversarial records or changing the contract (both out of scope). Re-running `ambiguous` might or might not disagree, and n=1 says little | Yes, with a new fixture. But "partial" is not reliably reachable: S vs P splits lead to disagreement (`test_clear_agreement_depends_on_supported_vs_partial`) |
| Harness changes needed | **Yes, small:** skip `submit_reply`; wait past `reply_window_seconds` (minimum 3600 s, `vericourt.py:101`); send `process_reply_deadline`. A new fixture is also needed | None, but the outcome isn't controllable | New fixture only |
| Attempt consumption | One fresh case. An agreed result uses 1 of 2 attempts on a throwaway case; no shared state at risk | Disagreement uses none | Same as no-reply |
| Duration / writes | About 1 h+ wait; 5 writes (deploy, create_case, E1, process_reply_deadline, request_assessment). Fits inside the default `run_budget_s` 5400 s only if the wait is about 3600–3700 s; the budget may need raising (configuration, no code change) | 6 | 6 |
| Interpretable result? | **Yes.** Expected: I1 UNRESOLVED leading to `INCONCLUSIVE`, or a disagreement. `CLAIM_SUPPORTED` citing only the claimant's own statement would be a concrete, reportable H2 failure | Weak: "agreed" and "disagreed" are both acceptable | Moderate |

**Recommendation: the no-reply scenario.**
- It tests the behaviour with the highest remaining safety impact: an absent respondent losing on the strength of the claimant's word alone. Phase 2.11 rated this H2, and only the prompt guards against it.
- It can be set up deterministically without touching the contract.
- Its expected result is clear in advance.

It can't run on the current harness, which always submits a reply. It needs:
1. a new `no_reply` fixture (claimant TEXT assertion only, mirroring `silent_case` in `tests/direct/test_hardening.py`);
2. a harness path that, for that fixture, skips the reply, waits in a bounded way until the on-chain deadline has passed, and sends `process_reply_deadline` once;
3. direct-mode and offline tests for both, before any network use.

That is a local phase (fixture plus harness), followed by a separately approved 5-write StudioNet run. The disagreement scenario is not recommended as a *planned* test because it can't be produced honestly on demand. If a disagreement occurs in any later run, the harness already checks for unchanged state.

## 5. Explicit limitations of this audit

- **Artifacts only.** The audit relies on the saved logs. Anything they don't record can't be checked from files: raw transactions for 2.14/2.15, validator receipts and models, leader identity, timestamps between acceptance and finality, 2.14 round counts.
- **Self-reported tooling.** The harness classification and the finality readback were produced by code written in this project. This audit checked that the logs are internally consistent and agree with the reports. It could not check them against an external explorer without network calls.
- **Local tests not re-run.** Local test claims are cited by test name. The 419-test and mutation results from Phase 2.13 were not re-executed here.
- **Small samples.** Each StudioNet result is a single run, with no agreement rates. Behaviour may differ with other validator models, on other networks, or over time.

## 6. Confirmation

- No network or RPC calls, deployments or transactions.
- No changes to the contract, tests, configuration, fixtures or harness. The only new repository file is `docs/PHASE_2_16_RESULTS_AUDIT.md`.
- A read-only parsing script was written to the session scratchpad, outside the repository.
- No dependency installs and no commits.

Waiting for approval before any further phase.
