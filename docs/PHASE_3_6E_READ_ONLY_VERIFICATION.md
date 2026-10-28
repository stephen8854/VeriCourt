# Phase 3.6E: wallet-specific read-only verification

**Status: `READY FOR BROWSER-SESSION PREPARATION`.**

**What this phase did not do:**
- no wallet access, `eth_requestAccounts`, prompt, signature, broadcast or deployment;
- no server start, stop or restart;
- no change to source, configuration, dependencies, allow-list, browser storage or gates;
- no key or phrase requested.

**Live activity:** 28 StudioNet RPC requests, all read-only (§2.1).

**Evidence labels used below:**
- **[Live]:** observed by RPC in this phase (2026-10-18, 21:25–21:28 UTC);
- **[Code]:** a fact read from the current repository;
- **[Hist]:** a value from earlier reports, shown for comparison only;
- **[Est]:** an estimate.

---

## 1. Repository status

- **Required reports:** all present:
  - `PHASE_3_6D_FINAL_PREFLIGHT.md`
  - `PHASE_3_6C_WALLET_PREFLIGHT.md`
  - `PHASE_3_6B_TRANSACTION_REVIEW.md`
  - `PHASE_3_6_BROWSER_WALLET_TEST_CHECKLIST.md`
  - `PHASE_3_5C_WRITE_WIRING_REPORT.md`
- **Files changed since `PHASE_3_6D_FINAL_PREFLIGHT.md`:** none (`find -newer` over `frontend/src`, `frontend/scripts`, `vite.config.ts`, `package.json`, `package-lock.json`, `tsconfig.json`, `eslint.config.js`, `contracts`, `tests`, `.claude`).
- **Last full gate:** Phase 3.6B: 600 tests / 30 files, typecheck, lint, ordinary build clean. Not re-run here; nothing has changed since. It is repeated before the live test.
- **Ports:** 0 listeners on 5173 / 4173 (passive `Get-NetTCPConnection`; nothing started or stopped).
- **Scratchpad only:** the read-only check scripts live in the session scratchpad (`p36/verify.ts`, `p36/expected-tx.ts`, `p36/sim-as.ts`). They import the app's own modules and send every request through the repository's Stage A bounded fetch (`scripts/stage-a/shared.ts`: method allowlist, 20 s abort per request, ≥ 300 ms spacing, request log). They are not repository changes.

---

## 2. Read-only RPC checks

### 2.1 Methods called, and why each is read-only

| Method | Calls | Why it cannot submit a transaction |
|---|---|---|
| `eth_chainId`, `eth_gasPrice`, `eth_getBalance`, `eth_getTransactionCount`, `eth_getCode` | 2, 2, 1, 2, 1 | Standard JSON-RPC state reads; they take no signed payload |
| `gen_getContractCode` | 2 | Returns stored contract source |
| `eth_getTransactionByHash` | 2 | Lookup by hash |
| `sim_getConsensusContract` | 1 | Returns consensus contract info (deprecated; address `0x0`) |
| `gen_call` | 15 | GenLayer docs: "Executes a new message call immediately **without creating a transaction**" (`full-docs.txt` 17455). Used both for view reads (`type: "read"`) and for one write **simulation** (`simulateWriteContract`, `type: "write"`, `dist/index.js` ~640–658). The case count was read before and after the simulation: **2 → 2** at both variants, so nothing persisted |

**Totals:**
- 28 requests in three runs (account checks 10, contract verification 13, simulation 5);
- every one HTTP 200 with no RPC error;
- **0 refused, 0 send or sign methods**.

`eth_sendTransaction`, `eth_sendRawTransaction` and all signing methods are absent from the allowlists, so they would be refused before leaving the process.

**Logs** (`integration-logs/`, git-ignored):
- `phase-3-6d-account-checks-20261018T212515Z.json`
- `phase-3-6e-readonly-verify-20261018T212729Z.json`
- `phase-3-6e-sim-as-sender-20261018T212729Z.json`

### 2.2 Results

| # | Check | Result |
|---|---|---|
| 1 | Chain ID | [Live] `eth_chainId` = **`0xf22f` (61999)** ✔ |
| 2 | Deployed bytecode exists | [Live] `gen_getContractCode(0x3258…6220)` returns **60,734 bytes** ✔ |
| 3 | Bytecode hash | [Live] SHA-256 = **`25bc9e0b2bae1a47a64a1324e54123ff132bf343d4a15d5be4e8f7d762e79333`** = [Code] SHA-256 of `contracts/vericourt.py` = [Code] `PHASE_2_17C_NO_REPLY.expectedCodeSha256` ✔ |
| 4 | Deployment transaction `0x4557…1567` | [Live] FINALIZED; `contract_address` = `0x3258A80A86920792354A9b7e59D5Ed2409E96220` ✔ |
| 5 | Case count | [Live] **2** at latest-final **and** 2 at latest-nonfinal ✔ (equal, so no case creation is in flight on this contract) |
| 6 | Existing cases | [Live] `VC-000001` "[VeriCourt integration test - fictional data] Three blog articles", claimant `0xb111…AEF8`, DECIDED. `VC-000002` "FICTIONAL TEST - VeriCourt Phase 3.5A Stage A write check", claimant `0x96E2…26B0`, AWAITING_RESPONSE |
| 7 | Stage A transaction `0x309c…7f09` | [Live] FINALIZED, MAJORITY_AGREE ✔ |
| 8 | Gas price | [Live] `0x0`. This is the RPC's answer, **not** proof of the fee the wallet will show |
| 9 | Address format | `0x16fD571ae717F92b5e43597d813267C8d15f105A`. Format ✔; **EIP-55 checksum valid** ✔ (viem `isAddress`, strict); not the zero address; not the fictional respondent; not the Stage A sender ✔ |
| 10 | Balance / nonce | [Live] balance **`0x0`**; nonce **latest `0x0`, pending `0x0`** |
| 11 | Account's cases | [Live] `get_party_case_ids(0x16fD…105A, 0, 50)` = `{case_ids: [], total: 0}` at latest-final **and** latest-nonfinal |
| 12 | App recovery record / uncertain-write lock | **NOT VERIFIED.** It lives only in the operator's test-profile browser storage for `http://127.0.0.1:5173` and cannot be read without that browser. Not accessed, not modified. Checked at the next step by the operator: the review screen must appear with **no status panel** above it ([Code] `ExperimentWritePanel.tsx`, `record === null ? <WriteConfirmation…>`) |
| — | Context | [Live] `sim_getConsensusContract` = `0x0`; `eth_getCode(0xb7278A61…)` = `0x`. The same as Stage A |
| — | Gate, as the armed build would evaluate it on `127.0.0.1` | [Code] enabled → `0x3258A80A86920792354A9b7e59D5Ed2409E96220` only |

**What the account evidence supports:**
- nonce 0 (latest = pending);
- balance 0;
- no cases at either variant;
- the contract-wide case count is equal at final and non-final.

This is **consistent with** a fresh account with nothing in flight from it on this contract.

**What it does not prove:** StudioNet records nonces but does not validate them (Stage A source review). So this is **not** proof that no transaction from the account is pending anywhere. It is the strongest available read-only evidence, and the in-app preflight re-checks it at click time.

---

## 3. Transaction builder (Step 3)

[Code], current repository:

- **Title:** `ExperimentWritePanel.tsx:84`:

  ```ts
  useState(() => fictionalCase(new Date().toISOString().slice(0, 19)))
  ```

  The title is `FICTIONAL TEST - VeriCourt browser-wallet write <T>` (`:39`), with `<T>` the page-mount time in UTC, to the second.
- **Other eight fields:** constants in `fictionalCase`.
- **Encoding chain:** `createCaseArgs` → `buildWriteIntent` (`write/intent.ts`, via genlayer-js's own `abi.calldata` / `abi.transactions` helpers) → V5 `addTransaction` (`write/addTransaction.ts`). The guard compares the SDK's actual request with this byte for byte.
- **Can the exact nine fields be reconstructed now?** **No.** Field 3 depends on a page mount that has not happened. It is regenerated on every reload **and** every navigation away from `#/review` and back (`App.tsx` unmounts the page on route change). It cannot be obtained without starting the experiment server and opening the page in the test profile. **No timestamp was invented**, and none from another browser session is usable.

---

## 4. Simulation and expected transaction (Step 4)

**Simulation as the supplied address.** [Live] `simulateWriteContract(create_case)` with **account `0x16fD…105A`** returned **`VC-000003`**.

**Limitations:**
- It used the existing **Stage A fictional arguments** (`scripts/stage-a/shared.ts`), not the experiment title, because that title does not exist yet. It shows the contract accepts this address as claimant with valid fictional fields. It is **not** a simulation of the exact final calldata.
- `VC-000003` is the **expected** next ID. It is **not guaranteed**: any other `create_case` landing first would change it.
- No state persisted: case count 2 → 2.

**Expected transaction:**

| Field | Value | Basis |
|---|---|---|
| Sender | `0x16fD571ae717F92b5e43597d813267C8d15f105A` | supplied; checksum verified |
| Chain ID | 61999 (`0xf22f`) | [Live] |
| Destination (wallet "To") | `0xb7278A61aa25c888815aFC32Ad3cC52fF24fE575` | [Code] genlayer-js 1.1.8 studionet constant; [Hist] Stage A: StudioNet routes by the encoded recipient |
| Encoded VeriCourt contract | `0x3258A80A86920792354A9b7e59D5Ed2409E96220` | [Code] the intent's `_recipient`; the guard enforces it |
| Function selector | `0x27241a99` (`addTransaction(address,address,uint256,uint256,bytes)`) | [Code]; [Hist] StudioNet's own ABI matches |
| Validators / rotations / `leaderOnly` | 5 / 3 / `00` | [Code] |
| Decoded arguments | fields 1–2 and 4–9 fixed (`PHASE_3_6B` §4); **field 3 pending `<T>`** | [Code] |
| Nonce | **0** (latest = pending = 0). The in-app preflight re-reads it under the lock and pins the pending value | [Live]; re-checked at click time |
| Value | **0** | [Code] the guard refuses anything else |
| Fee | Requested gas price **0** ([Live] RPC `0x0`; [Code] the guard refuses non-zero). Gas limit = the SDK's `eth_estimateGas` at send time ([Hist] `0x7a120` = 500,000). **The fee the wallet will display is NOT VERIFIED and is wallet-dependent** | [Est] |
| Full calldata / byte length / hash | **NOT AVAILABLE**: they need `<T>`. [Hist] expected length 740 bytes for this title format; computed with the app's own encoder, and the reconstructed title must equal the displayed title character for character | — |
| Expected case / count | **`VC-000003`** (not guaranteed); `get_case_count` **2 → 3**; the account's case list **0 → 1** | [Live] simulation; [Est] |

---

## 5. Unverified items

1. **App recovery record or uncertain-write lock** in the operator's browser (§2.2 #12).
2. **The exact title `<T>`**, and so the full calldata and hash (§3).
3. **The wallet's displayed fee, gas limit and nonce:** visible only in the eventual prompt.
4. **That the account has no pending transaction anywhere:** consistent evidence only (§2.2).

---

## 6. Anomalies and blockers

- **Blockers:** none for the next step.
- **Anomaly carried forward:** the one-off 544 / 27 test count from the Phase 3.6 readiness pass. It has not recurred (600 / 30 in Phase 3.6B, three runs). A fresh 600 / 30 run remains a precondition before the live test.

---

## 7. Server decision (Step 5): proposal only, **not started**

**Do the prerequisites justify a separately authorized browser-session preparation step? Yes.**

| Item | Value |
|---|---|
| Command | in `frontend/`: `npx vite --mode write-experiment` |
| Environment | `VITE_VERICOURT_WRITE_EXPERIMENT=I-UNDERSTAND-THIS-SENDS-ONE-REAL-STUDIONET-TRANSACTION`, `VITE_VERICOURT_CONTRACT_ADDRESS=0x3258A80A86920792354A9b7e59D5Ed2409E96220` (inline; no `.env` file is written) |
| Bind address / port | **`127.0.0.1:5173`** (`vite.config.ts`: `host: "127.0.0.1"`, `strictPort: true`; it fails rather than moving port) |
| Gates enabled | mode `write-experiment` ✔; exact acknowledgement phrase ✔; contract on the allow-list ✔; host must be `127.0.0.1` / `localhost` / `[::1]` ✔; `CONTRACT_WRITES_ENABLED` still `false` ✔ |
| Gates that still hold after the start | explicit Connect in that tab; review plus acknowledgement plus one click; preflight under the cross-tab lock; write-ahead record; one-request guard; finality plus a latest-final read for success |

**Before starting, Claude would:**
1. re-run `npm test` (expecting 600 / 30);
2. confirm 5173 is free.

**After starting, Claude would confirm the listener is `127.0.0.1:5173` only, and then you would:**
1. connect on `#/wallet`;
2. open `#/review`;
3. confirm there is no status panel;
4. send the exact title;
5. **not tick the box, click Sign, reload or navigate away.**

**This needs your explicit confirmation.**

---

## 8. Confirmation

In this phase:
- no wallet action, `eth_requestAccounts`, signing prompt, signature, transaction or deployment;
- no server start, stop or restart;
- no change to source, configuration, dependencies, allow-list, gates or browser storage.

---

## Status

**`READY FOR BROWSER-SESSION PREPARATION`.** Awaiting your explicit confirmation to start the experiment server as proposed in §7.
