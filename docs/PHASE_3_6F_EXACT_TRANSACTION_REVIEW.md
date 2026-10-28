# Phase 3.6F: exact transaction for operator approval

**Status: `READY FOR USER REVIEW`.** Conditional on the operator confirmations in §4.

**Nothing has been signed or sent.**

**Inputs and environment:**
- **Title displayed** on the operator's `#/review` page: `FICTIONAL TEST - VeriCourt browser-wallet write 2026-10-18T21:59:07`.
- **Server:** experiment server running on `127.0.0.1:5173`, armed for `0x3258…6220`, started 21:42 UTC.

## 1. Checks (all read-only, 14 requests, 0 send-like)

Log: `integration-logs/phase-3-6-exact-tx-20261018T220011Z.json`.

| Check | Result |
|---|---|
| Title reconciliation | the app's own `fictionalCase("2026-10-18T21:59:07")` reproduces the displayed title **exactly** |
| Case-field validation | `validateCreateCase` → no problems |
| Sender | `0x16fD571ae717F92b5e43597d813267C8d15f105A`; EIP-55 checksum valid |
| Chain | `eth_chainId` = `0xf22f` (61999) |
| Gas price (RPC) | `0x0` |
| Balance | `0x0` |
| Nonce | latest **0**, pending **0** |
| Contract code | SHA-256 `25bc9e0b…79333` = repo = recorded |
| Case count | 2 at latest-final and latest-nonfinal |
| Account's cases | none at either variant |
| `eth_estimateGas` (exact calldata) | `0x7a120` (500,000) |
| Simulation as the sender (exact calldata) | **`VC-000003`** |

**The switch-network prompt.** The app source contains no `wallet_switchEthereumChain` or `wallet_addEthereumChain` call. Its wallet calls are `eth_chainId`, `eth_accounts`, `eth_requestAccounts` (Connect) and the guarded send only. The operator's switch prompt therefore came from the wallet itself, almost certainly its offer to switch after a network is added manually. The operator confirms in §4.

## 2. The exact transaction

| Field | Value |
|---|---|
| Network / chain ID | GenLayer StudioNet / **61999** (`0xf22f`) |
| From | `0x16fD571ae717F92b5e43597d813267C8d15f105A` |
| To (consensus entry point) | `0xb7278A61aa25c888815aFC32Ad3cC52fF24fE575` |
| Encoded VeriCourt contract (`_recipient`) | `0x3258A80A86920792354A9b7e59D5Ed2409E96220` |
| Encoded `_sender` | `0x16fd571ae717f92b5e43597d813267c8d15f105a` |
| Selector | `0x27241a99`: `addTransaction(address,address,uint256,uint256,bytes)` |
| Validators / rotations / `leaderOnly` | 5 / 3 / false (`00`) |
| Nonce | **0** (re-read by the in-app preflight at click time and pinned) |
| Value | **0** |
| Gas price (requested) | **0**. Gas limit ≈ **500,000** (SDK estimate at send time). **Fee = 0** if the wallet keeps the requested gas price; the wallet's displayed fee is **not verified** until the prompt |
| Calldata length | **740 bytes** |
| Calldata keccak-256 | `0x7e7f642abf3c9705a43f19a918b9017459fd069a0fa07828f535971d82706dc0` |
| Calldata SHA-256 | `038bb9c4f3c005b6b89c2dd3cd56b9dc3e27077e218a506eb9bc600446c26148` |
| Expected result | **`VC-000003`** (expected, not guaranteed); `get_case_count` 2 → 3; the account's case list 0 → 1 |

**Decoded `create_case` arguments:**

| # | Field | Value |
|---|---|---|
| 1 | respondent | `0xF1C710A100000000000000000000000000000001` |
| 2 | category | `OTHER` |
| 3 | title | `FICTIONAL TEST - VeriCourt browser-wallet write 2026-10-18T21:59:07` |
| 4 | agreement_summary | `FICTIONAL - no real agreement exists. Created by the VeriCourt Phase 3.5C browser-wallet experiment.` |
| 5 | expected_deliverable | `FICTIONAL - nothing was to be delivered. This record exists only to test the write path.` |
| 6 | claim | `FICTIONAL TEST RECORD - not a real dispute. No real party, work, payment or claim is involved.` |
| 7 | requested_remedy | `None - fictional test record.` |
| 8 | issues | `["FICTIONAL - placeholder issue for a browser-wallet write test"]` |
| 9 | reply_window_seconds | `3600` |

**Full calldata:** recorded in the log file named above.

## 3. What the wallet should show

| Field | Expected |
|---|---|
| Request type | one **transaction** request, from `127.0.0.1:5173` |
| Network | GenLayer StudioNet, chain 61999 |
| Account | `0x16fD…105A` |
| To | `0xb7278A61…E575`. Expected: the VeriCourt address is inside the data |
| Amount | 0 |
| Fee | 0 |
| Data, if shown | begins `0x27241a99`, 740 bytes |
| Nonce, if shown | 0 |

**Reject on:**
- any difference from the table above;
- a second prompt;
- any signature, switch-network or add-network request.

## 4. Operator confirmations still needed

1. The switch prompt was the wallet's own offer after adding the network, **not** shown while on the VeriCourt page and **not** a request originating from it.
2. On the open `#/review` page:
   - "Wallet is on StudioNet";
   - Your account = `0x16fD…105A`;
   - Contract = `0x3258…6220`;
   - **no status panel**;
   - the page has not been reloaded or left since the title was copied.

---

## Revision 2 (2026-10-19): supersedes §1–§2 above

**Why the earlier version is void:**
- The page reload changed the title. The first approval (title `…2026-10-18T21:59:07`, keccak `0x7e7f642a…6dc0`) is **void**.
- A wallet-connection defect then blocked the button. A Connect result superseded by the wallet's own `accountsChanged` event was discarded. It was fixed with approval in `wallet/walletState.ts` (`connectGrant`):
  - 616 tests;
  - typecheck, lint and build clean;
  - 7/7 mutations caught;
  - no write path in the ordinary build.
- The experiment server was restarted cleanly: PID 15520, `127.0.0.1:5173`, same gate inputs.

**Incident:** my read-only watcher exceeded StudioNet's RPC limit ("Rate limit exceeded: 500 requests per hour"). It was stopped; nothing was sent. The limit had cleared by this check.

**New title:** `FICTIONAL TEST - VeriCourt browser-wallet write 2026-10-19T06:05:25`. The operator reports **"Sign in wallet" is clickable** (not clicked).

**Checks:** 14 read-only requests, 0 send-like, 0 errors. Log: `integration-logs/phase-3-6-exact-tx-20261019T063421Z.json`.

| Check | Result |
|---|---|
| Title reconciliation | the app's `fictionalCase()` reproduces the title **exactly**; no validation problems |
| Chain / gas price | `0xf22f` / `0x0` |
| Balance / nonce | 0 / latest 0, pending 0 |
| Code hash | `25bc9e0b…79333` (match) |
| Case count | 2 at final and non-final |
| Account's cases | none at either variant |

**The exact transaction:**

| Field | Value |
|---|---|
| From | `0x16fD571ae717F92b5e43597d813267C8d15f105A` |
| To | `0xb7278A61aa25c888815aFC32Ad3cC52fF24fE575` |
| Encoded contract | `0x3258A80A86920792354A9b7e59D5Ed2409E96220` |
| Selector | `0x27241a99` |
| Validators / rotations / `leaderOnly` | 5 / 3 / false |
| Nonce / value | 0 / 0 |
| Gas price (requested) / gas estimate | 0 / `0x7a120` (500,000). The wallet's displayed fee is not verified |
| Calldata | **740 bytes** |
| keccak-256 | `0x8ce10c83aacfef2910b1b6a3f563299cfe9f6ef35f16a1b525b1f7ee85abe53e` |
| SHA-256 | `8c732256cdd16f318f306fd4731c51610a99ca2c07b9e2dfbf0b99542c415262` |
| Simulation as the sender | **`VC-000003`** |
| Expected result | count 2 → 3 |

**Decoded fields:** identical to §2 except field 3 (title) = `FICTIONAL TEST - VeriCourt browser-wallet write 2026-10-19T06:05:25`.

**Status:** `READY FOR USER REVIEW` (revision 2).
