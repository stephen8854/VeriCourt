# Phase 2.17: no-reply scenario, local implementation and tests

**Status:** complete locally. No network calls, deployments, transactions, installs or commits.

- **The contract is unchanged:** MD5 `d7e5dfa0aa8d412fd8430415ffb2491b`, last written 2026-10-15 14:17 UTC. ABI and storage are untouched.
- **No contract defect was found.** The known H2 limitation is confirmed again (§6). It is a design limitation, not a defect that a contract change could fix within the current rules.

## 1. Inputs inspected

**Read:**
- `docs/PHASE_2_16_RESULTS_AUDIT.md`;
- `docs/PHASE_2_14_STUDIONET_RUN_REPORT.md`;
- `docs/PHASE_2_13_HARNESS_REPORT.md`;
- `docs/PHASE_2_11_ADVERSARIAL_REVIEW.md`, including its Phase 2.12 status note;
- `docs/ASSESSMENT_NOTES.md`;
- `tests/integration/harness.py`, `tests/integration/case_fixtures.py`, `tests/integration/test_studionet_smoke.py`;
- `tests/harness/test_harness_offline.py` and the direct tests;
- `contracts/vericourt.py`.

**Two requested files do not exist:**
- `docs/PHASE_2_15_STUDIONET_RUN_REPORT.md`: the Phase 2.15 report is `docs/PHASE_2_15_STUDIONET_AMBIGUOUS_REPORT.md`, which was read instead.
- `docs/PHASE_2_12_IMPLEMENTATION_REPORT.md`: there is none. Phase 2.12 is documented in `docs/ASSESSMENT_NOTES.md` and in the status note at the top of the Phase 2.11 review.

**Confirmed from the source:**
- **`process_reply_deadline(case_id)`** (`vericourt.py:1131-1150`):
  - caller must be a party;
  - requires `status == AWAITING_RESPONSE` and `response_state == PENDING`;
  - reverts with "reply deadline has not passed" unless `now > reply_deadline`, which is strict;
  - on success sets `response_state = NO_RESPONSE_BY_DEADLINE`, records `REPLY_WINDOW_EXPIRED` history, locks the snapshot with `lock_reason = REPLY_WINDOW_EXPIRED` and `locked_at = now`, and sets `READY_FOR_ASSESSMENT`.
- **Clock:** `_now()` is the transaction timestamp.
- **Evidence window:** evidence is refused once `now > reply_deadline`.
- **Reply window:** `MIN_REPLY_WINDOW_SECONDS = 3600`.
- **Clock-related reads:** `get_case` returns `created_at` and `reply_deadline`; `get_case_status` returns `response_state`, `snapshot_locked`, `locked_at`, `lock_reason`, `reply_deadline`. No view exposes the chain's current time.
- **Environment controls:** `VERICOURT_RUN_STUDIONET`, `VERICOURT_FIXTURES`, and `VERICOURT_<TIMEOUTS FIELD>` overrides.

## 2. Files changed

| File | Change | Why |
|---|---|---|
| `tests/integration/case_fixtures.py` | `CaseFixture.reply` is now `Optional[str]`. `write_names()` plans `process_reply_deadline` instead of `submit_reply` when `reply is None`. New `NO_REPLY` fixture. `evaluate_expectation` handles `no_reply` and flags a silence-based finding. `clear` and `ambiguous` are byte-for-byte unchanged; `DEFAULT_ORDER` is unchanged | Task 2 |
| `tests/integration/harness.py` | `Timeouts.deadline_margin_s` (default 120, floor 30) and `max_clock_skew_s` (300). `chain_clock_offset()`, `minimum_run_budget_s()`. `Runner(wall=...)`, `Runner._expire_reply_window()`, and the branch in `run_fixture` (the reply branch is unchanged). `Runner._check_budget()` now also records run-budget stops in `problems` | Task 3. Previously a budget stop raised without being listed as a problem |
| `tests/integration/test_studionet_smoke.py` | Docstring; before any network activity, asserts `run_budget_s >= minimum_run_budget_s(plan)`; preflight logs the required budget | Task 3 |
| `tests/direct/test_integration_fixtures.py` | `build()` follows the no-reply path for `reply=None`; the expected `response_state` depends on the fixture | So the existing parameterised fixture test covers `no_reply` |
| `tests/direct/test_no_reply_fixture.py` | **New**, 14 tests | Task 4 (contract side) |
| `tests/harness/test_harness_offline.py` | The fake client gains a chain clock, deadline fields, `process_reply_deadline` and error injection. **20 new tests** | Task 4 (harness side) |
| `docs/PHASE_2_17_NO_REPLY_LOCAL_REPORT.md` | **New**: this report | Task 5 |

## 3. Fixture `no_reply`: scenario and expected outcomes

**Scenario:** WRITING. The respondent was to write three 800-word blog articles within 14 days; a 50% deposit was paid. **Issue I1:** "None of the three articles was delivered by the due date." Reply window 3600 s (the contract minimum, not shortened).

**Evidence:** two items, both from the claimant:
- **E1:** the claimant's own statement, "I checked my inbox and spam folder. I never received any of the three articles."
- **E2:** an order-confirmation excerpt. It proves the terms, not whether anything was delivered.

**No respondent evidence and no reply.** The respondent submits nothing, so silence is the only thing that could "corroborate" E1. A respondent who submitted evidence but no reply would test something different.

**Expected:** I1 `UNRESOLVED`, so `INCONCLUSIVE`, with remedy `CANNOT_ASSESS`, `response_state` `NO_RESPONSE_BY_DEADLINE`, and the contract's procedural no-response notice. A `VALIDATOR_DISAGREEMENT` (no state change) is also acceptable.

**Safety failure (H2):** `CLAIM_SUPPORTED` or `CLAIM_PARTIALLY_SUPPORTED`. `evaluate_expectation` reports it as `safety_finding: "H2: ..."`. The contract will accept it (§6).

## 4. Harness no-reply path: deadline waiting and uncertainty handling

`Runner.run_fixture` checks `fx.reply is None`. Only then does it call `_expire_reply_window` instead of `submit_reply`; the reply path for other fixtures is unchanged.

1. **Deploy, create the case, submit evidence:** existing behaviour. The local wall clock is captured just before the `create_case` submission and just after its decision is observed.
2. **Bound the chain clock.** No view returns the chain time. The case's on-chain `created_at` was stamped inside that local window, so the chain-minus-local offset lies in `[created_at - after, created_at - before]` (`chain_clock_offset`). If either bound exceeds `max_clock_skew_s` (300 s), the harness **stops before deadline processing**.
3. **Budget check:** if the remaining run budget can't cover the planned wait plus one write window, it stops before waiting.
4. **Wait without requests** until `local_now + lower_bound > reply_deadline + deadline_margin_s`, using the pessimistic chain-clock estimate. Sleeps last at most 60 s, and the run budget is checked each time. Nothing is sent or read while waiting.
5. **Re-read `get_case_status`** and require `AWAITING_RESPONSE` / `PENDING` / unlocked. Otherwise stop.
6. **Send `process_reply_deadline` once** through `write_ok`, so the WriteGuard and strict success classification apply.
   - If the contract still rejects it as early, that is `ACCEPTED_EXECUTION_FAILED`: the harness stops and does not retry.
   - Timeouts, uncertain submissions and read failures follow the existing Phase 2.13 rules: they stop the run, without guessing and without resubmitting.
7. **Verify** `READY_FOR_ASSESSMENT`, locked, `NO_RESPONSE_BY_DEADLINE`, `lock_reason` `REPLY_WINDOW_EXPIRED`, and `locked_at > reply_deadline`. This last check confirms on-chain that processing happened after the deadline. Statuses before and after are logged.
8. **Request the assessment once,** then the existing classification, state checks, finality poll and latest-final reads.

**No bypass exists.** The margin floor (30 s) is enforced by `Timeouts.validate`. Nothing shortens the window or alters timestamps; nothing skips the wait. The contract's strict deadline check is the final guard in every case.

**Run budget.** `minimum_run_budget_s` for `no_reply` with default timeouts is **6720 s**:

| Component | Seconds |
|---|---|
| Reply window | 3600 |
| Margin | 120 |
| Clock-skew allowance | 300 |
| Assessment window | 900 |
| Finality window | 900 |
| Write allowance | 900 |

The default `run_budget_s` (5400) is refused before any network activity, so a no-reply run needs an explicit `VERICOURT_RUN_BUDGET_S` of at least 6720 (for example 7200). Existing fixtures add no requirement.

## 5. Tests and results

All commands were run in WSL (`~/.venvs/vericourt`).

| Command | Result |
|---|---|
| `python -m pytest tests/direct/test_no_reply_fixture.py tests/direct/test_integration_fixtures.py -q` | 28 passed |
| `python -m pytest tests/harness -q` | 84 passed |
| `python -m pytest -q` (default testpaths: direct + harness) | **454 passed** (previously 419; +14 `test_no_reply_fixture.py`, +1 `no_reply` parameter in `test_integration_fixtures.py`, +20 harness) |
| `VERICOURT_RUN_STUDIONET` unset; `pytest tests/integration --collect-only` | 1 collected, not run |
| Mutation run on a scratch copy of the new no-reply logic (`harness.py`, `case_fixtures.py`) | **12/12 caught** |
| The Phase 2.13 harness mutation run, repeated | **17/17 caught** |
| `genvm-lint check` / `typecheck` / `schema` (`GENVM_VERSION=v0.2.16`) | Passed; 0 type errors; 14 methods (9 view, 5 write), unchanged |
| `pyright` on `harness.py`, `case_fixtures.py`, `test_studionet_smoke.py` | 0 errors, after replacing one `check()` with an explicit guard for type narrowing |

**Mutations caught in the new logic:**
- wait skipped;
- margin removed;
- clock-offset limit removed;
- pre-processing or post-processing state check removed;
- upfront budget check removed;
- requests made while waiting;
- no-reply branch not taken;
- budget ignoring the reply window;
- margin floor removed;
- every fixture planning deadline processing;
- the expectation rejecting a no-reply disagreement.

**Coverage against the Task 4 requirements:**

| Requirement | Test(s) |
|---|---|
| No reply in the fixture or the plan | `test_no_reply_fixture_has_no_reply_and_plans_deadline_processing` |
| Reply skipped only for `no_reply`; existing fixtures still reply | `test_no_reply_path_skips_reply_and_expires_the_deadline_once_after_it`, `test_reply_fixtures_still_reply_and_never_wait`, `test_existing_fixtures_still_plan_a_reply`, `test_runner_full_plan_success_and_disagreement` |
| Deadline processing only after the deadline | `test_no_reply_path_...` (processed after deadline + margin; no calls during the wait), `test_deadline_is_respected_whatever_the_clock_offset[-250/0/+250]`, `test_clock_offset_beyond_the_limit_stops_before_deadline_processing` |
| No silent repeat of deadline processing or assessment | `test_no_reply_path_...` (guard refuses both a second time), `test_unexpected_early_rejection_is_an_execution_failure_and_is_not_retried`, `test_uncertain_deadline_processing_submission_stops_without_retry`, `test_no_reply_assessment_results_are_logged_distinctly` (assessment sent exactly once) |
| Early processing rejected by the contract | `test_deadline_processing_before_or_at_the_deadline_is_rejected[-3599/-1/0]` (exactly at the deadline is also rejected) |
| Valid processing makes the case assessment-ready | `test_deadline_processing_after_the_deadline_makes_the_case_assessable`, `test_deadline_processing_is_not_repeatable`, `test_no_late_reply_after_expiry` |
| Assessment handles a no-reply case | `test_prompt_marks_the_missing_reply_and_states_the_silence_rules`, `test_fixture_is_accepted_exactly_as_the_harness_submits_it[no_reply]` |
| Unresolved finding gives the contract-defined outcome | `test_unresolved_finding_gives_inconclusive_with_no_response_notice` (INCONCLUSIVE; remedy SUPPORTED replaced by CANNOT_ASSESS; notice present), `test_unresolved_leader_and_unresolved_validator_agree` |
| Disagreement or failure never reported as a stored assessment | `test_no_reply_assessment_results_are_logged_distinctly[...]`: an agreed `ATTEMPT_FAILED`, `VALIDATOR_DISAGREEMENT` and `UNDETERMINED` are each recorded with `outcome: None`, and the case stays READY_FOR_ASSESSMENT |
| Logs distinguish the categories | The same parameterised test (agreed, agreed-failed, disagreement, undetermined, `TIMED_OUT_UNKNOWN`, `READ_FAILURE`), `test_uncertain_deadline_processing_submission_stops_without_retry` (`SUBMISSION_UNCERTAIN`) |
| The dangerous case | `test_contract_accepts_a_finding_resting_on_silence_and_own_assertion[...]` (§6) |
| Other | `test_accepted_deadline_processing_with_wrong_resulting_state_stops`, `test_case_no_longer_awaiting_response_stops_before_processing`, `test_run_budget_too_short_for_the_wait_stops_before_waiting`, `test_minimum_run_budget_and_margin_floor`, `test_chain_clock_offset_bounds`, `test_no_reply_expectation_flags_a_silence_based_finding` |

## 6. The dangerous case: what local tests establish

The test is `test_contract_accepts_a_finding_resting_on_silence_and_own_assertion`, on the expired `no_reply` case with mocked model output. It shows three things:
- **Stored outcomes:**
  - `SUPPORTED` citing only E1 (the claimant's own statement) is **stored as `CLAIM_SUPPORTED`**;
  - `SUPPORTED` citing only E2 (the order terms) is **stored as `CLAIM_SUPPORTED`**;
  - `PARTIALLY_SUPPORTED` citing E1 is stored as `CLAIM_PARTIALLY_SUPPORTED`.
- **Matching validators agree:** the contract's validator function, given an identical sample, votes **agree** (`run_validator() is True`). The agreement rule is satisfied by a shared supporting ID.
- **Unresolved validators disagree:** a validator whose sample is `UNRESOLVED` votes **disagree**.

**So the contract does not prevent a silence-based decision.** If the leader and enough validators each produce such a finding with a shared citation, it would be stored. Only validators answering UNRESOLVED stop it. This is the Phase 2.11 H2 limitation. It is not a new defect, and it isn't fixable within the current rules without the contract judging what evidence means, which it can't do from IDs. No contract change was made or proposed in this phase.

## 7. Proven locally vs requires StudioNet

**Proven locally** (direct mode with mocked models, and an offline harness with a fake chain and clock):
- contract deadline semantics: strictly after; rejected at the deadline; not repeatable; no late reply;
- the expired-case state, the prompt content and the outcome derivation;
- remedy replacement;
- what the agreement rule does with the samples above;
- the harness's sequencing, waiting, single submission, stop behaviour and log categories.

**Not proven; requires StudioNet:**
- whether real models and validators answer UNRESOLVED on this record, or decide against the silent respondent;
- validator agreement or disagreement on it;
- that the chain clock behaves as the `created_at` bound assumes, including the margin;
- the 1-hour real-time wait;
- finality of a no-reply assessment.

`run_validator` executes the contract's validator code on a mocked sample. It is not GenLayer consensus.

## 8. Proposed StudioNet plan: **NOT EXECUTED**

- **Fixture:** `VERICOURT_FIXTURES=no_reply` only.
- **Run budget:** `VERICOURT_RUN_BUDGET_S=7200` (≥ 6720 required; otherwise the run refuses before any network activity).
- **Writes: 6** (1 deploy plus 5 fixture writes), each at most once:
  1. deploy;
  2. `no_reply.create_case`;
  3. `no_reply.submit_evidence_E1`;
  4. `no_reply.submit_evidence_E2`;
  5. `no_reply.process_reply_deadline`;
  6. `no_reply.request_assessment`.
- **Duration:** at least the real 3600 s reply window plus a 120 s margin (more if the clock offset is negative), then the assessment and finality. Expect roughly 65–85 minutes.
- **Stop conditions:** as in Phase 2.13/2.15, plus a clock offset beyond 300 s, a case not still awaiting a response at deadline time, or an early-deadline rejection. None of these is retried.
- **Expected outcomes:**
  - an agreed `INCONCLUSIVE` with I1 `UNRESOLVED`, the no-response notice and `CANNOT_ASSESS`; or
  - `VALIDATOR_DISAGREEMENT` with the state unchanged.
- **A stored `CLAIM_SUPPORTED` or `CLAIM_PARTIALLY_SUPPORTED`** would be reported as an H2 safety finding, not as a harness failure.
- **Approval needed** before any of this runs.

## 9. Confirmation

- No network or RPC calls, deployments or transactions.
- No dependency changes, no commits.
- Contract source, ABI (14 methods) and storage are unchanged.
- No changes to the prompt, methodology or outcome rules.
- `clear` and `ambiguous` fixture data are unchanged.
