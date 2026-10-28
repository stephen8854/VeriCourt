# Phase 3.5C: guarded write wiring (no live submission)

**Status:** the first end-to-end browser-wallet write flow (`create_case`) is wired and tested offline. It connects these pieces:
- the review screen;
- a fresh preflight under the cross-tab lock;
- the write-ahead record;
- the Phase 3.5A guard;
- the real genlayer-js 1.1.8 `writeContract`;
- bounded status monitoring;
- a latest-final confirming read;
- read-only reconciliation.

**What was not done:**
- no wallet request, signature or transaction;
- no deployment and no key;
- no dependency change;
- no change to the contract.

**The ordinary build has no write path.** The wiring exists only in an explicitly gated local experiment build (§2), verified at the bundle level (§9).

**SDK review (requirement 9):** the one-request guarantee holds within the guard's boundary (§4). There is no blocker.

---

## 1. Architecture

```
#/review (pages/WritePreview.tsx)
  ├─ ordinary build: import.meta.env.MODE === "write-experiment" is folded to false
  │     → disabled preview only (the experiment chunk is not in the bundle)
  └─ experiment build: lazy import → experiment/ExperimentWritePanel.tsx
        gate = evaluateWriteGate(mode, ack phrase, contract, hostname)          [config/writeGate.ts]
        WriteConfirmation (exact fields + acknowledgement + one final click)    [components/]
        └─ submitCreateCase                                                       [experiment/createCaseFlow.ts]
             1. flowBlockers: gate, explicit Connect, chain 61999, sender, case fields, ack
             2. DurableWriteSession.beginWithPreflight                             [write/durableSession.ts]
                  lock (Web Locks) → reload recovery → unresolved-record check
                  → PREFLIGHT (read-only, under the lock):
                      wallet eth_chainId + eth_accounts (passive), RPC chain, gas price 0,
                      contract code SHA-256, nonce latest == pending, party-case baseline,
                      gen_call simulation of create_case
                  → intent (fresh random op id, nonce pinned) → write-ahead record saved
             3. createGuardedProvider(wallet, guard)                               [write/guardedProvider.ts]
                createSdkWriteClient(guarded, sender ADDRESS STRING)               [experiment/sdkExperiment.ts]
             4. session.run → runGuardedWrite(deadline 240 s) → client.writeContract
                  walletWatch: account / chain / disconnect closes the operation
        └─ monitorToFinality (read-only): poll every 10 s ≤ 30 min, classify, persist each phase
             → on FINALIZED + success: latest-final read must show exactly one matching case → VERIFIED
        └─ reconcileUncertain (read-only), Check status, Clear (settled only)
```

**New files:**
- `src/config/writeGate.ts`
- `src/experiment/createCaseFlow.ts`
- `src/experiment/sdkExperiment.ts`
- `src/experiment/ExperimentWritePanel.tsx`
- `src/test/experimentHarness.ts`
- tests: `src/config/writeGate.test.ts`, `src/experiment/createCaseFlow.test.ts`, `src/experiment/ExperimentWritePanel.test.tsx`

**Modified files:**

| File | Change |
|---|---|
| `wallet/walletState.ts` | `explicitConnection`. Granted only by Connect (`eth_requestAccounts`); kept for the same account; lost on an account switch, disconnect, Forget or empty account list |
| `wallet/WalletContext.tsx` | Exposes `provider` (used only by the experiment panel, which wraps it) |
| `write/durableSession.ts` | `beginWithPreflight` (preflight under the lock, before the record); a `broken` state after a failed save, which blocks the tab for good; `WriteOutcomeNotRecorded` |
| `tx/state.ts` | `VERIFIED` may carry a detail (which transaction and case) |
| `pages/WritePreview.tsx` | The gated lazy import |
| `write/isolation.test.ts` | New rules (§9) |
| `README.md` | Experiment build section |

---

## 2. Gating mechanism

### 2.1 Build time

`pages/WritePreview.tsx` contains:

```ts
import.meta.env.MODE === "write-experiment" ? lazy(() => import("../experiment/ExperimentWritePanel")) : null
```

Vite replaces `import.meta.env.MODE` with a literal. In every ordinary build (`npm run dev`, `npm run build`, `npm test`) the branch is dead and removed, together with the experiment chunk and everything only it uses: the gate, the flow, the durable session, the guard, the lock and the SDK write client.

An isolation test pins this exact pattern. It also checks that nothing else references `src/experiment`.

### 2.2 Run time

`evaluateWriteGate` enables writes only when **all five** of these hold, and reports every condition that fails:

1. build mode `write-experiment`;
2. `VITE_VERICOURT_WRITE_EXPERIMENT` equals the exact phrase `I-UNDERSTAND-THIS-SENDS-ONE-REAL-STUDIONET-TRANSACTION` (case- and whitespace-sensitive);
3. `VITE_VERICOURT_CONTRACT_ADDRESS` is on the throwaway test-deployment allow-list (currently only `0x3258A80A…6220`);
4. the page is served from `localhost`, `127.0.0.1` or `[::1]`, so an experiment bundle copied to a server stays inert;
5. `CONTRACT_WRITES_ENABLED` is still `false`. The experiment never uses that flag, and refuses if someone flips it.

### 2.3 Why it cannot activate accidentally

| Situation | Outcome |
|---|---|
| Any ordinary command | No write path is compiled in (§9) |
| `--mode write-experiment` alone | The gate is disabled. The panel shows the failed conditions; the final button stays disabled |
| Phrase set, wrong contract or host | Disabled |
| Everything set | The panel is armed, but a write still needs every precondition in §3, including an explicit Connect and a deliberate acknowledgement and click |

---

## 3. Preconditions before a write can start (requirement 3)

| Requirement | Where it is enforced |
|---|---|
| Explicitly connected wallet | `flowBlockers`: `wallet.phase === "connected"` **and** `explicitConnection`. An account remembered from an earlier visit (passive read) is refused: "Press Connect … in this tab" |
| StudioNet, chain ID 61999 | `flowBlockers` (wallet state); the preflight (wallet `eth_chainId` and RPC `eth_chainId`); the guard before forwarding (wallet `eth_chainId`) |
| Validated sender | Address format (`flowBlockers`); preflight: wallet `eth_accounts[0]` equals the connected account; guard: `from`, encoded `_sender`, `eth_accounts[0]`; respondent ≠ sender |
| Validated contract | Gate allow-list; preflight: deployed code SHA-256 equals the reviewed contract; the guard checks the encoded `_recipient` |
| Review and acknowledgement of the exact case fields | `WriteConfirmation` (fields generated from the same object that is encoded; a Phase 3.5B test decodes the calldata back). The checkbox, then one click. `submitCreateCase` refuses unless `acknowledged` |
| Fresh preflight under the cross-tab lock | `beginWithPreflight`: lock → recovery → unresolved check → preflight → record. A test shows a second tab is refused **while the preflight runs** |
| Successful durable write-ahead record | Saved before the guard exists. The forward step is saved again (write-ahead) before the wallet call; if that save fails, nothing is sent |

**The preflight also requires:**
- gas price `0x0`;
- `nonce latest == pending` (no pending transaction from this account);
- a `gen_call` simulation of `create_case` that returns a case ID.

The pending nonce is **pinned** in the intent. If the SDK's own nonce read differs, the guard refuses before the wallet sees anything (tested).

---

## 4. One request, and the SDK's actual request behaviour (requirements 4, 9)

**What genlayer-js 1.1.8 does here** (`dist/index.js`, wallet path with an address-string account):

1. **Reads go to the RPC:** `eth_getTransactionCount` (pending), `eth_estimateGas` (200000 fallback on failure), `eth_gasPrice`.
2. **One wallet call:** `eth_sendTransaction` to `config.provider`, the guarded provider. On Studio the result is returned directly (1176).
3. **Implicit fallback paths reviewed:**

| Path | Status |
|---|---|
| **V6 fallback** (1191–1198) | Resends when the error text matches its ABI-mismatch phrases. **Refused at the guard.** Tested end to end with the real SDK: the wallet sees one request, the record shows one refusal, and the outcome is uncertain and blocks |
| **`window.ethereum` fallback** (2382) | Used only when `config.provider` is unset. `createSdkWriteClient` always sets it |
| **Account object → local-signing path** (1116) | Would bypass the wallet. `createSdkWriteClient` refuses a non-string sender. A mutation that passes an account object is caught |
| **Transport retries** | `retryCount: 0` (2425). No resend layer |
| **`connect()` / `cancelTransaction()`** | Use `window.ethereum` directly. Not called anywhere: a test scans `src/experiment` code for `window.ethereum`, signing and network-switch methods |
| **Chain check** | `assertChainMatch` returns early on Studio (2363). The guard and the preflight check the chain instead |

**The exact checked request is the forwarded one:**
- the guard copies `params[0]` before checking, and forwards **that copy**;
- tests compare what the wallet received with the intent: sender, nonce, chain, gas price, value, and decoded `_sender` / `_recipient`;
- the calldata must be byte-equal to the intent.

**No path besides the guarded provider:** the experiment module's only direct wallet calls are the passive `eth_chainId` and `eth_accounts` in the preflight (a test enforces this). Nothing in the flow retries a write.

---

## 5. Transaction-state transitions

Stored in the persistent record, so they survive reloads (`tx/state.ts` + `pendingStore.ts`):

```
idle ─PREPARE→ preparing ─REQUEST_WALLET→ awaiting_wallet
  awaiting_wallet ─WALLET_REJECTED→ rejected ·································· settled
  preparing / awaiting_wallet ─NOT_SENT→ not_sent ····························· settled
  awaiting_wallet ─SUBMITTED(hash)→ submitted
  awaiting_wallet ─SUBMISSION_UNCERTAIN→ submission_uncertain ················· UNCERTAIN
submitted ─NOT_FOUND_YET→ submitted
submitted|pending|accepted|non-final failures ─OBSERVED→ pending | accepted | execution_failed
                                   | validator_disagreement | undetermined | finalized | finalized_unsuccessful (settled)
observable ─POLL_TIMED_OUT→ timed_out_unknown ·································· UNCERTAIN
observable ─READ_FAILED (3 consecutive failures, or a contradictory status)→ read_failure ·· UNCERTAIN
finalized ─VERIFIED(detail)→ verified ·········································· settled (only success)
finalized ─VERIFICATION_MISMATCH→ verification_mismatch ························ settled
UNCERTAIN ─RECONCILED_FOUND(hash)→ submitted (monitoring resumes)
UNCERTAIN ─RECONCILED_EFFECT_FINAL→ confirmed_by_state ························· settled (limited evidence)
submission_uncertain ─RECONCILED_NOT_SENT→ not_sent ···························· settled
settled ─RESET→ idle   (only via “Clear this settled result”)
```

**What the user is told** (`statusMessage`):

| State | Message |
|---|---|
| `verified` | "Case created and confirmed", naming the transaction and the case found at latest-final |
| `confirmed_by_state` | "Case confirmed by contract state (limited evidence)": the transaction itself was never identified, so its ID and consensus details are unknown; do not repeat the write |
| `finalized` | "Finalized; confirming the case": not yet success |
| `accepted` and earlier | "Write in progress … Accepted is not final" |
| Uncertain states | "A timeout or lost connection is not proof that the write failed," plus the recovery steps (§7) |

---

## 6. Failure handling (requirement 7)

| Case | Behaviour (all tested) |
|---|---|
| Rejection (4001) | `rejected`; one prompt; settled |
| Disconnect before the forward | The watcher closes the operation; no wallet send; `not_sent` |
| Account change before the forward | Same; and `explicitConnection` is lost, so a new Connect is required |
| Account or chain change after the forward | Cannot withdraw it. Recorded in the journal; the outcome follows the wallet's result; monitoring continues read-only |
| Wrong chain | Refused before the request (wallet state, preflight, guard) |
| Malformed response | `submission_uncertain`; blocks across reloads; never auto-cleared |
| Page reload mid-operation | Recovered under the lock: no forward means `not_sent`; forwarded with no result means uncertain; a hash means `submitted` (monitoring resumes from the stored record) |
| Duplicate clicks | One `onConfirm` (UI ref); the session refuses a second operation (in progress / lock); one wallet request |
| Second tab | Refused by the lock during the operation, then by the record |
| Late response after the deadline | Persisted (`settledAfterDisarm`). Reconciliation then finds the hash, and monitoring verifies |
| SDK V6 fallback | Refused at the guard; uncertain; blocked |
| Write-ahead save fails | Nothing sent |
| Save fails after the send | `WriteOutcomeNotRecorded`; **the tab is blocked for good**; a reload recovers the last saved state as uncertain |
| Record removed mid-operation | The next save refuses to recreate it; the tab is blocked for good even though storage is empty |
| Preflight failure (any check, or a read timeout) | `WriteRefused`; nothing recorded or sent; lock released; the review must be redone, with a new acknowledgement and a new deliberate click |
| Status-read failures | 3 in a row give `read_failure` (uncertain) |
| Finality deadline (30 min) | `timed_out_unknown` (uncertain, **not failed**) |
| Finalized with disagreement or a failed execution | `finalized_unsuccessful`; never success |
| Finalized but no matching case | `verification_mismatch`; never success |
| More than one matching case | Ambiguous: stays `finalized` (blocking); not verified |
| Confirming read fails | Stays `finalized` (blocking); "Check status" resumes the read |

---

## 7. Uncertain-write lock and recovery (requirement 8)

**The block is never cleared automatically:**
- `reset()` refuses unresolved records;
- the panel offers "Clear" only for settled results;
- a read-only check that finds no positive evidence leaves the block in place (tested twice in a row).

**What the panel shows for an uncertain write:**
1. Do not try the write again: it may already have been sent.
2. Check the wallet's activity list.
3. Use **Run read-only check**. It looks up the recorded transaction and the contract's cases, and never sends anything.
4. The block lifts only on positive evidence:
   - the recorded transaction is found;
   - the intended case is final in contract state;
   - the guard proves nothing left the page;
   - the wallet explicitly rejected the request.
5. If it can never be resolved, follow the manual steps in `PHASE_3_5B_BROWSER_WALLET_PREPARATION_REPORT.md` §7.3.

---

## 8. Tests

Run on 2026-10-18 in `frontend/`:

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `tsc -p scripts/stage-a` | pass |
| `npm run lint` | pass |
| `npm test` | **600 passed / 30 files** (was 530 / 27) |

**New and updated tests:**

| File | Tests | Covers |
|---|---|---|
| `experiment/createCaseFlow.test.ts` (new) | 41 | **Real SDK end to end.** Happy path to `verified`; the exact forwarded request; pinned-nonce mismatch; 7 precondition refusals; 6 preflight refusals (RPC chain, gas, code, simulation, read timeout, pending nonce); wallet-account mismatch; preflight under the lock; rejection; V6 fallback; disconnect; account change after the forward; malformed plus reload; double click; timeout plus late hash, then reconcile and verify; write-ahead failure; save failure after the send; record removed mid-operation; finality deadline; read failures; finalized disagreement; verification mismatch; two matching cases; confirming-read failure then resume; reload during monitoring; contradictory status; `confirmed_by_state`; no auto-clear; experiment request-surface scan |
| `experiment/ExperimentWritePanel.test.tsx` (new) | 6 | **Ordinary build:** the page shows only the disabled preview. **Experiment, gate off:** reasons shown, button disabled. **Gate on:** explicit Connect required; full UI flow to "Case created and confirmed" with a double click giving one request; Clear then a fresh review; unresolved record on load showing recovery and read-only actions only; refused preflight sends nothing and resets the acknowledgement |
| `config/writeGate.test.ts` (new) | 22 | Every gate condition; the ordinary build disabled; case-insensitive contract; allow-list; tests not running in experiment mode; `explicitConnection` granted, kept and lost |
| `write/isolation.test.ts` | 6 | `src/experiment` reachable only through the one gated dynamic import (the pattern is pinned); no static import; UI write-runtime restrictions as before |
| `write/durableSession.test.ts` | 27 | Unchanged tests, now through `beginWithPreflight` |

**Mutation check:**
- **Method:** 18 safety-critical lines were broken one at a time, and the experiment, write, config and wallet tests were re-run each time. Script: `scratchpad/mutate_3_5c.py`.
- **Result: 18/18 caught.** Three (P10, P15, P18) were first **missed**, and each got a direct test:
  - **P10, two matching cases accepted as success:** no test covered it.
  - **P15, a broken tab may write again:** masked in the original test. The new test models the real case where only that check protects: the record is removed from storage mid-operation.
  - **P18, pending nonce ignored:** no test covered it.

| # | Mutation | Result |
|---|---|---|
| P1 | explicit connection not required | caught |
| P2 | wallet chain not required | caught |
| P3 | preflight skips the wallet account | caught |
| P4 | preflight skips the gas price | caught |
| P5 | preflight skips the code hash | caught |
| P6 | preflight skips the RPC chain | caught |
| P7 | nonce not pinned | caught |
| P8 | success without the confirming read | caught |
| P9 | finality deadline reported as failure | caught |
| P10 | duplicate matching cases accepted | caught (after the added test) |
| P11 | gate ignores the host | caught |
| P12 | gate ignores the acknowledgement | caught |
| P13 | gate accepts any contract | caught |
| P14 | passive read counts as explicit | caught |
| P15 | broken tab may write again | caught (after the added test) |
| P16 | write client with an account object | caught |
| P17 | preflight outside the lock | caught |
| P18 | pending nonce ignored | caught (after the added test) |

---

## 9. Build verification

| Build | Command | Result |
|---|---|---|
| **Ordinary production** | `npm run build` (output: `dist/`) | **No write path.** Zero matches for any of these strings: "Write experiment build", the acknowledgement phrase, `write-experiment`, `beginWithPreflight`, "VeriCourt write guard", `vericourt.write.lock`, `createSdkWriteClient`. No experiment chunk; the asset list is unchanged from Phase 3.5B |
| **Experiment mode, no phrase** | `vite build --mode write-experiment` (scratchpad output) | The panel chunk is present, but it compiles to `ack: void 0, contract: void 0`, so the gate is permanently disabled in that bundle |
| **Experiment mode, armed** | Phrase and test contract set (scratchpad output) | The gate inputs compile to the phrase and `0x3258…6220`. It is still inert unless served from localhost |

**Unchanged:**
- `contracts/vericourt.py` SHA-256 is `25bc9e0b…79333`;
- dependencies are `genlayer-js 1.1.8`, `react` / `react-dom 19.3.1`;
- `CONTRACT_WRITES_ENABLED = false`.

---

## 10. Remaining risks

1. **Real-wallet behaviour is untested**, and is the purpose of the live test:
   - whether the wallet accepts a 0-gas-price legacy request with `chainId`, from an empty account;
   - what `eth_sendTransaction` returns;
   - whether the wallet changes the fee or nonce in its own UI. The guard cannot see what the wallet actually signs; only the user's comparison catches it;
   - pending-request behaviour on reload.
2. **The wallet is outside the app's control:** "speed up" and "cancel" create replacement transactions outside the guard.
3. **Per-profile safety:** the safety record and lock are per browser profile. Another browser or device is not blocked.
4. **Effect check limits:**
   - reconciliation and verification rely on the case title plus respondent plus claimant after a baseline; the title includes a timestamp to make it unique;
   - there is an effect check only for `create_case`;
   - two matches are treated as ambiguous.
5. **Fixed fictional case data:** the experiment uses one fictional case (no editing UI), which keeps the reviewed data exactly predictable.
6. **Dependence on StudioNet behaviour seen in Stage A:** the consensus `to` is ignored, and nonces are recorded but not validated. A StudioNet change could alter this, so the preflight's gas and code checks stop the run if the environment differs.

---

## 11. Exact manual steps for a future single browser-wallet test

These steps are **not approved.** Each needs your explicit go-ahead.

1. **Approve** the live test explicitly: one `create_case`, fictional data, the Phase 2.17C test contract.
2. **You** create a dedicated browser profile used only for this test.
3. **You** install a wallet extension from its official store in that profile and create a **new throwaway wallet**:
   - never import a real account;
   - never share the recovery phrase with anyone, including Claude.
4. **You** add StudioNet manually:
   - RPC `https://studio.genlayer.com/api`;
   - chain ID `61999`.
5. In `frontend/`, start the experiment build, bound to localhost:

   ```bash
   VITE_VERICOURT_WRITE_EXPERIMENT=I-UNDERSTAND-THIS-SENDS-ONE-REAL-STUDIONET-TRANSACTION VITE_VERICOURT_CONTRACT_ADDRESS=0x3258A80A86920792354A9b7e59D5Ed2409E96220 npx vite --mode write-experiment
   ```

6. In the test profile, open `http://127.0.0.1:5173/#/live` and run the read-only check: it must pass.
7. Open `#/wallet` and press **Connect**:
   - confirm the throwaway account;
   - confirm chain 61999 "Matches StudioNet".
8. Open `#/review`. Check:
   - the "Write experiment build" banner names the test contract;
   - there are no blockers;
   - no unresolved write is recorded.
9. Check every case field, the network, the account and the contract. Tick the acknowledgement. Press **Sign in wallet** once.
10. In the wallet prompt, verify all of these, and **reject** on any difference:
    - StudioNet / 61999;
    - the throwaway account;
    - a fee of 0;
    - interaction with `0xb7278A61aa25c888815aFC32Ad3cC52fF24fE575`.
11. Approve once. Don't press anything again. Don't use "speed up" or "cancel".
12. Leave the tab open while the panel monitors (up to 30 min). Success is reported **only** as "Case created and confirmed", naming the transaction and the case found at latest-final.
13. **If uncertain** (deadline, error, closed tab):
    - do not retry;
    - use **Run read-only check**;
    - check the wallet's activity.

    The block stays until there is positive evidence.
14. Afterwards:
    - stop the dev server;
    - the ordinary build remains write-free;
    - record the result in a report.

**Stop conditions:**
- any mismatch in steps 7–10;
- any guard or preflight refusal (nothing was sent; investigate before any new attempt);
- any uncertain outcome (reconcile only).

---

## 12. Stop

Wiring and offline testing are complete. **Separate, explicit approval is needed before any live wallet request or transaction.**
