# Phase 2.14: controlled StudioNet run (`clear` fixture only)

**Result:** all 6 approved writes reached validator agreement. The v2 assessment was stored as `CLAIM_SUPPORTED`, finalised, and read back identically at `latest-nonfinal` and `latest-final`. There were no timeouts, read failures, disagreements, uncertain submissions or retries.

**Logs (secrets checked):**
- `integration-logs/studionet-smoke-2026-10-16T05-39-17.680948+00-00.json`: per-step JSON log.
- `integration-logs/studionet-phase-2-14-pytest-output.txt`: console output, with exit code 0, `1 passed in 136.00s`.

## 1. Preflight (before the first write)

**Read-only target check** (separate process; random probe address; no signing):

| Item | Value |
|---|---|
| Endpoint | `https://studio.genlayer.com/api` |
| Chain ID | `eth_chainId` = 61999, matching genlayer-py's `studionet` chain |
| Consensus contract | `sim_getConsensusContract` returned `0x000…000`. The Phase 2.8 raw transaction was also addressed to the zero address, so this is Studio's existing behaviour, not a different target |

**Deployment source:** `contracts/vericourt.py`.
- MD5 `d7e5dfa0aa8d412fd8430415ffb2491b` (unchanged since Phase 2.12).
- Runner `py-genlayer:1jb45aa8…` (GenVM v0.2.16).
- Versions: case `vericourt-case-v1`, assessment `vericourt-assessment-v2`, method `vericourt-method-v2`.

**Accounts:** gltest's default StudioNet config creates 10 random keys in memory for each run (`gltest_cli/config/user.py`: `create_accounts(n_accounts=10)`).
- `gltest.config.yaml` configures no accounts, there is no `.env` file, and no account-related environment variables are set.
- StudioNet is gasless, so no funds were involved. All data is fictional.

| Role | Address | Nonce before first write |
|---|---|---|
| Claimant (deployer; create_case; E1; request_assessment) | `0xA0bb997366B0f0f7433Efa42b21EFc6Ae6c84d9a` | 0 |
| Respondent (E2; reply) | `0x0bC755C95Ad5Bfe37570a00Ac2b4496C3A7405b9` | 0 |

**Harness preflight log:**
- network `studionet`, `leader_only=false`;
- fixtures `["clear"]`;
- 6 planned writes;
- Phase 2.13 default timeouts, unchanged.

## 2. Operations

**What "verified" means here:** each status below is the harness's classification of the transaction it read from StudioNet. It combines the status, the consensus result, and the leader receipt's execution result and return value.

| # | Operation | GenLayer transaction ID | Decided as | Validator votes (last round) | Return value |
|---|---|---|---|---|---|
| 1 | deploy | `0xdeecd405b5b312e22d960d45a1bafb83943a70bd805cfc4186e5deef8544148d` | ACCEPTED_SUCCESS (MAJORITY_AGREE) | 5 AGREE | none |
| 2 | create_case | `0x066d5dfe04e0c4ca22fc4b8ae937b3f91c86d5c8b8da3272efcd929aab7fd193` | ACCEPTED_SUCCESS (MAJORITY_AGREE) | 3 AGREE, 2 IDLE | `"VC-000001"` |
| 3 | submit_evidence E1 (claimant) | `0xa65ccb5720808de568d403b57807c1da42b6804a359a63b34981eeed2487ddb5` | ACCEPTED_SUCCESS (MAJORITY_AGREE) | 5 AGREE | `"E1"` |
| 4 | submit_evidence E2 (respondent) | `0x891b29cda2630e85dcc384824b8557fcba765370490710bbacae3bdfd6087538` | ACCEPTED_SUCCESS (MAJORITY_AGREE) | 5 AGREE | `"E2"` |
| 5 | submit_reply | `0x6c061d2e21451bfa423e3e315d2653af483f12ce73f4508646f5e758ddee2422` | ACCEPTED_SUCCESS (MAJORITY_AGREE) | 3 AGREE, 2 IDLE | none |
| 6 | request_assessment | `0x397120e7471e689c38fe7894aa1344dfcb145be9be7f5f6ca2f20f618bf9484f` | ACCEPTED_SUCCESS (MAJORITY_AGREE), then **FINALIZED_SUCCESS** | 3 AGREE, 2 IDLE | `"CLAIM_SUPPORTED"` |

- **Deployment address:** `0x41CC4c0ccB4c29994Dd7B58EbAB49309b5F8A8cB`.
- **Timing:** each write was decided within 7.5–14.2 s of polling. The assessment reached FINALIZED 21.1 s after acceptance. The whole run took 136 s.
- **Request counts:** 64 RPC requests, all `ok`:
  - 6 `eth_sendRawTransaction`, one per planned write;
  - 17 `eth_getTransactionByHash`;
  - 14 `gen_call`.

**Checks performed during the run, all passed:**
- Case count went from 0 to 1, giving case `VC-000001`. Its claimant, respondent, title and AWAITING_RESPONSE status matched what was submitted.
- Each returned evidence ID matched the expected one.
- After the reply, the case was READY_FOR_ASSESSMENT and locked.
- The stored outcome equals the returned value.
- The assessment's snapshot digest equals the case's (`1ec469fc…af07e42`).
- The findings cover the case issues in order.
- The assessment status is identical at `latest-nonfinal` and `latest-final`.

## 3. Stored assessment (read at `latest-final`)

- **Outcome:** `CLAIM_SUPPORTED`. Case status `DECIDED`; attempts 1/2; `last_error` empty; `can_request` false.
- **I1:** `SUPPORTED`, supporting `[E1, E2]`, counter `[]`, confidence HIGH. This matches the documented expectation (`expectation.met = true`).
- **Remedy (advisory, not compared across validators):** `SUPPORTED`.
- **Notices:** "The respondent's reply was part of the assessed record." The three standard notices and the provenance block (v2 / Phase 2.12 wording) are present.
- **History:** 6 entries: CASE_CREATED, EVIDENCE_SUBMITTED E1 (claimant), EVIDENCE_SUBMITTED E2 (respondent), REPLY_SUBMITTED, SNAPSHOT_LOCKED, ASSESSMENT_DECIDED (attempt=1; outcome=CLAIM_SUPPORTED).
- **Leader-written prose** (summary, finding, reasoning, limitations): coherent and grounded in E1/E2. It explicitly treats the reply as corroborating rather than as proof on its own. This prose is `leader_generated_unverified`: it was not checked by validators.

## 4. Verified vs assumed

**Verified (read from StudioNet in this run):**
- the target chain ID;
- fresh accounts;
- exactly 6 writes, each sent once;
- each write's MAJORITY_AGREE consensus and successful leader execution;
- the return values;
- the contract address;
- the assessment transaction reaching FINALIZED;
- identical assessment status at both read variants;
- the stored assessment content and digest.

**Not verified, or assumed:**
- **Finality of the 5 earlier writes wasn't polled individually.** Their effects (case, evidence, reply, lock) are present in the `latest-final` reads, which is consistent with them being final.
- **"IDLE" votes** (2 of 5 validators on create_case, reply and assessment) are taken to mean validators that didn't vote in that round. A 3-AGREE majority decided each one. The SDK doesn't document IDLE further.
- **Which validator models agreed** wasn't recorded: the harness logs vote names only, not node configs.
- **One run is not a measured agreement rate.** Agreement on this clear-cut record doesn't predict agreement on unclear records; the ambiguous fixture was deliberately not run.
- **Leader prose and the remedy view are unverified** by design (see provenance).

## 5. Unexpected behaviour

None that affected the result. Points to note:
- **Consensus contract at the zero address:** expected for Studio, as above.
- **Typographic apostrophes:** the leader's prose contains U+2019. Storage and read-back handled this without problems. The earlier ASCII issue applied only to genlayer-py encoding the contract source and fixture text, which remain ASCII.

## 6. Confirmation

- Only the `clear` fixture ran; the ambiguous fixture was not run.
- No changes were made to the contract, prompts, fixtures, dependencies or harness behaviour during the run.
- **No retries, and no network writes after the run.** The only network activity outside the harness was the read-only preflight in §1.
- The logs contain no key material: the only 64-hex strings in them are the snapshot digest.
- No commits.
