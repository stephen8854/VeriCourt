# Phase 2.15: controlled StudioNet run (`ambiguous` fixture only)

**Result:** all 6 approved writes reached validator agreement in a single round. The v2 assessment was stored as **`INCONCLUSIVE`**, with both issues `UNRESOLVED`, and finalised. All six transactions were later confirmed FINALIZED by a separate read-only lookup. There were no timeouts, read failures, disagreements, uncertain submissions or retries.

**Logs:**
- `integration-logs/studionet-smoke-2026-10-16T08-56-13.587740+00-00.json`: per-step harness log.
- `integration-logs/studionet-phase-2-15-pytest-output.txt`: console output, exit 0, `1 passed in 214.44s`.
- `integration-logs/studionet-phase-2-15-finality-readback.json`: post-run read-only status of all six transactions.

## 1. Preflight (completed before the first write)

**Documents reviewed:** `PHASE_2_14_STUDIONET_RUN_REPORT.md`, `PHASE_2_13_HARNESS_REPORT.md`, `PHASE_2_11_ADVERSARIAL_REVIEW.md` (M1 addressed in 2.13; M3, L2–L4 still open) and the integration logs.

**Fixture identity.** The `ambiguous` fixture was compared field by field with the Phase 2.8 on-chain read-back (`studionet-rerun-readonly-verification.json`, case VC-000001 at `0xfff3052A…90e4`). The comparison covered:
- 7 case fields, the issues and the reply;
- for each piece of evidence: its ID, the submitting party, type, label, description, content, sha256 and issue IDs.

There were **no differences**. After the run, the new case's snapshot digest `7e8533fb72625341391054633360b3f71be50148ea3b52fb6997382d7588137a` is **identical** to the Phase 2.8 digest. That independently confirms the same record content.

**Contract.** The harness always deploys a fresh instance and has no reuse option. Adding one would have been a harness change, which this phase didn't allow. The Phase 2.8 instance runs v1 code; the Phase 2.14 instance holds the `clear` case.
- Plan: **1 deploy + 5 fixture writes = 6.**
- Source: `contracts/vericourt.py`, MD5 `d7e5dfa0aa8d412fd8430415ffb2491b` (same as Phase 2.14), GenVM v0.2.16, `vericourt-assessment-v2` / `vericourt-method-v2`.

**Target.** `https://studio.genlayer.com/api`. A read-only check returned `eth_chainId` 61999, matching the SDK chain.

**Accounts.** New random keys, held in memory only; no `.env` file; gasless network.
- Claimant `0x7Fd1AB64CE04475e6a4428DB223ED8cc8752118c`, nonce 0 before the first write.
- Respondent `0xF6D21722B1EA6BdDc1453287617Aec176ae23Fd1`, nonce 0 before the first write.

**No code changes.** The contract, fixtures and harness files were all last modified before the Phase 2.14 run.

**Expected results stated beforehand** (any of these counts as consistent):
- `VALIDATOR_DISAGREEMENT` with no state change;
- an agreed `INCONCLUSIVE`;
- an agreed `CLAIM_PARTIALLY_SUPPORTED` with I2 UNRESOLVED.

## 2. Operations

| # | Operation | Transaction ID | Decided as (during run) | Votes | Returned | Independently FINALIZED (post-run read) | Rounds |
|---|---|---|---|---|---|---|---|
| 1 | deploy | `0x3e14743b27e76771d3c9b4072a4a9c2de0aedbb4d06484d01e8f1b58c4aec8c8` | ACCEPTED_SUCCESS, MAJORITY_AGREE | 3 AGREE, 2 IDLE | none | Yes (FINALIZED_SUCCESS) | 1 |
| 2 | create_case | `0x4c92e430375fbc9a93fce715255bc8fb43a645eb54db1cf4e89f6f3289790cc0` | ACCEPTED_SUCCESS, MAJORITY_AGREE | 5 AGREE | `VC-000001` | Yes | 1 |
| 3 | submit_evidence E1 (claimant) | `0xe676ac8bc22deba5bf951e5527d08852a1d08059323272e0c9170f9cdc5d5552` | ACCEPTED_SUCCESS, MAJORITY_AGREE | 5 AGREE | `E1` | Yes | 1 |
| 4 | submit_evidence E2 (respondent) | `0x198d5e409e43f68e1db46bc2e315c3228b434e6be25ac8de162cb04660eaf428` | ACCEPTED_SUCCESS, MAJORITY_AGREE | 5 AGREE | `E2` | Yes | 1 |
| 5 | submit_reply | `0xfaaee7b5b07468dd37c36e3c64f79b2d4f602c9ba4e250e6805d21693770ff0c` | ACCEPTED_SUCCESS, MAJORITY_AGREE | 3 AGREE, 2 IDLE | none | Yes | 1 |
| 6 | request_assessment | `0x71a4bf9805293e0355af87e8d251e484a0c844f200a80705f4a82e6acbf08032` | ACCEPTED_SUCCESS, MAJORITY_AGREE (56.7 s); harness finality poll: FINALIZED_SUCCESS (+22.5 s) | 3 AGREE, 2 IDLE | `INCONCLUSIVE` | Yes | 1 |

- **Deployment address:** `0xd9c750D81c52eAc4D112214d8601d2895A167A83`.
- **Requests:** 6 `eth_sendRawTransaction`, one per planned write. All 70 harness RPC requests succeeded. The post-run read-only check made a further 7 requests: 1 `sim_getConsensusContract` and 6 `eth_getTransactionByHash`.

**How finality was confirmed:**
- During the run, the harness polled only the assessment transaction to finality. It verified writes 1–5 only through later state, which was present in the `latest-final` reads.
- After the run, a separate **read-only** status lookup confirmed **all six** FINALIZED with MAJORITY_AGREE in round 1. No leader rotation was needed.

## 3. Read-back verification

All checks passed, read at both `latest-nonfinal` and `latest-final`:
- Case count went from 0 to 1, giving `VC-000001`. The claimant, respondent, title and AWAITING_RESPONSE status matched what was submitted.
- Each returned evidence ID matched the expected one.
- After the reply, the case was READY_FOR_ASSESSMENT and locked.
- The returned outcome equals the stored outcome.
- The assessment digest equals the case digest (`7e8533fb…`).
- The findings cover I1 and I2 in order.
- The assessment status is identical at both read variants: `DECIDED`, attempts 1/2, `last_error` empty.

**History (latest-final):** CASE_CREATED, EVIDENCE_SUBMITTED E1 (claimant), EVIDENCE_SUBMITTED E2 (respondent), REPLY_SUBMITTED, SNAPSHOT_LOCKED, ASSESSMENT_DECIDED (attempt=1; outcome=INCONCLUSIVE).

## 4. Stored assessment

- **Outcome:** `INCONCLUSIVE`. Remedy `CANNOT_ASSESS`, the only value the contract allows with an INCONCLUSIVE outcome.
- **I1:** `UNRESOLVED`, LOW confidence, no cited IDs. Reasoning: E1 shows the requirement and E2 claims an approved postponement, but both are uncorroborated assertions from each party.
- **I2:** `UNRESOLVED`, LOW confidence, no cited IDs. Reasoning: the respondent's claimed approval of a reduced scope is uncorroborated, and the claimant gives no evidence of what was delivered.
- **Open questions and limitations:** these correctly identify the missing documentation (approval records, what was actually delivered, acceptance criteria).
- **Provenance:** the prose, open questions and limitations are leader-generated and were not checked by validators.

**Consistency with expected handling: yes.** This is one of the outcomes stated in advance (`expectation.met = true`). It is the rubric-faithful result: each side has only its own uncorroborated statement, so neither issue is decided. It is also exactly what the v2 rubric and the Phase 2.12 rules aim for: E2, the respondent's own change note, was **not** treated as establishing the scope change.

## 5. Compared with Phase 2.8 (same record)

**Phase 2.8 (v1 contract):**
- the assessment went UNDETERMINED with MAJORITY_DISAGREE after 4 rounds;
- the proposals split on I2 (NOT_SUPPORTED vs UNRESOLVED) and on I1 (P vs U);
- the remedy disagreed too.

**Phase 2.15 (v2 + Phase 2.12):** one round, majority agreement, both issues UNRESOLVED.

The v2 rubric (step-by-step, own assertions don't establish facts, UNRESOLVED when unsure), the derived outcome and the advisory remedy are all consistent with this convergence. But a single run on each side can't separate the effect of those changes from model or sampling variation, or from different validator models being selected.

## 6. Disagreements, timeouts, failures, unknowns

None.
- **IDLE votes:** 2 of 5 validators were IDLE on the deploy, reply and assessment. As in Phase 2.14, this is assumed to mean those validators didn't vote in that round; a 3-AGREE majority decided each. The SDK doesn't document IDLE further.
- **Which validator models took part** was not recorded.

## 7. What this test does and does not establish

**It does establish, for this single run:**
- The v2 contract and Phase 2.13 harness complete the ambiguous record end to end on StudioNet without hanging.
- Validators reached agreement on an all-UNRESOLVED result.
- The `INCONCLUSIVE` outcome was derived and stored, with the remedy correctly constrained.
- Finality and read-back are consistent.
- On this record, the rubric's handling of uncorroborated assertions produced the intended outcome.

**It does not establish:**
- **An agreement rate.** With n=1, it doesn't show the ambiguous record will reliably converge; Phase 2.8 shows it can diverge.
- **That disagreement handling works on v2 on the network.** No disagreement occurred, so the "state unchanged after disagreement" path is still verified only offline.
- **That models never treat a party's own assertion as proof,** in general or on other records. The Phase 2.11 H2 limitation still applies: it's enforced by the prompt only.
- **That the leader's prose is accurate or neutral.** It was not checked by validators.
- **Anything about the agreed-failed-attempt path** (`ATTEMPT_FAILED`), no-reply cases, or multi-issue partial outcomes (M3).
- **Behaviour on any network other than StudioNet,** or with other validator configurations.

## 8. Confirmation

- Only the `ambiguous` fixture ran; `clear` was not re-run.
- Each planned write was sent exactly once. There were no retries and no network writes after the run.
- The only network activity outside the harness: the read-only preflight (chain ID, nonce of a probe address) and the read-only post-run transaction status lookups.
- No changes to the contract, prompts, fixtures or harness. No dependency changes. No commits.
- The logs contain no key material: the only 64-hex strings in the run log and console output are the snapshot digest.
