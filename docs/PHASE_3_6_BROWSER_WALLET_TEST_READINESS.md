# Phase 3.6: browser-wallet test readiness (preparation pass)

**Date:** 2026-10-18.

**Mode:** preparation and verification only.
- No wallet access, prompt, signature, broadcast or deployment. No key or seed.
- No code changes: repository files are unchanged since `PHASE_3_6_BROWSER_WALLET_TEST_CHECKLIST.md`, verified by file timestamps.
- Live activity was limited to **13 read-only StudioNet RPC calls**, made through the Stage A bounded fetch, which refuses any send or sign method.

**Verdict: READY to request authorization.** Two kinds of prerequisite can only be confirmed by you (§3), and one anomaly is recorded (§1.2).

---

## 1. Repository and build state

### 1.1 Checks

| Check | Result |
|---|---|
| Source files changed since the checklist | none (`find -newer`) |
| `npm run typecheck` / `npm run lint` | pass / pass |
| `npm test` | **600 passed / 30 files** (three consecutive runs) |
| `npm run build` (ordinary) | pass. **Zero matches** in `dist/` for each of these: experiment banner, acknowledgement phrase, `write-experiment`, `beginWithPreflight`, "VeriCourt write guard", `createSdkWriteClient`, `createGuardedProvider` |
| Experiment build, armed (scratchpad output) | the panel chunk is present; the gate inputs compile to the phrase and `0x3258A80A86920792354A9b7e59D5Ed2409E96220` |
| `contracts/vericourt.py` SHA-256 | `25bc9e0b2bae1a47a64a1324e54123ff132bf343d4a15d5be4e8f7d762e79333` |
| Dependencies | `genlayer-js 1.1.8`, `react` / `react-dom 19.3.1` (unchanged) |
| Node | 24.18.0 |
| Dev server | binds `127.0.0.1:5173` only (`vite.config.ts`) |

### 1.2 Anomaly (unexplained, not reproduced)

- **What happened:** one chained `npm test` run in this pass reported **544 tests / 27 files**, all passing.
- **Re-runs:** three later runs, including the identical command twice, all reported **600 / 30**.
- **What was ruled out:** no test file is missing, and the include pattern is unchanged.
- **Cause:** unknown, and no cause is assumed.
- **Mitigation:** a fresh `npm test` showing exactly **600 / 30** is a hard precondition immediately before the live test.

---

## 2. Live read-only verification (StudioNet)

Log: `integration-logs/phase-3-6-readonly-verify-20261018T115630Z.json`.

| # | Item | Result |
|---|---|---|
| 2 | Chain ID | `eth_chainId` = **`0xf22f` (61999)** |
| — | Gas price | `0x0` |
| 3 | Contract address | **`0x3258A80A86920792354A9b7e59D5Ed2409E96220`**. Sole entry of `EXPERIMENT_CONTRACTS`; the gate (armed, `127.0.0.1`) resolves to it |
| 3 | Deployed bytecode | `gen_getContractCode` is 60,734 bytes. **SHA-256 = repo file = recorded expectation = `25bc9e0b…79333`** |
| 3 | Deploy transaction `0x4557…1567` | FINALIZED; `contract_address` = the target |
| — | Contract identity | `get_contract_info` returns the VeriCourt schema, `vericourt-method-v2` |
| 10 | Existing cases | `get_case_count` = **2** at both latest-final and latest-nonfinal (nothing pending). `VC-000001` "[VeriCourt integration test - fictional data] Three blog articles" (DECIDED); `VC-000002` "FICTIONAL TEST - VeriCourt Phase 3.5A Stage A write check" (AWAITING_RESPONSE) |
| 10 | Stage A transaction `0x309c…7f09` | still FINALIZED, MAJORITY_AGREE |
| 7 | Consensus entry point | the SDK sends to `0xb7278A61aa25c888815aFC32Ad3cC52fF24fE575`. `eth_getCode` there is `0x`; `sim_getConsensusContract` still reports `0x0`. Same as Stage A, where StudioNet routed by the encoded recipient |
| 4 | Intended calldata (the app's own modules, placeholder sender) | to `0xb7278A61…E575`; selector **`0x27241a99`**; 740 bytes; encoded recipient = target contract; 5 validators, 3 rotations; `leaderOnly` byte `00`; decoded call: `create_case` with the nine fictional arguments (§4) |
| 4 | Simulation (`gen_call`, no transaction) | **`VC-000003`** |

Of the 13 requests, all were reads, 0 were send-like, and 0 were refused.

---

## 3. Prerequisites only you can confirm

1. **A dedicated browser profile** with **one** wallet extension and a **new throwaway account** that holds nothing.
2. **StudioNet added by hand** in that wallet: RPC `https://studio.genlayer.com/api`, chain ID `61999`.
3. **The throwaway account's public address**, so the exact expected transaction can be shown before any prompt: `from`, `nonce` (read-only), and the `_sender` word. **Only the public address. Never a key or phrase.**
4. **No earlier experiment record** in that profile. The review screen must appear without a status panel.

---

## 4. The expected `create_case`

These are the values the panel renders and encodes (`experiment/ExperimentWritePanel.tsx` `fictionalCase`).

| Field | Value |
|---|---|
| respondent | `0xF1C710A100000000000000000000000000000001` |
| category | `OTHER` |
| title | `FICTIONAL TEST - VeriCourt browser-wallet write <YYYY-MM-DDTHH:MM:SS>`. The timestamp is set when the page loads, which makes the title unique |
| agreement_summary | `FICTIONAL - no real agreement exists. Created by the VeriCourt Phase 3.5C browser-wallet experiment.` |
| expected_deliverable | `FICTIONAL - nothing was to be delivered. This record exists only to test the write path.` |
| claim | `FICTIONAL TEST RECORD - not a real dispute. No real party, work, payment or claim is involved.` |
| requested_remedy | `None - fictional test record.` |
| issues | `["FICTIONAL - placeholder issue for a browser-wallet write test"]` |
| reply_window_seconds | `3600` |

**Verification after finality** (automatic in the panel; re-checked read-only by Claude afterwards):
- `get_case_count` = 3;
- exactly one case after your account's baseline whose claimant is your address and whose title and respondent match the above, at **latest-final**;
- that case is expected to be `VC-000003`, unless another write lands first; the panel identifies it by content, not by number.

---

## 5. Duplicate protection (item 10)

- **Unique title:** a timestamped title never matches `VC-000001` or `VC-000002`.
- **Per account:** the preflight requires `nonce latest == pending`, so the account has nothing in flight.
- **Per browser:** a persistent record and the cross-tab lock. A new write is impossible while any earlier one is unresolved.
- **Detection:** if two matching cases ever appear (for example from a wallet rebroadcast; StudioNet doesn't reject duplicate raw transactions), the panel **refuses to call it success**.

---

## 6. Display guidance (Phase 2.18B)

- **No standalone document:** `docs/PHASE_2_18B_DISPLAY_GUIDANCE_GAPS.md` does not exist. That audit was delivered in chat only.
- **Where the rules live:** `src/display/`, with `forbidden-terms.test.ts` and the label, notice, citation, caution and provenance tests, all inside the 600.
- **Experiment UI text:** contains none of "verdict", "winner", "loser", "ruling", "judgment", "legal advice" or "binding" (the only match is the code word "bindings" in a comment).
- **Finality wording:** "Accepted is not final"; success only as "Case created and confirmed" after a latest-final read.
