# Phase 2.17B: final StudioNet preflight review, no-reply run (read-only)

**Verdict: READY WITH CONDITIONS.**

No blocker was found that could cause a duplicate write, deadline processing before the deadline is guaranteed to have passed on-chain, or a misreported success. The conditions (§9) are:
- **(C1)** a larger run budget, recommended;
- **(C2)** keeping the host awake for the whole run;
- **(C3)** reading the safety field in the result, because a pytest PASS does not mean the outcome was fair;
- **(C4)** accepting that some slow-network conditions end the run early, safely and without retrying.

**Claim labels:**
- **[Code]**: verified from code.
- **[Test]**: verified by local test (direct mode with a mocked model, or offline with a fake chain and clock).
- **[Inference]**: reasoned, not tested.
- **[Network]**: not verifiable without network access.

**Nothing in this review proves anything about the real StudioNet clock, consensus, finality or model behaviour.**

## 1. Files and functions reviewed

| File | Functions / items |
|---|---|
| `tests/integration/harness.py` | `Timeouts` (fields, `from_env`, `validate`), `MIN_DEADLINE_MARGIN_S`, `SDK_SEND_RECEIPT_TIMEOUT_S`, `BoundedProvider.make_request`, `make_client`, `classify_transaction`, `poll_transaction`, `_is_terminal`, `WriteGuard.submit`, `RunBudget`, `chain_clock_offset`, `minimum_run_budget_s`, `Runner.{_stop,_check_budget,_poll,write,write_ok,read,read_case,deploy,run_fixture,_expire_reply_window,_check_assessment_state}`, `StepLog` |
| `tests/integration/case_fixtures.py` | `CaseFixture.write_names`, `NO_REPLY`, `CLEAR_CUT`, `AMBIGUOUS`, `FIXTURES`, `DEFAULT_ORDER`, `evaluate_expectation` |
| `tests/integration/test_studionet_smoke.py` | `selected_fixtures`, `planned_writes`, `test_studionet_assessment_smoke` (guards, budget preflight, try/finally summary, final assertions) |
| `contracts/vericourt.py` | `create_case` (`now = _now()`; `created_at = now`; `reply_deadline = now + reply_window_seconds`, lines 978–995), `_now` (363–365), `_role_of` (859–865), `submit_evidence` (refused if `now > reply_deadline`), `submit_reply` (respondent only; requires PENDING), `process_reply_deadline` (1131–1150), `request_assessment` guards (1153–1170), `MIN_REPLY_WINDOW_SECONDS` (101) |
| Tests | `tests/direct/test_no_reply_fixture.py` (all 14), `tests/direct/test_integration_fixtures.py` (no-reply branch), `tests/harness/test_harness_offline.py` §8 (20 tests) and §1–7 where relied on |
| Docs | `PHASE_2_17_NO_REPLY_LOCAL_REPORT.md`, `PHASE_2_13_HARNESS_REPORT.md`, `PHASE_2_16_RESULTS_AUDIT.md` |

**Configuration from code [Code]:**

| Setting | Default |
|---|---|
| `http_connect_timeout_s` | 10 |
| `http_read_timeout_s` | 60 |
| `min_request_spacing_s` | 1.1 |
| `write_decision_timeout_s` | 300 |
| `assessment_decision_timeout_s` | 900 |
| `finality_timeout_s` | 900 |
| `poll_interval_s` | 6 |
| `max_consecutive_read_failures` | 3 |
| `run_budget_s` | 5400 |
| `deadline_margin_s` | 120 (floor 30) |
| `max_clock_skew_s` | 300 |

**Environment variables [Code]:**
- `VERICOURT_RUN_STUDIONET=1` (approval guard);
- `VERICOURT_FIXTURES`;
- `VERICOURT_<FIELD>` overrides, e.g. `VERICOURT_RUN_BUDGET_S`.

**Fixed by the SDK [Code]:** a 120 s web3 receipt wait inside each submission.

## 2. Transaction sequence

**[Code]** `planned_writes(["no_reply"])` evaluates to:
1. `deploy`
2. `no_reply.create_case` (claimant)
3. `no_reply.submit_evidence_E1` (claimant)
4. `no_reply.submit_evidence_E2` (claimant)
5. `no_reply.process_reply_deadline` (claimant)
6. `no_reply.request_assessment` (claimant)

**6 writes.** `WriteGuard` refuses any write that is out of order, repeated, or not in this list.

**[Code] The reply path is skipped only for `no_reply`.** `run_fixture` takes the `fx.reply is None` branch, which never calls `submit_reply`; only `NO_REPLY.reply is None`. `CLEAR_CUT` and `AMBIGUOUS` have non-empty replies and take the unchanged `else` branch. `DEFAULT_ORDER` is still `("clear", "ambiguous")`.

**[Test]**
- `test_no_reply_fixture_has_no_reply_and_plans_deadline_processing`
- `test_existing_fixtures_still_plan_a_reply`
- `test_no_reply_path_skips_reply_and_expires_the_deadline_once_after_it` (exact `sent` sequence)
- `test_reply_fixtures_still_reply_and_never_wait`
- `test_runner_full_plan_success_and_disagreement`
- `test_default_plan_and_fixture_selection`

## 3. Deadline safety

### 3.1 What the code guarantees

| Requirement | Finding | Label / support |
|---|---|---|
| On-chain `created_at` is the reference | `case = read(get_case)` right after creation; `_expire_reply_window` uses `case["created_at"]` and `case["reply_deadline"]` exactly as the chain returned them. Non-int, missing, or a deadline not after `created_at` → stop | [Code] |
| Window duration accounted for | The harness never computes the deadline itself: it uses the contract's `reply_deadline`, which the contract sets to `created_at + reply_window_seconds` from the same `now` (`vericourt.py:978-995`). The fixture's window is 3600 s, the contract minimum | [Code]; `test_no_reply_fixture_has_no_reply_and_plans_deadline_processing` [Test] |
| Clock-offset bounds | `chain_clock_offset(created_at, before, after)` gives `[created_at - after, created_at - before]`, where `before` / `after` are local wall times bracketing the `create_case` submit-and-decide. Both bounds must be within ±300 s, otherwise stop before deadline processing | [Code]; `test_chain_clock_offset_bounds`, `test_clock_offset_beyond_the_limit_stops_before_deadline_processing` [Test] |
| Wait can't schedule processing early (by the estimate) | The loop runs while `reply_deadline + margin - (local_now + low) > 0`, using the *lower* bound of the chain clock. Processing is reached only when the pessimistic estimate of chain time is at least `deadline + margin` (margin ≥ 30, default 120). There is no path around the loop | [Code]; `test_no_reply_path_...` (processed after deadline + margin; no calls during the wait), `test_deadline_is_respected_whatever_the_clock_offset[-250/0/+250]` [Test] |
| Fresh status read before processing | `get_case_status` must show `AWAITING_RESPONSE`, `PENDING`, unlocked; otherwise stop | [Code]; `test_case_no_longer_awaiting_response_stops_before_processing` [Test] |
| Processing submitted at most once | One `write_ok("no_reply.process_reply_deadline", ...)` call, plus the `WriteGuard` one-attempt rule | [Code]; `test_no_reply_path_...` (guard refuses a second attempt), `test_unexpected_early_rejection_is_an_execution_failure_and_is_not_retried`, `test_uncertain_deadline_processing_submission_stops_without_retry` [Test] |
| Resulting state verified before assessment | Requires READY_FOR_ASSESSMENT, locked, `NO_RESPONSE_BY_DEADLINE`, `REPLY_WINDOW_EXPIRED`, and `locked_at > reply_deadline` (on-chain proof that processing ran after the deadline). Before and after statuses are logged | [Code]; `test_accepted_deadline_processing_with_wrong_resulting_state_stops` [Test] |
| Window never shortened, timestamps never edited, check never bypassed | No code changes `reply_window_seconds`, no time is passed to the contract, and the contract's strict `now > reply_deadline` check runs on every call. Configuration can only make the margin longer (floor enforced by `validate`) | [Code]; `test_minimum_run_budget_and_margin_floor`, `test_deadline_processing_before_or_at_the_deadline_is_rejected[...]` [Test] |
| An early call can't silently succeed | If the chain still says "not passed", the contract reverts. The harness classifies that as `ACCEPTED_EXECUTION_FAILED` and stops without retrying | [Code]; `test_unexpected_early_rejection_...` [Test]; contract revert: `test_deadline_processing_before_or_at_the_deadline_is_rejected` [Test] |

### 3.2 What still depends on the chain and the host

- **[Inference] The timestamp assumption.** The bound assumes the on-chain timestamp of `create_case` lies inside the local submit-to-decided window, and that `process_reply_deadline`'s timestamp is no earlier than its local submission time (adjusted by the same offset).
  - The 2.14/2.15 history timestamps look like real wall time.
  - But the logs don't carry local wall-clock times, so the relationship hasn't been measured. **[Network]**
- **Failure mode if the assumption is wrong:** the contract rejects an early call, and the run stops with the case still unprocessed. This is **safe but wastes the hour**; nothing is retried.
- **[Inference] Local clock jumps** during the roughly 1-hour wait, for example the host sleeping or WSL clock drift, act after the offset was measured:
  - **a forward jump** can lead to an early call, which the contract rejects (safe stop);
  - **a backward jump** lengthens the wait and uses up budget.
- **[Inference] False clock-skew stops.** The ±300 s check also stops the run if `create_case` takes more than about 300 s from submission to observed decision, even with perfectly synced clocks. That is a safe stop, but a false positive.

## 4. Run-budget analysis (actual code values)

### 4.1 Where the budget is enforced [Code]

**Checked:**
- `Runner._check_budget` runs before every `write` (before submission), every `read`, every `_poll`, and every wait-loop iteration (at most 60 s apart).
- Each poll's timeout is `min(configured timeout, remaining budget)`.
- `_expire_reply_window` also checks up front that the remaining budget exceeds the planned wait plus `write_decision_timeout_s` (300).
- The smoke test refuses before any network activity if `run_budget_s < minimum_run_budget_s(plan)`: **6720 s** for `no_reply`.

**Not preempted:**
- an in-flight HTTP request;
- the SDK submission call: `write_contract` / `deploy_contract`, including web3's 120 s receipt wait;
- `make_client` and the preflight nonce reads: these use `budget.check` directly, not `Runner._check_budget` (§8, R8).

The budget is therefore **checked between operations, not enforced as a hard wall clock**. The overrun after expiry is at most one submission or one request.

**Note:** `minimum_run_budget_s` is a heuristic floor, not a worst case. It counts half of each write's decision timeout.

### 4.2 Typical timeline [Inference, from the 2.14/2.15 logs]

- **Observed latencies:** each write decided in 7.5–8.7 s of polling; assessments decided in 14.2 s and 56.7 s; finality was observed 21–23 s after the finality poll started; whole runs took 136 s and 214 s.

| Phase | Approximate time |
|---|---|
| Start → `create_case` stamped | ~35 s |
| Wait end: `created_at + 3600 + 120 + (after − created_at ≈ 10)` | t ≈ 3765 s |
| Status read, deadline processing, status read | ~25 s → 3790 s |
| Assessment: 15–130 s (130 s ≈ the v1 Phase 2.8 rotations case) | → 3805–3920 s |
| 5 nonfinal reads (~8 s), finality (~25 s), 5 final reads (~8 s) | → **≈ 3850–3960 s (64–66 min)** |

With a 7200 s budget, the headroom is **about 3,240 s**. The reported 65–85 minute estimate is reasonable; the typical case sits at its low end.

### 4.3 Worst case within the configured bounds [Code values; Inference about composition]

This is the case where every bounded operation uses its full bound and still succeeds.

**Units:**
- one request R = connect 10 + read 60 + spacing 1.1 = **71.1 s**;
- one submission S = 4 pre-send requests (4R = 284.4) + the SDK receipt wait (120 + R) = **475.5 s**;
- one decided write W = S + (300 + R) = **846.6 s**.

| Step | Running total (s) |
|---|---|
| `make_client` (R) + 2 nonce reads (2R) | 213.3 |
| deploy (W) | 1059.9 |
| `case_count_before` (R) → `create_case` starts | 1131.0 |
| Wait end ≤ create start + (after − created ≤ 300, else the skew stop fires) + 3600 + 120 + 300 | ≤ 5451.0 |
| (create poll, 2 reads and E1/E2 = 1835.4 s all fall inside the 3600 s window) | (inside) |
| status read (R) + process (W) + status read (R) | 6439.8 |
| assessment submission (S) | 6915.3 |
| assessment poll (900 + R) | 7886.4 |
| 5 nonfinal reads (5R) | 8241.9 |
| finality poll (900 + R) | 9213.0 |
| 5 final reads (5R) | **9568.5** |

**Conclusions:**
- **At 7200 s:** under these worst-case latencies, the assessment would be submitted at about 6915 s, and its poll capped at about 285 s. If the assessment needs longer, the run ends `TIMED_OUT_UNKNOWN` for the assessment: a safe, classified stop, but with no recorded outcome.
- **Minimum defensible budget** for "every configured bound can be used in full": **≈ 9,600 s**. **10,800 s** (3 h) gives margin.
- **Even that isn't an absolute bound.** The read timeout limits silence between bytes, not a request's total time (Phase 2.13 limitation).
- **Most likely failure at 7200 s:** a slow assessment or finality is truncated after the hour has already been spent, and the run reports `TIMED_OUT_UNKNOWN` or a finality warning. Nothing is resubmitted, and nothing is reported as success.

## 5. Failure handling, finality and duplicates

| Condition | Harness behaviour | Duplicate? | Wrong success? | Label / support |
|---|---|---|---|---|
| Write fails before submission (any pre-send request) | `NOT_SUBMITTED` → halt, stop | No | No | [Code] `WriteGuard.submit`; [Test] `test_failure_before_send_is_definitely_not_submitted_and_halts` |
| Node rejects the raw transaction | `SUBMISSION_REJECTED` → halt | No | No | [Test] `test_send_failure_categories` |
| Possibly accepted, response timed out | `SUBMISSION_UNCERTAIN` (send timed out) or `SUBMITTED_UNCONFIRMED` (hash returned, receipt unreadable) → halt; log says "not resubmitted; check nonce/explorer" | No | No | [Test] `test_sdk_write_with_send_timeout_is_uncertain_and_sent_once`, `test_sdk_write_accepted_by_node_but_receipt_unreadable_keeps_the_hash`, `test_uncertain_deadline_processing_submission_stops_without_retry` |
| Accepted but no validator agreement | Ordinary write (including deadline processing): `write_ok` stops on `VALIDATOR_DISAGREEMENT` / `UNDETERMINED`. Assessment: recorded, and the state must be unchanged | No | No | [Test] `test_runner_ordinary_write_disagreement_stops`, `test_no_reply_assessment_results_are_logged_distinctly[disagreement/undetermined]`, `test_runner_disagreement_with_changed_state_is_a_problem` |
| Decided or finalised with a non-success execution | `*_EXECUTION_FAILED` → stop (ordinary writes and assessment alike) | No | No | [Code] `classify_transaction`, `ASSESSMENT_RECORDABLE`; [Test] `test_classification_table`, `test_unexpected_early_rejection_...` |
| Read fails | `READ_TIMEOUT` / `READ_FAILURE` → stop | No | No | [Test] `test_runner_read_timeout_is_reported_as_read_timeout`, `test_consecutive_read_failures_end_in_read_failure` |
| Read returns an unexpected state | `check()` → stop (case identity, evidence ID, pre/post deadline state, assessment storage) | No | No | [Test] `test_case_no_longer_awaiting_response_...`, `test_accepted_deadline_processing_with_wrong_resulting_state_stops`, `test_runner_evidence_id_mismatch_stops` |
| Poll deadline passes | `TIMED_OUT_UNKNOWN` (last observation kept) → stop | No | No | [Test] `test_poll_deadline_is_finite_and_reports_unknown_status`, `test_runner_assessment_timeout_halts_and_blocks_all_later_writes`, `test_no_reply_assessment_results_are_logged_distinctly[timeout]` |
| Budget expires before an operation | Stop, "run budget exhausted before X"; halt | No | No | [Test] `test_run_budget_stops_before_starting_an_operation`, `test_run_budget_too_short_for_the_wait_stops_before_waiting` |
| Budget expires during a submission or confirmation | The submission isn't preempted. A poll is capped to the remaining budget, giving `TIMED_OUT_UNKNOWN`. If the budget runs out between submission and poll, the stop says "run budget exhausted before <name>"; the transaction ID is in the `<name>.submitted` log entry (R7) | No | No | [Code]; not separately tested |

**Duplicates [Code, Test].** No condition re-enables a write: names are recorded before sending, and any non-success halts the guard. Re-running the *command* after a failure would deploy a fresh contract with fresh accounts. That wouldn't duplicate a write on the same case, but it would be new network activity needing approval.

**Wrong success [Code, Test].** Success requires all of: ACCEPTED/FINALIZED, MAJORITY_AGREE, the leader receipt with `mode == "leader"` reporting SUCCESS, and result code `return` (`test_accepted_receipt_alone_is_not_success`, `test_leader_receipt_is_selected_by_mode`). On StudioNet, `submit_reply` (which also returns `None`) was classified this way in 2.14 and 2.15. `process_reply_deadline` is expected to behave the same [Inference].

**Finality [Code].** The harness polls only the assessment transaction to finality. Writes 1–5 are confirmed final only indirectly, through the `latest-final` reads. A per-transaction finality check would again be a separate read-only step (Phase 2.16 I-2).

## 6. Classification of safety-relevant outcomes

How each outcome is recorded: [Code] `run_fixture` result and `evaluate_expectation("no_reply", ...)`; [Test] `test_no_reply_assessment_results_are_logged_distinctly`, `test_no_reply_expectation_flags_a_silence_based_finding`, `test_contract_accepts_a_finding_resting_on_silence_and_own_assertion`.

| Outcome | `consensus_category` | `outcome` | `expectation` |
|---|---|---|---|
| INCONCLUSIVE, I1 UNRESOLVED | `ACCEPTED_SUCCESS` (`finality` FINALIZED_SUCCESS if observed) | `INCONCLUSIVE` | `met: true` |
| Validator disagreement | `VALIDATOR_DISAGREEMENT` | `None`; state verified unchanged | `met: true`, `observed: VALIDATOR_DISAGREEMENT` |
| Undetermined consensus | `UNDETERMINED` | `None`; state verified unchanged | `met: true`, `observed: UNDETERMINED` |
| Agreed invalid output | `ACCEPTED_SUCCESS`, `returned: "ATTEMPT_FAILED"` | `None`; attempts 1, `INVALID_MODEL_OUTPUT` checked | `met: false`, `observed: "... without a stored assessment"` |
| Execution failure | Not recorded as a result: run **stops**, problem lists `*_EXECUTION_FAILED` | — | — |
| Agreed CLAIM_SUPPORTED / CLAIM_PARTIALLY_SUPPORTED | `ACCEPTED_SUCCESS` | `CLAIM_SUPPORTED` / `CLAIM_PARTIALLY_SUPPORTED` | `met: false`, **`safety_finding: "H2: silence or the claimant's own statement decided the issue"`**, with the determinations and supporting IDs |

**Does the flag pick out claimant-only citations?** `evaluate_expectation` doesn't inspect who provided each cited item. In this fixture, **every** evidence item is claimant-provided (`test_no_reply_fixture_has_no_reply_and_plans_deadline_processing`) and there is no reply. So any S/P finding necessarily rests only on the claimant's material, and the flag is accurate for this fixture [Code + Inference]. The supporting IDs are logged, so the reviewer can see whether E1 (the claimant's statement) or E2 (the order terms) was cited.

**Gaps (reporting only; not fixed in this phase):**
- **R5:** an H2 safety finding does **not** fail the pytest run; it appears only in the `<key>.result` and `summary.results` log entries. A PASS means harness integrity, not a safe outcome.
- **R6:** for a stored no-reply assessment, the harness doesn't assert the no-response notice, `response_state`, or `CANNOT_ASSESS`. They are in the logged reads but must be checked by the reviewer.

## 7. Supporting local tests

**Phase 2.17 results** are as recorded in `PHASE_2_17_NO_REPLY_LOCAL_REPORT.md` §5. **I did not re-run them in this review.**
- 454 passed;
- 12/12 no-reply mutations caught; 17/17 Phase 2.13 mutations caught;
- lint, typecheck and schema passed; pyright 0 errors.

**Test files:**
- **`tests/direct/test_no_reply_fixture.py`** (14 tests): fixture shape; early or at-deadline rejection; valid expiry state; not repeatable; no late reply; prompt silence rules; INCONCLUSIVE with notice and remedy replacement; the dangerous case; U/U agreement.
- **`tests/harness/test_harness_offline.py` §8** (20 tests): sequence, clock offsets, skew stop, early rejection, stale state, wrong resulting state, budget, margin floor, offset bounds, uncertain submission, outcome categories, the safety flag.
- **Phase 2.13 tests in the same file:** timeouts, classification, polling, guard, runner.

## 8. Unresolved risks

| ID | Risk | Severity | Consequence | Label |
|---|---|---|---|---|
| R1 | Chain timestamp semantics differ from the assumption in §3.2 | Medium | Early processing rejected → safe stop; hour wasted | [Network] |
| R2 | 7200 s is below the worst-case ≈ 9,570 s | Medium | Assessment or finality truncated → `TIMED_OUT_UNKNOWN` / warning; no outcome recorded | [Code + Inference] |
| R3 | Host sleep, WSL suspend, or local clock jumps during the wait | Medium | Early call rejected (safe stop) or budget used up | [Inference] |
| R4 | ±300 s skew check also fires on a slow `create_case` (> 300 s) | Low | False safe stop before deadline processing | [Code] |
| R5 | H2 finding doesn't fail the run | Low (reporting) | A reviewer could misread a PASS | [Code] |
| R6 | No-response notice and remedy not asserted for no-reply | Low | Must be checked by hand from the logged reads | [Code] |
| R7 | Budget running out between submission and poll is reported as a budget stop, not `TIMED_OUT_UNKNOWN` | Low | Transaction status unknown; ID in the `.submitted` log entry | [Code] |
| R8 | Preflight budget checks use `budget.check` directly, so they're not listed in `problems` | Low | The test still fails on the plan assertion, with a less clear message | [Code] |
| R9 | Inter-byte read timeout; SDK 120 s receipt wait not budget-bounded (Phase 2.13) | Low | Overrun of at most one submission (~475 s) | [Code] |
| R10 | Log entries have no wall-clock timestamps | Info | Clock behaviour can only be reviewed afterwards through the logged offset bounds and on-chain times | [Code] |
| R11 | Per-transaction finality only for the assessment | Info | Earlier writes confirmed final only through later state | [Code] |
| R12 | Model and validator behaviour, consensus, finality, the real deadline wait | — | Not knowable before the run | [Network] |

## 9. Recommendation

**You can authorise the run, subject to these conditions.** None requires a code change.

- **C1 (recommended): set the budget to `VERICOURT_RUN_BUDGET_S=10800`** (≥ 9,600). That lets every configured wait run in full.
  - 7200 is acceptable if you accept R2: it covers latencies like those observed in 2.14/2.15 with about 54 min of headroom, but a slow assessment after the hour could be truncated.
  - Either way, the run duration is about 65–70 min if latencies are typical.
- **C2: keep the host awake** and on a stable network for the whole run (no sleep or hibernate; WSL left running). If the host sleeps, the harness either stops safely or the wait runs longer.
- **C3: judge the result from `summary.results.no_reply`** (`outcome`, `determinations`, `expectation.met`, `expectation.safety_finding`), not from the pytest PASS/FAIL line.
  - Check by hand that a stored assessment has `response_state` `NO_RESPONSE_BY_DEADLINE`, the no-response notice, and remedy `CANNOT_ASSESS` if INCONCLUSIVE.
- **C4: accept the safe-stop outcomes** listed in R1, R3 and R4. In every case nothing is resubmitted. Any further run would need separate approval.

**Approved settings, if you accept:**
- `VERICOURT_RUN_STUDIONET=1`;
- `VERICOURT_FIXTURES=no_reply`;
- `VERICOURT_RUN_BUDGET_S=10800` (or 7200 per C1);
- 6 writes in the order of §2;
- fictional data, throwaway accounts, StudioNet only.

## 10. Confirmation

- No network calls, deployments or transactions.
- No changes to source, tests, fixtures, configuration or existing documentation. The only new file is this report.
- No dependency changes, no commits.
- No keys generated or exposed.
- Local test results are cited from Phase 2.17, not re-run.
