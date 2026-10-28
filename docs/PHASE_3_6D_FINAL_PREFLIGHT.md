# Phase 3.6D: operator input validation and final preflight

**Status: `BLOCKED`.** The three Step 1 operator inputs have not been supplied:
1. the throwaway account's **public address**;
2. confirmation of the setup: dedicated browser profile, one wallet extension, empty throwaway account, StudioNet configured with chain ID 61999;
3. whether **Claude** should start the experiment server after the checks, or **you** will start it.

No address was inferred or invented. No key or phrase was requested.

**What this phase did not do:**
- no code changes;
- no wallet actions;
- no server started;
- no transaction.

---

## 1. Checks performed in this phase (no inputs needed)

| Check | Result |
|---|---|
| Repository files (`frontend/src`, `frontend/scripts`, `contracts`, `vite.config.ts`, `package.json`) changed since `PHASE_3_6C_WALLET_PREFLIGHT.md` | **none** |
| `PHASE_3_6B` / `PHASE_3_6C` docs | unaltered since last written (timestamps match those edits; status lines intact) |
| Listeners on 5173 / 4173 | **0** |
| Title construction in the code | unchanged: `ExperimentWritePanel.tsx:84` → `fictionalCase(new Date().toISOString().slice(0, 19))`; title template at `:39` |

The live read-only state was last verified in Phase 3.6C, about 12:10 UTC:
- chain `0xf22f`;
- bytecode hash match;
- case count 2 at both latest-final and latest-nonfinal;
- simulation `VC-000003`.

It is **re-checked in Step 2** once the address arrives, because an earlier result is not taken as proof of the current state.

---

## 2. Step 2 plan (runs only after the inputs arrive; all read-only)

| Check | Method |
|---|---|
| Address format | local: `^0x[0-9a-fA-F]{40}$`; not the zero address; not the fictional respondent `0xF1C7…0001` |
| Chain ID | `eth_chainId` = `0xf22f` |
| Balance | `eth_getBalance(address, "latest")` |
| Nonce | `eth_getTransactionCount` at `latest` and `pending`. **Never treated alone as proof that nothing is pending:** StudioNet records nonces but does not validate them. Read together with the case lists |
| Account's cases | `get_party_case_ids(address, 0, 50)` at latest-final **and** latest-nonfinal (they must agree) |
| Contract | `gen_getContractCode` SHA-256 = `25bc9e0b…79333`; `get_case_count` at final and non-final |
| Recovery / uncertain-write state | lives in the operator's test-profile storage for `http://127.0.0.1:5173`; **not safely readable from here**, and never cleared or modified. Confirmed by the operator: the review screen appears with **no status panel** above it (the panel replaces the review screen whenever a record exists) |

---

## 3. Supported way to build the transaction from the displayed title (Step 3)

**How the page builds the title.** The panel calls `fictionalCase(<T>)` with `<T>` = the page-mount time as `YYYY-MM-DDTHH:MM:SS` (UTC). The title is `FICTIONAL TEST - VeriCourt browser-wallet write <T>`. All other fields are constants in `fictionalCase`.

**Verification procedure:**
1. Take the **exact title text** you send.
2. Extract `<T>` with `^FICTIONAL TEST - VeriCourt browser-wallet write (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)$`.
3. **Reconcile:** call the app's own `fictionalCase(<T>)` and require its title to equal your text **character for character**. Any mismatch → `BLOCKED`.
4. Build the request with the app's own `createCaseArgs` → `buildWriteIntent` (sender = your address, pinned pending nonce), decode it with `decodeAddTransactionV5` / `decodeInputData`, and hash it (keccak-256 and SHA-256).
5. Simulate `create_case` as your address (`gen_call`, no transaction).

The prepared script is `scratchpad/p36/expected-tx.ts` (read-only bounded fetch, the app's own modules). **One addition before use:** the title-equality assertion in step 3 belongs in that scratchpad script. That is not a repository code change.

**Server start, if you instruct Claude to do it:**
1. Reconfirm 5173 is free.
2. Start **only** the documented experiment configuration, on `127.0.0.1:5173` (`vite.config.ts` binds `127.0.0.1`, `strictPort`):

   ```bash
   VITE_VERICOURT_WRITE_EXPERIMENT=I-UNDERSTAND-THIS-SENDS-ONE-REAL-STUDIONET-TRANSACTION VITE_VERICOURT_CONTRACT_ADDRESS=0x3258A80A86920792354A9b7e59D5Ed2409E96220 npx vite --mode write-experiment
   ```

3. Confirm the listener is `127.0.0.1:5173` and nothing else.
4. Then **you**, in the test profile:
   - open `http://127.0.0.1:5173/#/wallet` and press **Connect**;
   - open `#/review`;
   - **don't reload or navigate away**, because `<T>` changes on remount;
   - send the exact title;
   - **don't tick the box or click Sign**.

If you start the server yourself, Claude starts none.

---

## 4. Step 4 output (to be produced; values known now)

| Field | Known now | Basis |
|---|---|---|
| Chain ID | 61999 | verified (RPC) |
| Destination (wallet "To") | `0xb7278A61aa25c888815aFC32Ad3cC52fF24fE575` | verified (SDK constant; Stage A routing) |
| Encoded contract | `0x3258A80A86920792354A9b7e59D5Ed2409E96220` | verified (decoded calldata) |
| Selector | `0x27241a99` | verified |
| Fields 1–2, 4–9 | fixed fictional values (`PHASE_3_6B` §4) | verified |
| Field 3 (title) | needs `<T>` | — |
| Sender, nonce | need the address | — |
| Value | 0 | verified (the guard refuses anything else) |
| Fee | gas price 0 **requested** | the wallet's displayed fee and gas limit are **wallet-dependent; not claimed** |
| Calldata, length, hashes | need the address and `<T>` | — |
| Simulation as the sender | needs the address | — |
| Expected case / count | `VC-000003`, 2 → 3 | expected; re-verified at Step 2 |

---

## 5. Residual risks (unchanged)

- **What the wallet signs:** it may alter the fee or nonce; only your comparison catches this.
- **Title stability:** `<T>` changes on remount, so don't navigate away from `#/review`.
- **One origin:** use `127.0.0.1` only. `localhost` has separate storage.
- **Auto-started preview servers:** the desktop app has relaunched preview servers on its own before. Port 5173 must be free before the experiment server starts.

---

## 6. Status

**`BLOCKED`: awaiting the three operator inputs (§ header).**
