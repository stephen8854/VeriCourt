# Phase 3.6B: final transaction review before the live test

**Status: `BLOCKED`.** The operator's throwaway public address has not been provided. Step 3 (validate the wallet) and Step 4 (show the exact expected transaction) depend on it, and Step 3's instructions say to stop and ask for it.

Steps 1 and 2 are complete, with no discrepancies. Once the address and the review-page timestamp (§5) are received, Step 4 is ready to run.

**What this phase did not do:**
- no code changes;
- no wallet connection, account request, prompt, signature or broadcast;
- no key or seed requested.

**Live activity:** 13 read-only StudioNet calls.

---

## 1. Repository re-verification (Step 1)

| Check | Result |
|---|---|
| `PHASE_3_6_BROWSER_WALLET_TEST_CHECKLIST.md` | present |
| `PHASE_3_6_BROWSER_WALLET_TEST_READINESS.md` | present |
| `PHASE_3_5A_STAGE_A_REPORT.md` | present |
| `PHASE_3_5B_BROWSER_WALLET_PREPARATION_REPORT.md` | present |
| `PHASE_3_5C_WRITE_WIRING_REPORT.md` | present |
| Source, config, contract or test files changed since the readiness doc | **none** (`find -newer`) |
| `npx vitest run` | **600 passed / 30 files**, exactly the expected count |
| `npm run typecheck` / `npm run lint` | pass / pass |
| `npm run build` (ordinary) | pass |
| Experiment or write-path strings in `dist/` | **0** for each of these: experiment banner, acknowledgement phrase, `write-experiment`, `beginWithPreflight`, "VeriCourt write guard", `createSdkWriteClient`, `createGuardedProvider` |
| `contracts/vericourt.py` SHA-256 | `25bc9e0b2bae1a47a64a1324e54123ff132bf343d4a15d5be4e8f7d762e79333` |
| Dependencies | `genlayer-js 1.1.8`, `react` / `react-dom 19.3.1` |
| Gate constants | `WRITE_EXPERIMENT_ACK` and `EXPERIMENT_CONTRACTS = [0x3258A80A86920792354A9b7e59D5Ed2409E96220]` unchanged; `CONTRACT_WRITES_ENABLED = false` |

The 544 / 27 anomaly recorded in the readiness doc did **not** recur.

---

## 2. Test environment (Step 2)

Read-only RPC log: `integration-logs/phase-3-6b-readonly-verify-20261018T120257Z.json`.

| Requirement | Result |
|---|---|
| StudioNet chain ID 61999 | `eth_chainId` = `0xf22f` ✔ |
| Approved contract | `0x3258A80A86920792354A9b7e59D5Ed2409E96220`: the only allow-listed address. The armed gate on `127.0.0.1` resolves to it ✔ |
| Deployed bytecode | `gen_getContractCode`: 60,734 bytes. **SHA-256 = repo artifact = recorded hash = `25bc9e0b…79333`** ✔. Deploy transaction FINALIZED, `contract_address` = target ✔ |
| Ordinary build has no write path | 0 matches (§1) ✔. Enforced by `isolation.test.ts` |
| Experiment build requires every gate | five conditions in `config/writeGate.ts:43–49`; 22 gate tests pass ✔ |
| No pending or uncertain transaction, on chain | `get_case_count` = **2** at both latest-final and latest-nonfinal, so nothing is in flight. Stage A transaction `0x309c…7f09` is FINALIZED / MAJORITY_AGREE ✔ |
| No pending or uncertain transaction, operator's account | **Needs the address:** nonce latest == pending is checked in Step 3 |
| No pending or uncertain transaction, operator's browser | **Operator-only:** the review screen must appear with no status panel (checklist §3.3) |
| Only one new fictional case | Simulation (`gen_call`, no transaction) returns **`VC-000003`**. The title is timestamped, so it can't match `VC-000001` or `VC-000002`. One request per operation (guard) ✔ |
| Other | gas price `0x0`; `sim_getConsensusContract` still `0x0`; no code at `0xb7278A61…`, the same as Stage A |

### 2.1 Environment finding: an auto-started preview server

During this pass, a dev server from my local `.claude/launch.json` was **running without my starting it**: configuration "vericourt-experiment-unarmed", started 11:58:40 UTC. The desktop app appears to relaunch preview servers by itself, and the log shows an earlier "ordinary" server "stopped by the app".

**Why it was harmless:** its log shows `vite --mode write-experiment` with **no** acknowledgement phrase or contract, so the gate was disabled. It served only to the built-in browser, which has no wallet.

**Action taken:** I stopped it.

**New prerequisite:** before the live test, make sure **no** preview server is running. The experiment server needs port 5173 exclusively (`strictPort`). Optionally delete `.claude/launch.json`.

---

## 3. Read-only RPC checks performed

| # | Method | Purpose | Outcome |
|---|---|---|---|
| 1 | `eth_chainId` | chain | `0xf22f` |
| 2 | `eth_gasPrice` | gasless | `0x0` |
| 3 | `gen_getContractCode` | bytecode hash | match |
| 4 | `eth_getTransactionByHash` | deploy transaction | FINALIZED, address match |
| 5 | `eth_getTransactionByHash` | Stage A transaction | FINALIZED, MAJORITY_AGREE |
| 6 | `sim_getConsensusContract` | context | `0x0` |
| 7 | `eth_getCode` | context | `0x` |
| 8–13 | `gen_call` | `get_contract_info`, `get_case_count` ×2, `get_case` ×2, simulation | as above |

All 13 were reads. 0 were refused, 0 were send-like.

---

## 4. Expected transaction fields known now (independent of the sender)

Produced by the app's own `fictionalCase` → `createCaseArgs` → `buildWriteIntent` → `decodeAddTransactionV5`.

| Field | Value |
|---|---|
| Network / chain ID | GenLayer Studio Network (StudioNet) / **61999** (`0xf22f`) |
| Consensus entry point (wallet "To") | **`0xb7278A61aa25c888815aFC32Ad3cC52fF24fE575`** |
| Encoded VeriCourt contract (`_recipient`) | **`0x3258A80A86920792354A9b7e59D5Ed2409E96220`** |
| Function selector | **`0x27241a99`**: `addTransaction(address,address,uint256,uint256,bytes)` |
| Initial validators / max rotations | 5 / 3 |
| `leaderOnly` byte | `00` |
| Value | **0** |
| Fee | gas price **`0x0`**, so fee **0**. The gas limit is the SDK's `eth_estimateGas` result (`0x7a120` = 500,000 last time) |
| Calldata length | **740 bytes** for a title of this fixed length |
| Expected new case | **`VC-000003`**; `get_case_count` **2 → 3** |

**The nine `create_case` arguments:**

| # | Field | Value |
|---|---|---|
| 1 | respondent | `0xF1C710A100000000000000000000000000000001` |
| 2 | category | `OTHER` |
| 3 | title | `FICTIONAL TEST - VeriCourt browser-wallet write <T>` |
| 4 | agreement_summary | `FICTIONAL - no real agreement exists. Created by the VeriCourt Phase 3.5C browser-wallet experiment.` |
| 5 | expected_deliverable | `FICTIONAL - nothing was to be delivered. This record exists only to test the write path.` |
| 6 | claim | `FICTIONAL TEST RECORD - not a real dispute. No real party, work, payment or claim is involved.` |
| 7 | requested_remedy | `None - fictional test record.` |
| 8 | issues | `["FICTIONAL - placeholder issue for a browser-wallet write test"]` |
| 9 | reply_window_seconds | `3600` |

**Still to be filled in Step 4:**
- sender;
- `_sender` word;
- nonce;
- the account's baseline case list;
- the exact `<T>`;
- the full calldata and its keccak-256 and SHA-256 hashes.

---

## 5. Why the exact calldata needs one more input

The experiment panel sets the title timestamp `<T>` **when the review page loads**, in UTC to the second (`ExperimentWritePanel.tsx`, `fictionalCase(new Date().toISOString().slice(0, 19))`). The calldata, and so its hash, depends on `<T>`. It can't be fixed in advance without a code change, and code changes are excluded here.

**How the hash will be pinned exactly:**
1. You open the review page in the test profile, connect, and **do not click Sign**.
2. You send back the exact title shown, or just its `<T>`.
3. Claude runs the prepared read-only script (`scratchpad/p36/expected-tx.ts`, which uses the app's own encoding) with your address and `<T>`. It produces:
   - the full calldata and both hashes;
   - the nonce (latest and pending);
   - the gas estimate;
   - your baseline case list;
   - a simulation run as your address.
4. You approve **those exact details**. Reloading the page changes `<T>`; if that happens, step 2 must be repeated.

---

## 6. What the wallet may display differently (expected, not a mismatch)

- **"To" / "Interacting with":** `0xb7278A61…E575`, the consensus entry point, **not** the VeriCourt address. Expected for genlayer-js 1.1.8 on StudioNet; Stage A confirmed StudioNet routes by the encoded `_recipient`. The VeriCourt address appears only inside the data.
- **Data:** shown as hex, or decoded as `addTransaction`. Readable case text is not usually displayed.
- **Gas limit:** may be shown (≈500,000). The **fee must be 0**.
- **Nonce:** may be hidden unless advanced settings are on. If shown, it must equal the pending nonce from Step 4.
- **Network name:** whatever you named it. The **chain ID must be 61999**.

Anything else different from §4 and checklist §3.5 means **reject**.

---

## 7. Outstanding operator prerequisites

1. **The throwaway account's public address.** Never a key or phrase.
2. **Your confirmation of the setup:** dedicated browser profile; one wallet extension; new throwaway account with no funds; StudioNet added manually with chain ID 61999.
3. **No preview server running** before the experiment server starts (§2.1).
4. **The review-page title timestamp `<T>`**, after loading the page without clicking Sign (§5).
5. **Explicit approval of the exact Step 4 details**, as a separate message, before any wallet prompt.

---

## 8. Residual risks

- **The wallet decides what it signs.** It may alter the fee, nonce or type. Only your comparison against §4 and §6 catches this.
- **StudioNet doesn't reject duplicate raw transactions.** A wallet rebroadcast is unlikely (receipts are immediate). If two matching cases appear, the app reports ambiguity rather than success.
- **The page must stay unreloaded between review and approval.** A reload changes `<T>` and so the calldata.
- **The app auto-starts preview servers** (§2.1). Harmless here, but the server must be checked before the test.

---

## 9. Status

**`BLOCKED`: awaiting the operator's public address** (then the page timestamp) to complete Steps 3–4. Nothing has been or will be sent in this phase.
