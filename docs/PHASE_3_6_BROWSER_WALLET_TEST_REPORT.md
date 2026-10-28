# Phase 3.6: controlled browser-wallet test, report

**Result: PASS.** One `create_case` was submitted from a throwaway browser wallet through VeriCourt's gated experiment build:
- **Finalized:** FINALIZED with MAJORITY_AGREE. The leader returned `"VC-000003"`.
- **Verified by a latest-final read:** case `VC-000003` exists with exactly the reviewed fictional fields, and the case count went 2 → 3.
- **Signed bytes match the review:** the bytes StudioNet stored contain **byte-identical** calldata to the reviewed transaction.

**The panel's own result agrees:** the operator reported **"Case created and confirmed. Transaction `0x1574…08e0` finalized and a latest-final read shows VC-000003."** (§4.4).

**Deviations, all recorded in §6:**
- a wallet-connection defect found and fixed (with approval) during the test;
- the gas limit changed by the wallet;
- a self-inflicted RPC rate-limit incident;
- an auto-started preview server;
- the operator signing revision 2 without a separate "approved" message.

---

## 1. Environment

| Item | Value |
|---|---|
| Network | GenLayer StudioNet, chain ID 61999 (`0xf22f`), RPC `https://studio.genlayer.com/api` |
| Test contract | `0x3258A80A86920792354A9b7e59D5Ed2409E96220`: Phase 2.17C throwaway; code SHA-256 `25bc9e0b…79333` = repo `contracts/vericourt.py` |
| Consensus entry point | `0xb7278A61aa25c888815aFC32Ad3cC52fF24fE575` (genlayer-js 1.1.8 studionet constant) |
| Operator account | `0x16fD571ae717F92b5e43597d813267C8d15f105A`: throwaway; balance 0; nonce 0 before |
| Operator setup (reported by the operator) | dedicated browser profile; one wallet extension; StudioNet added manually |
| App | `frontend/` at the reviewed state, plus the §6.1 fix. genlayer-js 1.1.8; React 19.3.1 |
| Server | `vite --mode write-experiment`; gate inputs: the acknowledgement phrase, the contract above; bound to **`127.0.0.1:5173` only** (PIDs 17140, then 15520 after the clean restart) |
| Tests at the time of signing | **616 passed / 30 files**; typecheck, lint and ordinary build clean; 0 write-path strings in `dist/` |

---

## 2. Steps performed

1. **Readiness and preflight (Phases 3.6–3.6E, read-only):** repository state, bytecode, chain, case count, the account's nonce, balance and cases, a simulation as the sender (`VC-000003`). Reports: `PHASE_3_6_*`, `PHASE_3_6B…3_6E`.
2. **Experiment server started** on instruction, 2026-10-18 21:42 UTC. An auto-started ordinary preview server had to be stopped first (§6.4).
3. **First title** `…2026-10-18T21:59:07`: exact transaction computed (`PHASE_3_6F` §1–2) and approved by the operator. **Not signed:** "Sign in wallet" stayed disabled ("Press Connect … in this tab first"). The operator then reloaded, which voided that approval because the title changed.
4. **Defect diagnosed:** reproduced against the real reducer code, without the wallet. The fix was approved, implemented test-first, verified, and the server restarted cleanly (§6.1).
5. **RPC rate limit:** my read-only watcher exceeded StudioNet's limit. It was stopped and the test paused until the limit cleared (§6.3).
6. **Second title** `…2026-10-19T06:05:25`: the operator reported the button clickable; the exact transaction was recomputed (`PHASE_3_6F`, revision 2). Title reconciled; simulation `VC-000003`.
7. **Operator signed** in the wallet. The panel reported "Write in progress … Transaction `0x1574…08e0`. Status: accepted. Accepted is not final".
8. **Independent read-only verification** at 06:40 UTC: FINALIZED, the stored signed bytes decoded and compared, case read back at latest-final (6 requests).

---

## 3. Identifiers

| | |
|---|---|
| Transaction hash = GenLayer `tx_id` | **`0x1574004493ed3f2bb5dd29d673d6738d2ee192379edfaa563d523f69d7c108e0`** |
| keccak-256 of the stored signed bytes | the same value. **The hash returned through the browser-wallet path is the GenLayer transaction ID**, verified for this wallet on StudioNet |
| Resulting case | **`VC-000003`** (matches the simulation) |
| Calldata keccak-256 (reviewed = signed) | `0x8ce10c83aacfef2910b1b6a3f563299cfe9f6ef35f16a1b525b1f7ee85abe53e` |

---

## 4. Wallet-prompt verification

### 4.1 Before signing

The operator was given the complete expected transaction and the prompt checklist (`PHASE_3_6F` revision 2). The operator's own reading of the prompt was not reported back in detail.

### 4.2 After signing (independent evidence)

Decoded from StudioNet's stored `signed_rollup_transaction`:

| Field | Reviewed | Signed | Match |
|---|---|---|---|
| Type | legacy | legacy | ✔ |
| Chain ID | 61999 | 61999 | ✔ |
| To | `0xb7278A61…E575` | `0xb7278a61…e575` | ✔ |
| Nonce | 0 | 0 | ✔ |
| Value | 0 | 0 | ✔ |
| Gas price | 0 | 0 (empty field) | ✔ |
| Selector | `0x27241a99` | `0x27241a99` | ✔ |
| Calldata | 740 bytes, keccak `0x8ce1…e53e` | 740 bytes, keccak `0x8ce1…e53e` | **✔ byte-identical** |
| Signer | `0x16fD…105A` | recovered `0x16fD…105A` | ✔ |
| **Gas limit** | ≈500,000 (SDK estimate) | **750,000** | **differs (§6.2). Fee still 0** |

### 4.3 How StudioNet processed it

- `to_address` = `recipient` = `0x3258A80A…6220`, the same routing as Stage A;
- `execution_mode` NORMAL;
- `leader_only` false;
- 5 validators, 3 rotation rounds.

### 4.4 The panel's final display (operator-reported)

> Case created and confirmed
> Transaction 0x1574004493ed3f2bb5dd29d673d6738d2ee192379edfaa563d523f69d7c108e0 finalized and a latest-final read shows VC-000003.

This is the app's own success state (`verified`): finality, then its own matching latest-final read. It agrees with the independent verification in §5.

---

## 5. Finality and contract state

| Evidence | Value |
|---|---|
| Status | **FINALIZED**, `result_name` **MAJORITY_AGREE** |
| Validator votes (last round) | `AGREE, AGREE, AGREE, IDLE, IDLE`: a majority of the validators that voted agreed |
| Leader receipt | execution `SUCCESS`, result `return` `"VC-000003"` |
| `get_case_count` | **3** at latest-final and at latest-nonfinal (was 2) |
| `get_party_case_ids(0x16fD…105A)` at latest-final | `["VC-000003"]`, total 1 (was empty) |
| Account nonce (latest) | `0x1` (was `0x0`) |

**`get_case("VC-000003")` at latest-final:**

| Field | Value | Matches review |
|---|---|---|
| claimant | `0x16fD571ae717F92b5e43597d813267C8d15f105A` | ✔ |
| respondent | `0xf1c710a1…0001` | ✔ |
| category | `OTHER` | ✔ |
| title | `FICTIONAL TEST - VeriCourt browser-wallet write 2026-10-19T06:05:25` | ✔ |
| agreement_summary, expected_deliverable, claim, requested_remedy | the four reviewed fictional texts, verbatim | ✔ |
| issues | `[I1 "FICTIONAL - placeholder issue for a browser-wallet write test"]` | ✔ |
| reply_window_seconds | 3600 | ✔ |
| status / response_state | `AWAITING_RESPONSE` / `PENDING` | as expected for a new case |

**Exactly one new case;** no duplicate.

**Logs** (`integration-logs/`):
- `phase-3-6-exact-tx-20261019T063421Z.json` (pre-sign review);
- `phase-3-6-live-result-20261019T064010Z.json` (post-sign verification);
- earlier preflight logs `phase-3-6*-…`;
- watcher logs `phase-3-6-live-watch-…` (pre-sign only).

---

## 6. Deviations, errors and risks

### 6.1 Defect found and fixed: explicit connection lost to a wallet event race

- **Symptom:** "Sign in wallet" stayed disabled with "Press Connect on the Wallet page in this tab first", although the operator had pressed Connect.
- **Cause:** a Phase 3.5C reducer bug. The wallet emitted `accountsChanged` (or `chainChanged`) **while** `eth_requestAccounts` was resolving. The app treated the event as newer and **discarded the Connect result**, so the explicit-connection grant was never recorded. My Phase 3.5C tests had covered only Connect with no concurrent event.
- **Diagnosis:** reproduced against the real reducer, without the wallet.
- **Fix** (approved by the operator; `wallet/walletState.ts`): a new `connectGrant` field records the account a Connect request actually returned, even when superseded. The connection is explicit only while the shown account equals it, compared case-insensitively. **It is not a weakening:**
  - the grant is cleared by a switch to another account (switching back doesn't restore it), disconnect, Forget, a rejected or failed Connect, a new Connect, and reloads;
  - passive reads never grant.
- **Evidence:**
  - **14 new tests:** 5 race orderings, 8 negative cases, and 1 end-to-end UI test with an event-emitting wallet;
  - **the old behaviour makes the race and UI tests fail;**
  - **mutation check 7/7.** Two misses on the first run, a vacuous letter-case test and an untested Forget path, were fixed with stronger tests;
  - **full gate:** 616 tests, typecheck, lint, ordinary build, 0 write-path strings.

### 6.2 The wallet changed the gas limit

- **What happened:** the signed transaction has gas **750,000**, versus the SDK request's 500,000 estimate.
- **Effect:** none here. The gas price is 0, so the fee is 0.
- **Why it matters:** it confirms the known residual risk that **the wallet can alter fields after the guard has checked the request**. The guard verifies the request; only the operator's comparison and post-hoc verification (§4.2) cover what was signed.

### 6.3 RPC rate limit, self-inflicted

- **What happened:** my read-only watcher (about 24 reads a minute) hit StudioNet's "Rate limit exceeded: 500 requests per hour" on `gen_call`. It was stopped at once, and the test paused until the limit had cleared.
- **Effect on the test:** none. Nothing was sent, and no app state was touched.
- **Lesson:** polling must stay well under 500 per hour per IP. The app's own monitoring polls every 10 s; a 30-minute wait is about 180 requests, so it should be budgeted together with any parallel tooling.

### 6.4 Auto-started preview servers

- **What happened:** the desktop app started preview servers by itself, from my local `.claude/launch.json`, twice. Once it occupied port 5173 just before the experiment server was due to start. Both were the unarmed or ordinary builds.
- **Action:** stopped, and `.claude/launch.json` deleted before the test.

### 6.5 Approvals

- **First title:** approved, not signed. The approval was voided by a reload.
- **Revision 2:** the operator **signed without sending a separate "approved" message**. Post-hoc, §4.2 shows the signed bytes match revision 2 exactly.

### 6.6 Title regeneration

Each reload or route change regenerated the title, which forced re-review twice. This is correct behaviour, but it adds friction. It's a candidate for a UX change, for example fixing the title for a session (§8).

### 6.7 Earlier anomaly

The one-off 544 / 27 test-count run (Phase 3.6 readiness) did not recur. Every later run gave 600, and then 614 / 616 after the fix.

### 6.8 Unresolved risks

1. Wallet-side field changes, see §6.2.
2. The safety record is per browser profile.
3. StudioNet doesn't reject duplicate raw transactions or validate nonces. Mitigated by the guard plus duplicate-case detection.
4. ~~The panel's final display~~: confirmed (§4.4).

---

## 7. Checklist status (`PHASE_3_6_BROWSER_WALLET_TEST_CHECKLIST.md` §3)

| Item | Status |
|---|---|
| 3.1 Browser and wallet prerequisites | **PASS** (operator-reported; empty account and nonce 0 verified by RPC) |
| 3.2 StudioNet network / chain 61999 | **PASS**: the wallet page and review page showed "on StudioNet"; signed chain ID 61999 |
| 3.3 Test contract confirmed | **PASS**: banner and Contract row as reported; code hash verified; StudioNet routed to `0x3258…6220` |
| 3.4 Fictional case fields inspected | **PASS**: the operator supplied the title; fields reconciled and read back identical |
| 3.5 Wallet prompt matches | **PASS, with one deviation**: every reviewed field matches the signed bytes; the gas limit was changed by the wallet (fee unaffected). The operator's own prompt reading was not reported in detail |
| 3.6 States recognized | **PASS**: "accepted", then "Case created and confirmed", reported by the operator; finality verified independently |
| 3.7 Uncertain-state handling | **N/A**: no uncertain state occurred |
| 3.8 Evidence recorded | **PASS**: transaction ID, case ID, finality, votes, read-back, logs |
| 3.9 Stop conditions | **PASS**: the disabled button was correctly treated as a stop and resolved by an approved fix, not a bypass |
| 3.10 After the test | **PASS**: experiment server stopped after the result was confirmed (§9); the ordinary build remains write-free (verified) |

**Overall: PASS.** The transaction was finalized and verified by a matching latest-final read.

---

## 8. Proposed Phase 3.7 acceptance-audit plan (not started)

1. **Close out Phase 3.6:**
   - record `VC-000003` in `config/testDeployments.ts` `laterWrites` and the Phase 2.17C addendum;
   - re-run the live read-only check page against the now 3-case contract.
2. **Full regression:**
   - frontend: typecheck, lint, 616+ tests, the ordinary build and its `dist/` audit, and the experiment build's gate audit;
   - Python: the contract's direct tests (454) in WSL, plus lint.
3. **Requirements traceability:** map every requirement in the build brief and product spec to its code, tests and evidence. Each one is classed as met, partly met or not met.
4. **Display-safety audit:** re-verify the Phase 2.18B rules across every page:
   - UNRESOLVED wording, the no-response notice, the claimant-only caution;
   - "a majority of the validators that voted" (and IDLE votes such as `VC-000003`'s 3/5);
   - "Assessment recorded" versus Final;
   - advisory remedies; forbidden terms.
5. **Security review:**
   - the experiment gate and its isolation;
   - wallet event handling: the new `connectGrant` and the other event orderings;
   - the duplicate and uncertain-write paths;
   - CSP and dependency audit (`npm audit`, no upgrades without approval);
   - secrets scan of the repository and logs.
6. **Residual-risk register and known limitations:** wallet field changes, per-profile safety state, StudioNet nonce and duplicate semantics, RPC rate limits, title regeneration UX.
7. **Release-readiness decision:** an MVP acceptance verdict with explicit open items. No feature work.

---

## 9. Close-out

- **Experiment server stopped** after the panel's confirmed result (checklist §3.10). The task was ended and its Vite process (PID 15520) stopped.
- **Afterwards:**
  - 0 listeners on 5173;
  - 0 Vite processes;
  - 0 watcher processes;
  - no `.env` file was ever written (the gate variables were given inline).
- **Ordinary build:** `npm run build` still contains no write path.
- **Phase 3.6: PASS.** Phase 3.7 not started.
