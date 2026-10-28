# Phase 2.17C: no-reply StudioNet run

**Result:** all 6 approved writes were sent once each and reached validator agreement in round 1. A separate read-only lookup after the run confirmed all six FINALIZED.
- The reply deadline was processed **137 s after** the on-chain deadline.
- The assessment was stored as **`INCONCLUSIVE`**, with I1 **`UNRESOLVED`** and remedy `CANNOT_ASSESS`, and the contract's no-response notice.
- `expectation.met = true`; **no `safety_finding`**.
- No timeouts, read failures, disagreements, uncertain submissions, retries or deviations from the plan.

**Labels:**
- **[Observed]**: read from StudioNet and recorded in the logs.
- **[Inferred]**: concluded from the contract's code and rules.

**Artifacts in `integration-logs/`:**
- `studionet-smoke-2026-10-17T07-02-42.747189+00-00.json`: per-step harness log;
- `studionet-phase-2-17c-pytest-output.txt`: console output; `1 passed in 3870.35s`, exit 0; local start 07:02:35Z, end 08:07:15Z;
- `studionet-phase-2-17c-finality-readback.json`: post-run read-only status of all six transactions.

## 1. Pre-run checks (completed before any network activity, except check 3)

| # | Check | Result |
|---|---|---|
| 1 | Working tree | Branch `master` has no commits. Everything is untracked: `.gitignore`, the two spec files, `contracts/`, `docs/`, `gltest.config.yaml`, `pytest.ini`, `requirements.txt`, `tests/`. Nothing was discarded, reset, stashed or overwritten |
| 2 | Contract | `contracts/vericourt.py` MD5 `D7E5DFA0AA8D412FD8430415FFB2491B` (last written 2026-10-15 14:17Z), same as reviewed in 2.17B. `genvm-lint check`: passed, 14 methods (9 view, 5 write). Every harness and fixture file was last written before the 2.17B report (06:58Z) |
| 3 | Target | Read-only: `eth_chainId` = 61999 at `https://studio.genlayer.com/api`. Consensus contract reported as the zero address, as in 2.14/2.15. `gltest.config.yaml` unchanged (`studionet: {}`) |
| 4 | Fixture and plan | Resolved locally from the approved environment: fixtures `["no_reply"]`; plan = deploy, create_case, E1, E2, process_reply_deadline, request_assessment (6); `submit_reply` absent; `process_reply_deadline` appears once |
| 5 | Budget | `Timeouts.from_env` gives `run_budget_s = 10800` (minimum for this plan 6720). `RunBudget(10800)` is created before the first network call and covers the whole run |
| 6 | Write safety | Verified from code in 2.17B and unchanged: no reply path for `no_reply`; deadline processed through one `write_ok`; `WriteGuard` attempts each write at most once; any uncertain submission halts the run |
| 7 | Accounts | New random keys from gltest's default config, held in memory only. No `.env` file; keys registered with the log scrubber. Preflight nonces 0 and 0 [Observed] |
| 8 | Host | Keep-awake hold requested and granted (`session_idle`). The session was kept active through the wait with a log monitor and 4-minute heartbeats |

## 2. Execution

| Item | Value |
|---|---|
| Accounts | Claimant `0xb111Bd9D67fF65A0123d865837f22d77c6A8AEF8`, respondent `0xa618c7857B836357947e6Fd504FaC4cc5b439197` (the respondent submitted nothing) |
| Deployment address | `0x3258A80A86920792354A9b7e59D5Ed2409E96220` |
| Case ID | `VC-000001` |

| # | Operation | Transaction ID | Decided as (during run) | Votes (last round) | Returned | Post-run read-only status | Rounds |
|---|---|---|---|---|---|---|---|
| 1 | deploy | `0x4557895102ac3e4eded2d928745098c98b382fe7a9b13a3cbdc88f7219881567` | ACCEPTED_SUCCESS, MAJORITY_AGREE | 3 AGREE, 2 IDLE | none | FINALIZED_SUCCESS | 1 |
| 2 | create_case | `0x35f1263e52886201adcd1860dd957fb4a2881d2fdecfe12727328e20002fdf28` | ACCEPTED_SUCCESS, MAJORITY_AGREE | 3 AGREE, 2 IDLE | `VC-000001` | FINALIZED_SUCCESS | 1 |
| 3 | submit_evidence E1 (claimant) | `0xac06c3c9667ebbfd4e6d4ffc04994ffef21df73eb20a71b2dcccad9f52c2eaa1` | ACCEPTED_SUCCESS, MAJORITY_AGREE | 3 AGREE, 2 IDLE | `E1` | FINALIZED_SUCCESS | 1 |
| 4 | submit_evidence E2 (claimant) | `0x4c16b6982f942e7704216c54a1587ef90dc74ec9e9c19ef86704c2563e464b66` | ACCEPTED_SUCCESS, MAJORITY_AGREE | 3 AGREE, 2 IDLE | `E2` | FINALIZED_SUCCESS | 1 |
| 5 | process_reply_deadline | `0x395b74d6c9d1928c9cd1ac229a79ce8134c9ef11e0a146f3808c5a3eedb2ed7c` | ACCEPTED_SUCCESS, MAJORITY_AGREE | 3 AGREE, 2 IDLE | none | FINALIZED_SUCCESS | 1 |
| 6 | request_assessment | `0xaf54746cdd8d48e04fc7d270dfd3d750678ddaf1eb0162196ee5d55247528122` | ACCEPTED_SUCCESS, MAJORITY_AGREE (35.6 s); harness finality poll: FINALIZED_SUCCESS (20.9 s after the poll started) | 3 AGREE, 2 IDLE | `INCONCLUSIVE` | FINALIZED_SUCCESS | 1 |

All of the above is [Observed].

**Request counts:**
- Harness: 69 RPC requests, all `ok`, including 6 `eth_sendRawTransaction`, one per planned write.
- Post-run read-only check: 7 more requests (1 `sim_getConsensusContract`, 6 `eth_getTransactionByHash`).
- No `submit_reply` was ever sent: it is absent from the plan, the log and `writes_attempted`.

## 3. Deadline handling

All [Observed] unless labelled.

| Time | Event |
|---|---|
| 07:02:35Z (local epoch 1792220555) | Run start |
| on-chain 1792220603 | `create_case`: `created_at`; `reply_deadline` 1792224203 (= +3600) |
| — | Clock-offset bounds (chain − local) **[−9.4 s, +3.7 s]**, within ±300 s |
| — | Planned wait: **3689.8 s** (deadline + 120 s margin, on the lower bound). No requests were sent or read during the wait |
| — | Fresh read before processing: `AWAITING_RESPONSE`, `PENDING`, unlocked, `locked_at 0` |
| on-chain 1792224340 | `process_reply_deadline` executed: **137 s after the deadline**. Status read afterwards: `READY_FOR_ASSESSMENT`, `NO_RESPONSE_BY_DEADLINE`, `REPLY_WINDOW_EXPIRED`, locked |
| on-chain 1792224355 | Assessment decided |
| 08:07:15Z (local epoch 1792224436) | Run end; total 3870 s (1 h 04 min 30 s) |

- **The deadline was processed after expiry:** `locked_at` 1792224340 > `reply_deadline` 1792224203 on the chain's own clock, and the contract accepted the call [Observed].
- **The case was in the expected state before the assessment** [Observed].
- **[Inferred]** The clock assumption from 2.17B held for this run: the offset was small, and the contract's strict deadline check passed on the first and only call.

## 4. Stored assessment (read at `latest-final`; identical at `latest-nonfinal`)

| Field | Value |
|---|---|
| Outcome | **`INCONCLUSIVE`** |
| Case status / attempts | `DECIDED`; attempt 1 of 2; `last_error` empty |
| I1 determination | **`UNRESOLVED`**, confidence HIGH |
| I1 supporting / counter IDs | `["E1", "E2"]` / `[]` |
| Remedy | `CANNOT_ASSESS` |
| `response_state` | `NO_RESPONSE_BY_DEADLINE` |
| `notices` | "The respondent did not reply before the deadline. This is recorded as a procedural fact only; it is not treated as evidence that the claim is correct." |
| `standard_notices` | Not legal advice or binding arbitration; consensus is not a guarantee of truth; a file hash doesn't prove authenticity |
| Snapshot digest | `9a0a744a448e61ea4e4ed462e216315917faa819c472d30b6bf8e3376369e313`, equal for case and assessment |
| Locked evidence | E1 (CLAIMANT), E2 (CLAIMANT); reply `""` |
| History | CASE_CREATED → EVIDENCE_SUBMITTED E1 → EVIDENCE_SUBMITTED E2 → REPLY_WINDOW_EXPIRED ("procedural fact, not proof against the respondent") → SNAPSHOT_LOCKED → ASSESSMENT_DECIDED (attempt=1; outcome=INCONCLUSIVE) |

All of the above is [Observed]. Every one of the five reads was identical at latest-nonfinal and latest-final.

**Leader-written text** (`leader_generated_unverified`, not checked by validators):
- The finding states the claimant's statement is uncorroborated and that the order confirmation doesn't document delivery.
- The reasoning says explicitly that "the respondent's silence does not corroborate it".
- The open questions ask for transmission logs or a different delivery address.
- The limitations note the respondent "did not participate, leaving the claimant's allegations uncontested but uncorroborated".

**Citation rules and remedy:**
- **[Inferred, from the contract code] The citations meet the contract's rules:**
  - E1 and E2 exist in the locked record;
  - no ID is in both lists;
  - the "SUPPORTED/PARTIALLY_SUPPORTED need a supporting ID" and "NOT_SUPPORTED needs a counter ID" rules don't apply to UNRESOLVED.
- **[Observation, not a rule violation] The citation lists for UNRESOLVED are untidy.** E1 and E2 sit in `supporting_evidence_ids` for an UNRESOLVED finding. The model seems to have used the list to name the items it considered, not items that support the claim. The contract doesn't compare citation lists for an UNRESOLVED pair, and the provenance marks the lists as `partially_checked`. A frontend should not present these IDs as "evidence supporting the claim" when the determination is UNRESOLVED.
- **[Inferred] The remedy is consistent with the outcome.** `CANNOT_ASSESS` is the only value `_consistent_remedy` allows with `INCONCLUSIVE`. The logs can't tell whether the model chose it or the contract replaced another value.

## 5. Validator agreement

- **[Observed]** The assessment reached MAJORITY_AGREE in round 1, with 3 AGREE and 2 IDLE votes, and FINALIZED.
- **[Inferred, from `_findings_agree`]** An AGREE vote on this leader result requires the validator's own sample to have I1 UNRESOLVED and outcome INCONCLUSIVE; U/U is the only agreeing pair. The validators' own samples are not in the logs.
- IDLE votes are assumed to mean "did not vote in that round", as in earlier runs.

## 6. Harness result and safety interpretation

**Harness result fields [Observed]:**
- `consensus_category` `ACCEPTED_SUCCESS`, `returned` `INCONCLUSIVE`, `case_status` `DECIDED`, `outcome` `INCONCLUSIVE`, `finality` `FINALIZED_SUCCESS`;
- `expectation = {"met": true, "observed": {"outcome": "INCONCLUSIVE", "determinations": {"I1": "UNRESOLVED"}}}`;
- **no `safety_finding` field**, which appears only for an agreed CLAIM_SUPPORTED or CLAIM_PARTIALLY_SUPPORTED;
- `problems: []`, `warnings: []`, `halted: null`.

**Interpretation:**
- This is the expected safe result. The absent respondent was **not** found against on the claimant's own statement or on the order terms alone, and no remedy against the respondent was suggested.
- **[Inferred]** The stored reasoning applies the rubric's silence rules directly.

**What this does not show:**
- It does **not** show that silence is handled fairly in general. It is one run, on one record, with one set of validators.
- The local tests (`test_contract_accepts_a_finding_resting_on_silence_and_own_assertion`) show the contract **would** store a silence-based `CLAIM_SUPPORTED` if the leader and validators agreed on one. Phase 2.11 H2 remains open: only the prompt guards against it.

## 7. Anomalies

| Kind | Occurred? |
|---|---|
| Timeout | No |
| Disagreement | No |
| Undetermined consensus | No |
| Read failure or missing read-back | No |
| Uncertain transaction | No |
| Unexpected transaction | No |
| Budget exhaustion | No: 3870 s used of 10800 |

**Deviations from the plan:** none in the run itself. Outside the run:
- **The log monitor failed to start twice,** because Git Bash rewrote the `findstr` argument, then the WSL script path. It was fixed with `MSYS_NO_PATHCONV=1`. The monitor only read local log files; it never touched the run or the network.
- **The finality read-back used a separate read-only script** in the session scratchpad, the same approach as Phase 2.15 (Phase 2.16 audit I-2: not in the repository).

**Secrets [Observed]:** the only 64-hex string in the run log and console output is the snapshot digest.

## 8. Limitations

- **Single run.** No agreement rate, and no claim about other records, models or validator sets.
- **Validators' own samples, models and leader identity are not logged.** Agreement content is inferred from the contract's agreement rule.
- **The leader's prose is unverified.** Its silence-respecting wording is the leader's, not something validators checked.
- **Remedy origin is unknown:** model output or contract replacement.
- **The clock assumption** held here with a small offset, which doesn't prove it holds under other conditions.
- **The harness log has no per-step wall-clock timestamps.** Timing above comes from on-chain timestamps, the logged offset bounds, and the start and end lines of the console output.

## 9. Confirmation

- Only the approved `no_reply` run was executed; `clear` and `ambiguous` were not run.
- Exactly 6 writes. No reply, no retries, no recovery transactions, no replacement run.
- Network activity outside the harness: the read-only pre-run chain check and the read-only post-run transaction status lookups.
- No changes to the contract, prompts, fixtures, harness, configuration or dependencies. Only the approved runtime variables were set (`VERICOURT_RUN_STUDIONET=1`, `VERICOURT_FIXTURES=no_reply`, `VERICOURT_RUN_BUDGET_S=10800`).
- No commits.

---

## Addendum (2026-10-17, Phase 3.5B): later write to this deployment

This deployment is no longer in its original Phase 2.17C state. Phase 3.5A Stage A added **one** fictional case to it, through a one-off guarded genlayer-js script (not the app):

| Field | Value |
|---|---|
| Case | `VC-000002` (fictional; title "FICTIONAL TEST - VeriCourt Phase 3.5A Stage A write check") |
| Transaction | `0x309c83aab54b0408930d9c3e92a0f9037fd53a97928f5018ce8012c491487f09`, FINALIZED, MAJORITY_AGREE |
| Sender | `0x96E2fb5A4FEa1532F14Cb70D495D55BAdd7426B0` (fresh single-use test account) |
| Case count after | 2 |
| Evidence | `docs/PHASE_3_5A_STAGE_A_REPORT.md`, `integration-logs/phase-3-5a-stage-a-write-20261017T215413Z.json` |

`VC-000001` and the six transactions above are unchanged. The address, deploy transaction and code hash are unchanged.

### Addendum 2 (2026-10-19, Phase 3.7): second later write

Phase 3.6 added **one** more fictional case, from an operator's throwaway browser wallet through the gated write-experiment build:

| Field | Value |
|---|---|
| Case | `VC-000003` (fictional; title "FICTIONAL TEST - VeriCourt browser-wallet write 2026-10-19T06:05:25") |
| Transaction | `0x1574004493ed3f2bb5dd29d673d6738d2ee192379edfaa563d523f69d7c108e0`, FINALIZED, MAJORITY_AGREE (3 agree, 2 idle) |
| Sender | `0x16fD571ae717F92b5e43597d813267C8d15f105A` (operator's throwaway account) |
| Case count after | 3 |
| Evidence | `docs/PHASE_3_6_BROWSER_WALLET_TEST_REPORT.md`, `integration-logs/phase-3-6-live-result-20261019T064010Z.json` |
