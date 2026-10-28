# Phase 4.1: live test review, `process_reply_deadline` on VC-000003

**Date:** 2026-10-20.

**Approved by you:** one live `process_reply_deadline` on `VC-000003`, test contract `0x3258A80A86920792354A9b7e59D5Ed2409E96220`, throwaway wallet `0x16fD571ae717F92b5e43597d813267C8d15f105A`.

**Status: PASS.** The approved transaction was sent once, from your throwaway wallet, and was verified end to end (§8). Before that, revision 2 had been ready for your approval of the exact transaction (§7).

**Revision 1** found the blocker: StudioNet's write simulation runs behind real time (§2). You approved the fix (§3) on 2026-10-20. It is implemented and tested (§6), and the read-only review was re-run against the corrected preflight.

**What I did:** only read-only requests: 10 for the review, then 4 diagnostic `gen_call` simulations. No wallet, no signature, no transaction.

**Logs:** `integration-logs/phase-4-1-live-review-20261020T052440Z.json`.

## 1. Read-only checks (all pass except the simulation)

| Check | Result |
|---|---|
| RPC chain | `0xf22f` (61999) ✔ |
| Gas price | `0x0` ✔ |
| Deployed code SHA-256 | `25bc9e0b…79333` = repository = expected ✔ |
| Write gate, as the armed localhost build would evaluate it | enabled; allow-list = `[0x3258…6220]` ✔ |
| Wallet nonce latest / pending | `0x1` / `0x1`: no pending transaction ✔ (1 = the Phase 3.6 write) |
| `VC-000003` at latest-final = latest-nonfinal | identical ✔ |
| Caller's role | `claimant` = `0x16fD…105A`, so the caller is a party ✔ |
| State | AWAITING_RESPONSE / PENDING, not locked, 0 evidence, history 1 entry (`CASE_CREATED`) ✔ |
| Deadline | `reply_deadline` 1792395515 = **2026-10-19 07:38:35 UTC**; checked at 2026-10-20 05:24:41 UTC, **about 21.8 h past** ✔ |
| **Simulation of `process_reply_deadline` from the wallet** | **✘ `[EXPECTED] reply deadline has not passed`** (at both latest-nonfinal and latest-final) |

## 2. Why the simulation fails

The contract's `_now()` is the transaction timestamp. Read-only probes (gen_call simulations, no transaction):

| Probe | Result | Meaning |
|---|---|---|
| `process_reply_deadline("VC-000003")` | `[EXPECTED] reply deadline has not passed` | The simulation's clock is **at or before** 07:38:35 UTC on 19 Oct |
| `submit_evidence("VC-000003", TEXT, …)` | **returns `E1`** | Evidence is accepted only while now ≤ deadline, so the simulation's clock is before the deadline |
| `submit_reply` by the claimant | `[EXPECTED] only the respondent can reply` | Error decoding works; the failure above is the deadline rule, not a role problem |

**Conclusion:** StudioNet's `gen_call` write simulation evaluates time-dependent rules with a clock earlier than real time. Its exact value is not exposed.

**Real transactions use the real time.** Phase 2.17C sent `process_reply_deadline` on `VC-000001` at 08:05:40 UTC, 2 min 17 s after its deadline. It FINALIZED with the record locked, as `#/case/VC-000001` shows.

**Consequences for the app as built:**
- **`process_reply_deadline`:** the preflight requires a successful simulation, so it will always refuse while StudioNet's simulation clock lags. The app fails safe: nothing is sent, but the action can never be used.
- **`submit_evidence` / `submit_reply` after the deadline:** the simulation passes, so the preflight would let the write through. The real transaction would then revert on chain: no state change, but a wasted failed transaction. The case page already shows these actions as unavailable after the deadline (device clock), so a user would have to go out of their way to hit this.

## 3. Proposed fix (needs your approval: it changes write preflight checks)

Use the device clock, with a safety margin, for the deadline rule instead of the simulation's clock. Everything else stays:
- every other preflight check;
- the guard;
- the one-request rule;
- the write-ahead record;
- the effect verification.

| Method | Today | Proposed |
|---|---|---|
| `process_reply_deadline` | simulation must succeed | **No simulation**, as already for `request_assessment`. Instead: all fresh read checks (party, AWAITING / PENDING, no non-final changes), **and** the device clock must be **at least 10 minutes past** `reply_deadline` |
| `submit_evidence`, `submit_reply` | simulation must succeed | Simulation **kept** (it still checks role, state, quotas and input). **Added:** refuse when the device clock is within 10 minutes of the deadline or past it |

**What could still happen:** if StudioNet's transaction clock were also behind, the `process_reply_deadline` transaction would revert. The result would be "finalized without recording the missed deadline": no state change, the case is unchanged, and the write is not repeated automatically. Phase 2.17C's evidence makes this unlikely.

**Delivery:** tests for each rule, and the mutation check re-run on these lines. Then I re-run this read-only review against the corrected preflight and give you the final exact-transaction table for approval.

## 4. The transaction that would be sent (for reference, unchanged by the fix)

Built by the app's own code (`processDeadlineSpec` + `buildWriteIntent`):

| Field | Value |
|---|---|
| From | `0x16fD571ae717F92b5e43597d813267C8d15f105A` |
| To (consensus entry point) | `0xb7278A61aa25c888815aFC32Ad3cC52fF24fE575` |
| Value | 0 |
| Gas price | 0 |
| Chain | 61999 |
| Nonce | 1 (if nothing else is sent from this wallet first) |
| Selector | `0x27241a99` (`addTransaction`) |
| Encoded sender / recipient | `0x16fd…105a` / `0x3258a80a…e96220` (the VeriCourt test contract) |
| Validators / max rotations | 5 / 3 |
| Call | `process_reply_deadline("VC-000003")`, `leaderOnly` false |
| Calldata | 260 bytes, keccak `0x416eef00b0aa0e686e2d6517447c9524dce37339df6c7e86cf54a2c83eb6e339` |

**Expected effect:**
- `VC-000003` response becomes NO_RESPONSE_BY_DEADLINE;
- the record locks (`REPLY_WINDOW_EXPIRED`);
- the status becomes READY_FOR_ASSESSMENT;
- history gains `REPLY_WINDOW_EXPIRED` and `SNAPSHOT_LOCKED`.

The app counts it as success only after finality **and** a latest-final read showing NO_RESPONSE_BY_DEADLINE.

## 5. Revision 1 options (superseded)

You chose to approve the fix.

## 6. The fix, as implemented (revision 2)

**Margin:** `DEADLINE_MARGIN_SECONDS = 600` (`cases/actions.ts`), shared by the case page and the write preflight.

| Method | Preflight now (`experiment/createCaseFlow.ts`) |
|---|---|
| `process_reply_deadline` | **No simulation.** Fresh reads: party; AWAITING / PENDING; identical at both variants. Plus the device clock must be at least 10 minutes past `reply_deadline` |
| `submit_evidence`, `submit_reply` | Simulation kept. Plus a refusal when the device clock is past the deadline or within 10 minutes of it |
| Case page | Offers the deadline action only from deadline + 10 min, and evidence or reply only until deadline − 10 min |

**Tests:**
- new tests cover the lagging simulation, both margins, the exact boundary, an unreadable deadline, and evidence or reply after the deadline;
- **mutation check: 8/8 caught** (D1–D8);
- **full regression: 794 tests / 39 files pass**, plus typecheck, lint and build;
- the ordinary `dist/` still has **0** write-path strings.

**Re-run of the read-only review**, 2026-10-20 05:35:29 UTC, 11 requests, log `integration-logs/phase-4-1-live-review-20261020T053529Z.json`:

| Check | Result |
|---|---|
| Chain / gas price / code hash / gate | `0xf22f` / `0x0` / `25bc9e0b…79333` match / enabled for `0x3258…6220` ✔ |
| Wallet nonce latest = pending | `0x1` = `0x1`: no pending transaction ✔ |
| `VC-000003` | identical at both variants; AWAITING_RESPONSE / PENDING; unlocked; claimant `0x16fD…105A` ✔ |
| Deadline | 79 014 s (about 21.9 h) past; margin 600 s ✔ |
| **The app's own `processDeadlineSpec(…).check`, run read-only** | **passes**: effect `{kind: process_reply_deadline, caseId: VC-000003}`, no simulation ✔ |
| Exact transaction | **byte-identical to §4**: calldata keccak `0x416eef00…e339`, nonce 1 ✔ |

## 7. Approve the exact transaction

If you approve, reply **"approved"** (it covers exactly the §4 transaction: `process_reply_deadline("VC-000003")` from `0x16fD…105A`, nonce 1).

**What happens after your approval:**
1. You start the experiment build, or ask me to, from `frontend/`:

   ```bash
   VITE_VERICOURT_WRITE_EXPERIMENT=I-UNDERSTAND-THIS-SENDS-ONE-REAL-STUDIONET-TRANSACTION VITE_VERICOURT_CONTRACT_ADDRESS=0x3258A80A86920792354A9b7e59D5Ed2409E96220 npx vite --mode write-experiment
   ```

2. In your test browser profile, open `http://127.0.0.1:5173/#/wallet` and press **Connect** with `0x16fD…105A`; check that it shows chain 61999.
3. Open `http://127.0.0.1:5173/#/review?action=process_reply_deadline&case=VC-000003`.
4. **On the review screen, check:**
   - no status panel above it (no earlier unresolved write);
   - `process_reply_deadline`;
   - case `VC-000003`;
   - contract `0x3258…6220`;
   - your account.

   Tick the box, then press **Sign in wallet** once.
5. **Check the wallet prompt; reject on any difference:**

   | Field | Expected |
   |---|---|
   | Request type | a transaction (not a signature or network request) |
   | Origin | `127.0.0.1:5173` |
   | Network | 61999 |
   | From | `0x16fD…105A` |
   | To | `0xb7278A61aa25c888815aFC32Ad3cC52fF24fE575` |
   | Value | 0 |
   | Fee | 0 |
   | Data | starts `0x27241a99` |
   | Nonce, if shown | 1 |
   | Gas limit | may be raised by the wallet (seen in Phase 3.6) |

6. **Approve once.** Don't use speed-up or cancel. Leave the tab open until it shows **"Missed deadline recorded and confirmed"**.
7. **If anything is uncertain:** don't retry. Use **Run read-only check** and tell me what the panel says.

**Stop conditions:**
- any mismatch;
- a second prompt;
- any preflight refusal (nothing was sent);
- a status panel present before you start.


## 8. Result (2026-10-20)

**Run:**
- You approved, and I started the experiment build (127.0.0.1:5173).
- You connected, loaded `VC-000003`, reviewed, and signed once in the wallet.
- The panel showed: **"Missed deadline recorded and confirmed. Transaction `0x7ce4c93288cb1fe33b2590c1525c3fba982c58e564f81872f4dbb92f92e6fde7` finalized and a latest-final read shows VC-000003 records that no reply was received before the deadline."**

**Problems before signing, none of which sent anything:**
1. The old Phase 3.6 settled result was shown first; you cleared it.
2. One read-only case load failed with "Failed to fetch"; the retry worked.
3. "Sign in wallet" stayed disabled after a page reload, because the explicit Connect is per page session. My earlier "press F5" instruction caused this.
4. The case ID had to be entered after navigating from the menu.

**Verified read-only** (log `integration-logs/phase-4-1-live-result-20261020T060129Z.json`):

| Check | Result |
|---|---|
| Transaction status | **FINALIZED, MAJORITY_AGREE**; last round AGREE ×3, IDLE ×2; leader execution SUCCESS |
| Hash = GenLayer `tx_id` = keccak(signed bytes) | ✔ |
| Recovered signer / from | `0x16fD571ae717F92b5e43597d813267C8d15f105A` ✔ |
| Signed: type, chain, to, nonce, value | legacy, 61999, `0xb7278a61…e575`, **1**, 0 ✔ |
| Signed: selector, size | `0x27241a99`, 260 bytes ✔ |
| **Signed calldata keccak** | `0x416eef00…e339` = **the reviewed value** ✔ |
| Gas limit | 750 000: raised by the wallet, as in Phase 3.6; fee 0 |
| Stored recipient | `0x3258A80A…6220` (the test contract); 5 validators, 3 rotations |
| Wallet nonce after | 2: exactly one transaction sent |
| `VC-000003` at latest-final = latest-nonfinal (05:59 UTC) | READY_FOR_ASSESSMENT / NO_RESPONSE_BY_DEADLINE; locked (`REPLY_WINDOW_EXPIRED`, 0 items); history 3 entries; `REPLY_WINDOW_EXPIRED` and `SNAPSHOT_LOCKED` by `0x16fD…105A` at 1792475902 (2026-10-20 05:58:22 UTC) ✔ |

**Confirmed:** the transaction ran with the **real** time, unlike StudioNet's simulation clock. That validates the revision 2 fix.

**New finding:** StudioNet also enforces **30 requests per minute** per client: HTTP 429, "Rate limit exceeded: 30 requests per minute". My post-check reads hit it right after your page's monitoring.

**Likely explanation:** a 429 from the browser is probably what the page reported as "Failed to fetch". A 429 response without CORS headers is reported by the browser as a network failure.

**Current budget:**
- case page: about 11 reads per load (3 for the contract check, once per session);
- monitoring: about 6 per minute.

Repeated reloads within a minute can exceed the limit. A follow-up could make the page say "StudioNet may be rate-limiting (30 requests/minute); wait a minute", and space its reads. Not done yet.

**Recorded:**
- `config/testDeployments.ts` `laterWrites` gains the Phase 4.1 entry;
- the `VC-000003` timeline and report now list `process_reply_deadline` `0x7ce4…fde7` (recorded test run).

**Cleanup:** the experiment server was stopped (port 5173 closed). Nothing committed.

**`VC-000003` is now ready for an assessment.** The next live test could be `request_assessment` on it, after a separate review and your approval. Note that it has no evidence, so an INCONCLUSIVE outcome is the likely result.
