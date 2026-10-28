# Phase 3.5A Stage A: one guarded genlayer-js write on StudioNet

**Result:** one `create_case` was submitted **exactly once** through genlayer-js 1.1.8's local-account path.
- **Lifecycle:** PENDING → ACCEPTED (MAJORITY_AGREE) → **FINALIZED (MAJORITY_AGREE)**, at 54 s.
- **Post-finality read:** a `latest-final` read shows exactly one new case, `VC-000002`, matching the fictional intent. The state model ended in `verified`.
- **Transaction:** GenLayer transaction ID `0x309c83aab54b0408930d9c3e92a0f9037fd53a97928f5018ce8012c491487f09`.
- **Identifiers:** equal to the RPC-returned hash, the SDK's return value, and the keccak-256 of the signed bytes.

**Not done:** no retry, no other write, no deployment, no browser wallet, no Stage B, no frontend write enabled.

**Scope of this result:** it covers the **SDK local-account path only**. It says nothing about browser-wallet compatibility.

Run date: 2026-10-17 (UTC).

**Raw logs (git-ignored):**
- preflight: `integration-logs/phase-3-5a-stage-a-preflight-20261017T214643Z.json`
- write: `integration-logs/phase-3-5a-stage-a-write-20261017T215413Z.json`

---

## 1. Preflight findings

**Two read-only passes.** Both used a bounded fetch: a method allowlist, a 20 s abort per call, and at least 300 ms between calls.
- **Standalone preflight:** 12 requests, 9.4 s.
- **The write script's own mandatory prechecks:** run immediately before the write.

**Blockers:** none remained after one decision. Your instructions said both "do not generate … private keys" and to use a disposable account. I stopped and asked. You authorized one in-memory key for this single write (§1.8).

### 1.1 Target contract and identity

| Check | Result |
|---|---|
| Address | `0x3258A80A86920792354A9b7e59D5Ed2409E96220`, the Phase 2.17C throwaway test deployment (`config/testDeployments.ts`, `docs/PHASE_2_17C_NO_REPLY_STUDIONET_REPORT.md`) |
| Deployed code | `gen_getContractCode` SHA-256 = `25bc9e0b…79333`, equal to the repo's `contracts/vericourt.py` |
| Deploy transaction `0x4557…1567` | FINALIZED; `contract_address` = the target; deployer `0xb111Bd9D…AEF8` (the Phase 2.17C throwaway harness account) |
| Identity | `get_contract_info` (latest-final) returned the VeriCourt schema (`vericourt-method-v2`, the expected outcome and determination enums) |
| Baseline | `get_case_count` = 1 at both latest-final and latest-nonfinal (no pending change) |

### 1.2 Chain

`eth_chainId` = `0xf22f` (61999), checked in both passes.

### 1.3 The exact request

| Field | Value |
|---|---|
| Function | `create_case` (contract write method) |
| Sender | `0x96E2fb5A4FEa1532F14Cb70D495D55BAdd7426B0`: a fresh, single-use test account. Nonce 0 before (latest and pending), zero balance |
| EVM `to` | `0xb7278A61aa25c888815aFC32Ad3cC52fF24fE575` (genlayer-js static studionet `consensusMainContract`) |
| Selector | `0x27241a99` = `addTransaction(address,address,uint256,uint256,bytes)` |
| Encoded `_recipient` | `0x3258A80A…6220` (the target contract) |
| `_numOfInitialValidators` / `_maxRotations` | 5 / 3 (SDK defaults; the same values the Python harness used) |
| `_txData` | 570 bytes: RLP of `[GenVM calldata {method: "create_case", args: [...]}, leaderOnly]`, with leaderOnly byte `0x00` |
| Transaction | legacy (type 0), chain 61999, nonce 0, gas 500,000 (the SDK's `eth_estimateGas` result), **gas price 0**, value 0; 876 bytes signed |
| Arguments | respondent `0xF1C710A100000000000000000000000000000001` (a fictional address, never used to sign); category `OTHER`; title "FICTIONAL TEST - VeriCourt Phase 3.5A Stage A write check"; every text field begins "FICTIONAL"; one issue; `reply_window_seconds` 3600 |
| Simulation | `simulateWriteContract` (`gen_call`, which creates no transaction) returned `VC-000002` in both passes |

The guard compared the SDK's actual `signTransaction` request with this intent **byte for byte**. It then re-parsed the signed bytes and compared every field again before releasing them (§3).

### 1.4 The `leaderOnly=false` encoding difference

| | Last RLP item of `_txData` |
|---|---|
| genlayer-js 1.1.8 | `toRlp(toHex(false))`, which gives the single byte `0x00` |
| genlayer-py (Phase 2.8) | the empty string `0x80` |

The GenVM calldata is otherwise identical (Phase 3.5A offline test).

**StudioNet source, read-only, tag `v0.121.6`:** `transactions_parser.py` deserializes the flag with a custom Boolean that maps both `b""` and `b"\x00"` to `False`, with the comment "Custom logic to handle `False` as `0x00`".

**Live result:** StudioNet accepted the `0x00` form. It stored `tx_data` ending in `00`, byte-identical to our `_txData`, and reported `leader_only: false`, `execution_mode: "NORMAL"`.

### 1.5 The consensus-address discrepancy, and the actual destination

**The two values:**
- **SDK:** `0xb7278A61…` is genlayer-js's static studionet `consensusMainContract`. The SDK uses it as the EVM `to` of every write.
- **StudioNet:** `sim_getConsensusContract("ConsensusMain")` returned address `0x000…000`, plus an ABI.

**Preflight evidence:**
- `eth_getCode(0xb7278A61…)` on StudioNet = `0x`. No EVM contract exists there; Studio has no real EVM layer.
- StudioNet's own ConsensusMain ABI contains `addTransaction(address,address,uint256,uint256,bytes)` with selector `0x27241a99`, exactly what the guard pins.
- **Studio source (`v0.121.6`):**
  - `send_raw_transaction` performs **no check of the EVM `to` against any consensus address**.
  - `transactions_parser.get_genlayer_transaction` derives the transaction type and destination from the **decoded `_recipient`**. The EVM `to` is used only when the calldata does not decode as `addTransaction`; that would be a plain SEND.
  - The endpoint behind the consensus-contract lookup is marked "Deprecated: consensus contract info is now provided by genlayer-js chain config". That explains the `0x0`: it is a stale placeholder, not the routing address.
- **Docs:** "Studio intercepts and simulates the consensus pipeline rather than executing on a real EVM layer" (`full-docs.txt` 2836).

**Conclusion before the write:**
- The EVM `to` would be `0xb7278A61…`.
- The **effective destination** would be the decoded `_recipient`, `0x3258A80A…6220`, through Studio's simulated consensus.
- Caveat: the deployed StudioNet version could not be read directly, so this rested on the latest stable source plus consistent live observations.

**Live result (confirms it):**
- The signed transaction's `to` was `0xb7278a61…`.
- StudioNet stored `to_address` = `recipient` = `0x3258A80A…6220`.
- It executed `create_case` on that contract.

**Still open:**
- **Settled for StudioNet:** the discrepancy is harmless *for StudioNet*, because Studio ignores the EVM `to` for a decodable `addTransaction`.
- **Not settled elsewhere:** on a real-EVM GenLayer network the `to` address matters. Nothing here validates `0xb7278A61…` for any network other than StudioNet.
- **Still reports `0x0`:** `sim_getConsensusContract` keeps returning `0x0` and should not be used for routing.

### 1.6 One-submission guarantee for this experiment

- **The guard is the only defence against duplicates.** The read-only review of Studio's `send_raw_transaction` (`v0.121.6`) found that it **does not reject a duplicate raw transaction** and **does not validate nonces**.
- **The only channels to the network:**
  - The SDK client's account was the guarded local account, which permits **one** `signTransaction`. A second call, such as the SDK's V6 fallback, is refused without calling the key.
  - The process's `fetch` was the guarded fetch, which permits **one** `eth_sendRawTransaction`, of exactly the signed bytes, only while the operation is open. Every other non-read method is refused.
- **The key was inside the script's closure:**
  - it was used only to build the guarded signer;
  - nothing else in the script signs or sends;
  - no wallet or provider exists in the process.
- **No resend layer below the guard:** the SDK transport and viem's `sendRawTransaction` use `retryCount: 0`, and the bounded fetch never aborts a broadcast.
- **Offline tests passed beforehand:** the real-SDK fallback tests (`sdkPath.test.ts`) and 12/12 mutation checks, from the implementation phase.

### 1.7 Correlating the hash with the transaction ID, and finality

**Correlation plan, carried out:**
- the keccak-256 of the signed bytes is computed **before** broadcast;
- it is compared with the RPC's return value, the SDK's return value, and the `hash` and `tx_id` fields from `eth_getTransactionByHash`;
- StudioNet's stored `sim_config.signed_rollup_transaction` is compared with our bytes.

**Finality plan:**
- poll `getTransaction` every 10 s for up to 30 min;
- classify each result with `tx/classify.ts` (Phase 2.13 rules);
- success requires FINALIZED + MAJORITY_AGREE + leader `return`, then a `latest-final` read.

### 1.8 Sender authorization

- **The account:** a fresh account created **inside the write process** with viem `generatePrivateKey()`, after your explicit approval in this session.
- **Where the key went:**
  - it was held in one local variable and used to build the guarded signer;
  - it was never printed, logged, returned, written or committed;
  - every console line and the saved log passed `assertSecretAbsent`, which aborts output if the key's digits appear;
  - the process exited, so the key no longer exists.
- **Authorization:** the transaction is authorized by its ECDSA signature. viem's `recoverTransactionAddress` on the signed bytes gives `0x96E2fb5A…26B0`, equal to the sender. StudioNet stored the same `from_address`.
- **Funds:** the account was never funded and holds nothing. StudioNet's `eth_gasPrice` is `0x0`, and the transaction used gas price 0 and value 0.
- **Log scan:** every standalone 32-byte hex value in the saved log is a public transaction field (`hash`, `tx_id`, `random_seed`, `tx_execution_hash`, validator vote hashes).

---

## 2. Submission

| | |
|---|---|
| Submitted | **Exactly once.** Guard: `requestsForwarded` 1, refusals 0. Request log: one `eth_sendRawTransaction` |
| SDK fallback | Not triggered (the first attempt succeeded) |
| Guard journal | (1) `signTransaction` forwarded at +0 ms; (2) signed at +15 ms; (3) broadcast at +16 ms; (4) RPC hash at +565 ms; (5) disarmed at +904 ms ("operation finished") |
| Outcome | `submitted`. SDK returned normally (`note: null`) |
| Submission time | 1.8 s of the 240 s deadline |

---

## 3. Hash and transaction ID correlation

| Source | Value |
|---|---|
| keccak-256 of our signed bytes (computed before broadcast) | `0x309c83aab54b0408930d9c3e92a0f9037fd53a97928f5018ce8012c491487f09` |
| `eth_sendRawTransaction` result | same |
| `writeContract` return value | same |
| `eth_getTransactionByHash` → `hash` | same |
| `eth_getTransactionByHash` → `tx_id` (GenLayer transaction ID) | same |
| Stored `sim_config.signed_rollup_transaction` | **byte-identical** to our signed bytes |

**What this shows:**
- On the local-account path, `writeContract` waits for an EVM receipt and returns the ID from a `NewTransaction` or `CreatedTransaction` log. It returned the same value after one `eth_getTransactionReceipt` call. So **StudioNet receipts carry that log**, and **the GenLayer transaction ID equals the EVM transaction hash on StudioNet**.
- This matches the offline Phase 2.8 finding for genlayer-py, now confirmed live for genlayer-js.

---

## 4. Lifecycle and finality

Times are from script start; submission began at 7.7 s.

| Time | Status | Result | Category |
|---|---|---|---|
| 9.9 s | PENDING | NO_MAJORITY (no vote yet) | PENDING |
| 20.8 s | ACCEPTED | MAJORITY_AGREE | ACCEPTED_SUCCESS |
| 54.0 s | **FINALIZED** | **MAJORITY_AGREE** | **FINALIZED_SUCCESS** |

**Stored transaction:**
- `execution_mode` NORMAL;
- 5 initial validators;
- 3 rotation rounds;
- `to_address` = recipient = the target contract.

**State model:** submitted → finalized → **verified**.

---

## 5. Post-finality read (`latest-final`)

| Read | Result |
|---|---|
| `get_case_count` | 2 (baseline 1, so **exactly one** new case) |
| `get_case("VC-000002")` | claimant `0x96E2fb5A…26B0` (our sender); respondent `0xf1c710a1…0001`; category `OTHER`; title "FICTIONAL TEST - VeriCourt Phase 3.5A Stage A write check"; status `AWAITING_RESPONSE`; response `PENDING`; issue `I1` "FICTIONAL - placeholder issue…" |
| `get_party_case_ids(sender)` | `["VC-000002"]`, total 1 |
| Match against intent | **true** |

**On the test contract now:**
- **`VC-000002`:** a fictional case, awaiting a response (reply window 1 h). Nothing further will be done with it.
- **`VC-000001`** (Phase 2.17C) is unchanged.
- **Live check:** the Phase 3.3 read-only page only requires `VC-000001 ≤ case_count`, so it is unaffected.

---

## 6. Was the JavaScript SDK encoding accepted?

**Yes, for all three differences from the Python path:**
- `to` = `0xb7278A61…` (Python used `0x0`);
- `leaderOnly` byte `0x00` (Python used `0x80`);
- an SDK-estimated gas limit of 500,000.

StudioNet decoded the V5 `addTransaction` and stored identical `tx_data`. The transaction finalized with MAJORITY_AGREE.

---

## 7. Consensus-address and gasless issues

| Issue | Status after Stage A |
|---|---|
| `0xb7278A61…` vs `0x0` on **StudioNet** | **Resolved for StudioNet:** the EVM `to` is not used for routing a decodable `addTransaction`. Supported by Studio source and confirmed live |
| The same address on other networks | Not tested; out of scope |
| `sim_getConsensusContract` returning `0x0` | Explained as a deprecated endpoint; do not rely on it |
| Gasless submission (SDK local path) | **Confirmed:** gas price 0, value 0, zero-balance fresh account, accepted and finalized |
| Gasless submission through a **browser wallet** | **Unverified.** Whether a wallet will sign and broadcast a 0-gas-price legacy transaction from an empty account is a Stage B question |
| Nonce | Advanced 0 → 1 (latest and pending) after the write: one observation. Studio's source shows nonces are recorded but **not validated**, so a nonce does not protect against duplicates. `nonceTrackingVerified` should still stay off until reviewed: one sample is weak evidence |

---

## 8. Request counts and elapsed times

**Totals:**
- **Write run:** 23 RPC requests, 59.6 s end to end. Everything was HTTP 200 with no RPC errors, timeouts or refusals.
- **Standalone preflight:** 12 requests, 9.4 s.

**Write run, by method:**

| Method | Count |
|---|---|
| `eth_chainId` | 1 |
| `eth_gasPrice` | 2 (precheck + SDK) |
| `eth_getTransactionCount` | 5 (2 precheck, 1 SDK, 2 after) |
| `gen_getContractCode` | 1 |
| `gen_call` | 6 (2 count reads, 1 simulation, 3 post-finality reads) |
| `eth_estimateGas` | 1 (SDK) |
| **`eth_sendRawTransaction`** | **1** |
| `eth_getTransactionReceipt` | 1 (SDK) |
| `eth_getTransactionByHash` | 5 (polling) |

---

## 9. Files

**Added (one-off scripts, not part of the app or its build):**
- `frontend/scripts/stage-a/shared.ts`: bounded fetch, fictional arguments, secret check;
- `frontend/scripts/stage-a/preflight.ts`: read-only;
- `frontend/scripts/stage-a/write.ts`: the single guarded write and its monitoring;
- `frontend/scripts/stage-a/tsconfig.json`.

**How the scripts were built and checked:**
- **Typechecked** against the app's strict config.
- **Linted.**
- **Bundled** for Node with the already-installed rolldown 1.2.14 into the session scratchpad.
- **No new dependency:** viem 2.57.7 is imported as already installed. `package.json` and the lockfile are unchanged.

**Repo checks after the run:**

| Check | Result |
|---|---|
| typecheck | pass |
| lint | pass |
| `npm test` | 437 passed |
| build | pass |
| `contracts/vericourt.py` SHA-256 | unchanged |
| `CONTRACT_WRITES_ENABLED` | still `false` |

---

## 10. Limitations

1. **One run, one write.** It shows that the path works once. It does not measure reliability.
2. **SDK local-account path only.** It proves nothing about `eth_sendTransaction` through an injected wallet: the return value, a 0-gas-price prompt, or wallet resends and replacements.
3. **The deployed StudioNet backend version** was not readable. The routing and encoding explanation relies on the `v0.121.6` source and on matching live behaviour.
4. **The SDK's V6 fallback did not occur live.** Its blocking is proven only offline, against the real SDK code with mocks.
5. **StudioNet is a simulator.** Its duplicate and nonce behaviour, where duplicates are not rejected and nonces are not validated, differs from a real chain. Neither should be relied on.

---

## 11. Next-step recommendation

1. **Record the outcome:**
   - keep the logs;
   - update the stale comment in `config/testDeployments.ts` ("never used for writes") to note that Stage A added the fictional `VC-000002`.

   This is a documentation change, not done in this phase.
2. **Before any Stage B work, a separate approval for:**
   - persisting the pending-operation record across reloads;
   - a UI confirmation that shows exactly what will be written publicly;
   - a dedicated test wallet profile that **you** operate.
3. **Leave alone:** keep `nonceTrackingVerified` off and frontend writes disabled.

I am stopping here, with no Stage B work and no further writes.
