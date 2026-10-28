# Phase 3.6C: wallet-specific preflight and exact transaction review

**Status: `BLOCKED`.** The operator inputs required by Step 1 have not been provided:
1. the throwaway account's public address;
2. confirmation of the test setup (dedicated browser profile, one wallet extension, empty throwaway account, StudioNet with chain ID 61999).

No address was inferred or invented. Everything that does not depend on those inputs was re-verified (§2, §3).

**What this phase did not do:**
- no code changes;
- no wallet connection, prompt, signature or broadcast;
- no server started or restarted;
- no key or phrase requested.

**Live activity:** 13 read-only StudioNet calls.

---

## 1. Inputs

| Input | Status |
|---|---|
| Throwaway public address | **missing**. Will be validated locally (`^0x[0-9a-fA-F]{40}$`, not the zero address, not the fictional respondent `0xF1C7…0001`) |
| Setup confirmation | **missing** |
| Review-page title timestamp `<T>` | not yet applicable (§3) |

---

## 2. Re-validation done now (read-only, no address needed)

| Check | Result |
|---|---|
| Repository files changed since `PHASE_3_6B_TRANSACTION_REVIEW.md` | none |
| `eth_chainId` | `0xf22f` (61999) ✔ |
| `eth_gasPrice` | `0x0` |
| Contract bytecode | deployed SHA-256 = repo `contracts/vericourt.py` = recorded = `25bc9e0b2bae…` ✔ |
| `get_case_count` | **2** at latest-final and latest-nonfinal, so nothing is in flight on the contract ✔ |
| Stage A transaction `0x309c…7f09` | FINALIZED |
| `create_case` simulation (`gen_call`, placeholder sender) | `VC-000003` |
| Gate, as the armed build would evaluate it on `127.0.0.1` | enabled, resolving to `0x3258A80A86920792354A9b7e59D5Ed2409E96220` only |
| Port 5173 / 4173 | **nothing listening** (`Get-NetTCPConnection`); no preview server running (`preview_list`) ✔ |

**RPC traffic:** 13 requests, all reads, 0 refused, 0 send-like. Log: `integration-logs/phase-3-6c-readonly-verify-20261018T121038Z.json`.

### 2.1 Pending once the address arrives

- `eth_getTransactionCount(address, "latest")` and `("pending")`;
- `eth_getBalance`;
- `get_party_case_ids(address, 0, 50)` at latest-nonfinal (the baseline);
- a simulation as that address;
- `eth_estimateGas` for the exact calldata.

**A nonce alone is never taken as proof that nothing is pending:** StudioNet records nonces but does not validate them (Stage A). It is used together with the account's case list and the contract-wide case count, final versus non-final.

### 2.2 Local recovery state (cannot be read from here)

The app's pending-write record lives in the **operator's test-profile** browser storage, under the origin `http://127.0.0.1:5173`. It cannot be read safely from this session without starting a server and using that profile. It was **not** read or modified.

**How it is confirmed instead:** the panel shows a status panel instead of the review screen whenever a record exists (`ExperimentWritePanel.tsx`, `record === null ? <WriteConfirmation…>`). The operator confirms that the review screen appears with **no** status panel.

**Use one origin only.** Storage is per origin: `127.0.0.1:5173` and `localhost:5173` are separate. The test must consistently use **`http://127.0.0.1:5173`**, the checklist URL.

---

## 3. Title timestamp: findings (Step 3)

**Where it comes from.** `ExperimentWritePanel.tsx:84`:

```ts
useState(() => fictionalCase(new Date().toISOString().slice(0, 19)))
```

The title is `FICTIONAL TEST - VeriCourt browser-wallet write <T>`, with `<T>` in UTC to the second.

**When it changes.** It is fixed when the `/review` page **mounts**. `App.tsx`'s `Page` switch unmounts the page on any route change. So `<T>` changes on:
- a reload;
- **navigating away from `#/review` and back**, for example to `#/wallet`.

**Can it be obtained without a server or wallet?** No. It exists only inside the running experiment server, in the specific tab where the user will sign. Opening the page anywhere else (such as Claude's built-in browser) produces a different `<T>`, which would be useless.

**What doesn't need a wallet:** reading the title. The review screen renders whether or not a wallet is connected.

**The minimal manual step, in this order, after your explicit instruction to start the server:**
1. The experiment server is started, by you or by Claude on your instruction, with the checklist command, on `127.0.0.1:5173`.
2. In the test profile: open `http://127.0.0.1:5173/#/wallet` and press **Connect**. The connection persists across routes.
3. Open `http://127.0.0.1:5173/#/review`. **From here, don't reload and don't navigate away.**
4. Read the **Title** row and send back the exact text, or just `<T>`. **Don't tick the box or click Sign.**
5. If `<T>` ever changes, any previous calldata review is void and is recomputed from the new title.

---

## 4. Exact transaction details

Per Step 4, these are produced with the app's own functions: `fictionalCase`, `validateCreateCase`, `createCaseArgs`, `buildWriteIntent`, `decodeAddTransactionV5`. A prepared read-only script (`scratchpad/p36/expected-tx.ts`) runs them once the address and `<T>` are known.

| Field | Value now | Kind |
|---|---|---|
| Network / chain ID | StudioNet / **61999** | verified (RPC) |
| Sender | needs the address | — |
| Consensus entry point ("To") | **`0xb7278A61aa25c888815aFC32Ad3cC52fF24fE575`** | verified (SDK constant; Stage A routing) |
| Encoded contract (`_recipient`) | **`0x3258A80A86920792354A9b7e59D5Ed2409E96220`** | verified (decoded calldata) |
| Selector | **`0x27241a99`** | verified |
| `create_case` arguments | the nine fixed fictional values (`PHASE_3_6B_TRANSACTION_REVIEW.md` §4); title pending `<T>` | verified apart from `<T>` |
| Nonce | needs the address. At send time the guard pins the **pending** nonce read in the preflight | — |
| Value | **0** | verified (the guard refuses anything else) |
| Fee | gas price **0** (RPC `0x0`; the guard refuses non-zero) | verified as the **request**. The exact fee and gas limit the wallet shows are **wallet-dependent and unconfirmed** |
| Calldata length | 740 bytes, for the fixed-length title format | derived; confirmed once `<T>` is known |
| Full calldata and hashes | needs the address and `<T>` | — |
| Simulation | `VC-000003` (placeholder sender) | verified; re-run as the real sender |
| Expected case / count | **`VC-000003`**; **2 → 3** | expected, provided no other write lands first |

---

## 5. Unresolved items

1. **Throwaway public address**: blocks §2.1 and §4.
2. **Setup confirmation**.
3. **Instruction to start the experiment server**, then `<T>` captured as in §3.
4. **The wallet's own displayed fee, gas limit and nonce**: only visible in the prompt. Not claimed in advance.

---

## 6. Status

**`BLOCKED`: awaiting operator inputs (Step 1).**
