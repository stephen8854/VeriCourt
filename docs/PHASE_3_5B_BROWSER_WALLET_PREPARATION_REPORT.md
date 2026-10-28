# Phase 3.5B: browser-wallet safety preparation

**Status:** the browser-wallet write path is prepared and tested offline:
- persistent write-safety state that survives reloads and is shared across tabs;
- a confirmation screen;
- read-only reconciliation;
- guard tests for every failure mode listed in the brief.

**What was not done:**
- no transaction, deployment, wallet request, signature or key;
- no dependency change;
- no change to the contract or its tests.

**Writes remain disabled** (`CONTRACT_WRITES_ENABLED = false`). The confirmation screen is **not wired** to any submission path. Its final button is always disabled in this build.

**Not claimed:** Stage A's local-key result says nothing about browser-wallet behaviour, and this report doesn't assume otherwise.

**SDK modification or extra dependency?** None was needed. Web Locks, the one browser API this relies on, is part of the platform. Where safety needs it and it is missing, writes are refused rather than worked around (§4.4).

---

## 1. Review of Phase 3.5A and Stage A

What carries over:
- the single-use `WriteGuard`;
- the byte-exact intent checks;
- `runGuardedWrite`'s journal-derived outcomes;
- read-only `reconcile`.

Stage A confirmed on StudioNet (local-key path only):
- the transaction ID equals the EVM hash;
- the `0x00` `leaderOnly` byte is accepted;
- the SDK's consensus `to` is ignored for routing;
- writes are gasless.

Stage A also established that StudioNet **does not reject duplicate raw transactions and does not validate nonces**. So duplicate prevention must be entirely client-side, and nonces cannot prove "not sent". That shaped this phase:
- the safety record must outlive the page;
- nonce-based "not sent" stays off.

---

## 2. Changes

### 2.1 Test deployment record (item 2)

| File | Change |
|---|---|
| `frontend/src/config/testDeployments.ts` | New `laterWrites` field with the Stage A write: `VC-000002`, tx `0x309c83aa…7f09`, sender `0x96E2…26B0`, observation, report link. The header comment no longer says "never used for writes"; it now says the app never writes to the deployment and that Stage A added one fictional case |
| `frontend/src/config/testDeployments.test.ts` | Checks the new record. It also checks that the live check's evidence is unchanged: the six original transactions, case `VC-000001`, and the address |
| `docs/PHASE_2_17C_NO_REPLY_STUDIONET_REPORT.md` | Addendum recording `VC-000002` and the case count of 2 |

The Phase 3.3 live check is unaffected: it requires only `VC-000001 ≤ case_count`.

### 2.2 New modules (`frontend/src/write/`)

| File | Purpose |
|---|---|
| `createCase.ts` | The `create_case` input model. **One object feeds both the confirmation screen and the encoded call.** Validation mirrors the contract (limits parsed from `vericourt.py` by a test; Unicode code points counted like Python's `len`) |
| `methods.ts` | The contract's write-method list, dependency-free (keeps genlayer-js out of the main bundle) |
| `pendingStore.ts` | Persistent record (`vericourt.write.pending.v1`): strict parsing, read-back-verified saves, `blockReason`, `recoverAfterReload` |
| `writeLock.ts` | Cross-tab mutual exclusion via the Web Locks API (`navigator.locks`, `ifAvailable`, never waits). Refused when unavailable |
| `walletWatch.ts` | Closes the operation on `accountsChanged`, `chainChanged` or `disconnect` |
| `durableSession.ts` | `DurableWriteSession`: lock → recover → re-check → write-ahead record → watched, bounded run → persisted outcome → read-only reconciliation |
| `reconcileReader.ts` | Gathers evidence read-only, every read bounded at 20 s: lookups by recorded hash, nonces, and the `create_case` effect check |
| `sdkReconcileReader.ts` | genlayer-js reader for that evidence. No account and no provider, so it cannot sign; reads only |

### 2.3 Modified modules

| File | Change |
|---|---|
| `write/guard.ts` | `observe()` hook. **The forward step is write-ahead:** if the observer cannot persist, the forward is undone and `GuardPersistenceFailure` is thrown. Other changes are persisted best-effort and counted |
| `write/guardedProvider.ts`, `write/guardedAccount.ts` | A failed write-ahead becomes a guard refusal: nothing is sent or signed |
| `write/reconcile.ts` | Contract effect is now graded (`observed_final`, `observed_nonfinal`, `absent`, `unknown`). New result `effect_final` |
| `write/session.ts` | Handles `effect_final` |
| `write/intent.ts` | Re-exports the method list from `methods.ts` |
| `tx/state.ts` | New settled phase `confirmed_by_state` (event `RECONCILED_EFFECT_FINAL`, accepted only from uncertain phases) |

### 2.4 UI (display only)

| File | Purpose |
|---|---|
| `components/WriteConfirmation.tsx` | The confirmation screen (§5) |
| `pages/WritePreview.tsx` + route `#/review` | Preview with fictional data and the browser's write-safety status. Final button disabled with `WRITES_DISABLED_REASON` |
| `styles/global.css` | Two small classes (`facts__row`, `pre-wrap`) |

### 2.5 Isolation, tightened

`write/isolation.test.ts` now enforces:
- **Restricted imports:** UI code may import only `write/createCase`, `write/pendingStore` and `write/methods`.
- **No runtime dependencies in those modules:** no SDK, guard, wallet or network code (type-only imports allowed).
- **No write calls in the UI:** no page or component mentions `writeContract`, `eth_sendTransaction`, `DurableWriteSession`, `runGuardedWrite` or `createGuardedProvider`.
- **No keys:** `src/write` never generates keys.
- **Storage access:** only `pendingStore.ts` touches browser storage.

**Production bundle:** none of the guard code, `addTransaction` encoding or wallet-send logic. genlayer-js stays in the lazy `sdkGateway` chunk.

**Doc strings now shipped:** the store imports the state model's phase list. As a result, the main bundle now contains that model's verification-note strings, which mention `eth_sendTransaction` as text only.

---

## 3. How the persistent state works (item 3)

**Order of operations for one future browser write (`DurableWriteSession`):**

1. **`open()`, on page load:**
   - loads the record;
   - **if no other tab holds the write lock**, recovers an operation whose page went away (§3.2).
2. **`begin(intent, ctx)` refuses when:**
   - a write is running in this tab;
   - Web Locks is unavailable;
   - storage is not writable (probe);
   - the lock is held by another tab;
   - **under the lock**, after re-reading and recovering, a record is unresolved;
   - the operation ID was used before.

   Otherwise it **saves the record in phase `preparing` before returning the guard**, together with:
   - the expected effect;
   - the party-case baseline;
   - the pre-send nonce.
3. **`run(submit, { wallet, timeoutMs })`:**
   - subscribes to wallet events; a wallet that cannot report them is **not used** (`not_sent`);
   - runs the SDK call under the deadline;
   - **the forward is write-ahead:** the record says "forwarded" in storage before the wallet receives the request;
   - persists the outcome and releases the lock.
4. **Afterwards:**
   - **Unresolved outcomes** block every tab, across reloads.
   - **`reset()`** works only on settled records.
   - **`reconcile(reader)`** is the only way out of an uncertain phase.
   - **No retry.**

### 3.1 Fail-closed rules

| Situation | Result |
|---|---|
| Storage missing, throwing, or failing a read-back | Writes blocked |
| Record unparseable (strict schema: phases, hashes, addresses, guard consistency) | Writes blocked; manual recovery only (§7.3) |
| Write-ahead save fails | Request not forwarded; `not_sent` |
| No Web Locks | Writes blocked |
| Late callback from an old operation | Refused: a save only proceeds if storage still holds **this** operation, and it is applied to the stored copy, so another tab's changes survive |

### 3.2 Reload recovery (`recoverAfterReload`, only under the lock)

| Recorded at reload | Recovered as |
|---|---|
| `preparing` / `awaiting_wallet` with no forwarded request | `not_sent`. Proof: the write-ahead invariant means no request left that page |
| Forwarded, wallet returned 4001 | `rejected` |
| Forwarded, wallet hash recorded | `submitted` (still blocking until finality) |
| Forwarded, no result, an error, or a malformed result | **`submission_uncertain`**. A reload or timeout is never treated as failure |
| Any other phase | Unchanged |

**Recovery runs only while holding the write lock.** A live tab holds the lock for its whole operation, and a closed page releases it. So a second live tab can never mistake the first tab's running operation for an abandoned one.

---

## 4. Guard audit: failure modes (item 5)

| Failure mode | Behaviour | Evidence |
|---|---|---|
| SDK V6 fallback | The second `eth_sendTransaction` is refused at the guard. Through the durable session with the **real genlayer-js 1.1.8**, the wallet sees exactly 1 request, the record shows 1 refusal, and the outcome is uncertain and blocks | `durableSession.test.ts`, `sdkPath.test.ts` |
| Double click (UI) | The button calls `onConfirm` once (a ref plus disabled state) | `WriteConfirmation.test.tsx` |
| Double click / concurrent calls (guard) | Second `begin` refused in-tab; a concurrent duplicate closes the operation before forwarding | `durableSession.test.ts`, `guardedProvider.test.ts` |
| Two tabs | Lock refuses the second while the first runs; afterwards the persisted record refuses it | `durableSession.test.ts` |
| Second tab opened mid-operation | Shown as unresolved; **never rewritten** | `durableSession.test.ts` |
| Prompt still open after the UI deadline | `uncertain` (never "failed"); persisted; blocks | `durableSession.test.ts`, `runner.test.ts` |
| Late response after timeout | The late hash is persisted (`settledAfterDisarm`), and reconciliation then finds it, giving `submitted` | `durableSession.test.ts` |
| Account change before forward | The operation closes; the wallet gets no send; `not_sent` | `durableSession.test.ts` |
| Chain change after forward | Cannot withdraw the request. Recorded in the journal; the outcome still follows the wallet's answer; listeners removed | `durableSession.test.ts` |
| Wallet without events | Not used; no wallet call at all | `durableSession.test.ts` |
| Reload while uncertain | Stays blocked in every later load; cannot be reset | `durableSession.test.ts`, `pendingStore.test.ts` |
| Reload before / after the forward | `not_sent` / `submitted` / `rejected` / uncertain, as in §3.2 | `pendingStore.test.ts`, `durableSession.test.ts` |
| Malformed or unrecognized wallet response | `uncertain: malformed_wallet_response`; persisted; blocks | `durableSession.test.ts`, `guardedProvider.test.ts` |
| Wrong chain, sender, target, selector, value, gas price or nonce | Refused before the wallet sees anything (Phase 3.5A, unchanged) | `guardedProvider.test.ts` |

### 4.1 Two real bugs found and fixed during this phase

1. **A late callback could overwrite a newer record.**
   - **Cause:** the old operation's observer compared IDs against its own stale in-memory copy.
   - **Risk:** across tabs, a late wallet response in tab A could have erased tab B's in-progress record.
   - **Fix:** saves are compare-and-swap-style (re-read; write only if storage holds the same operation; mutate the stored copy).
   - **Regression tests:** two.
2. **Opening a second tab could "recover" a live operation.**
   - **Cause:** `refresh()` applied reload recovery unconditionally. Tab B would have rewritten tab A's running `awaiting_wallet` record as `not_sent`, unblocking writes while A's prompt was open.
   - **Fix:** recovery runs only under the write lock.
   - **Regression test:** one.

### 4.2 Mutation check

- **Method:** 16 safety-critical lines were broken one at a time, and the `src/write`, `src/tx` and `src/components` tests were re-run each time. Script: `scratchpad/mutate_3_5b.py`.
- **Result: 16/16 caught.** One (N6) was first **missed**, because `begin()`'s storage probe still refused. That left the preview's status panel wrong. A direct `blockReason` test was added, and N6 is now caught.

| # | Mutation | Result |
|---|---|---|
| N1 | write-ahead veto ignored | caught |
| N2 | save without operation check | caught |
| N3 | recovery while another tab holds the lock | caught |
| N4 | reload with open prompt treated as not sent | caught |
| N5 | unreadable record does not block | caught |
| N6 | unavailable storage does not block | caught (after the added test) |
| N7 | account change ignored | caught |
| N8 | wallet without events allowed | caught |
| N9 | non-final effect accepted | caught |
| N10 | effect check ignores title | caught |
| N11 | confirm without acknowledgement | caught |
| N12 | confirm despite blockers | caught |
| N13 | double click fires twice | caught |
| N14 | unresolved record clearable | caught |
| N15 | `begin` skips the re-check under the lock | caught |
| N16 | displayed and encoded argument order differ | caught |

The Phase 3.5A guard mutations (12/12) still apply.

### 4.3 What the guard still cannot see or control

Read this list before any live test:

1. **What the wallet actually signs.** The guard checks the *request*. A wallet may still change the fee, nonce or transaction type in its own UI. The user must compare the wallet prompt with the review screen and reject any difference (§7, step 12).
2. **The wallet prompt itself.** It cannot be withdrawn or timed out by the app. Wallet "speed up" or "cancel" features can create replacement transactions outside the guard.
3. **Other wallets, browsers, profiles or devices.** The safety record lives in this browser profile's storage. Clearing site data removes it; that is a deliberate user action, documented in §7.3.
4. **Pending requests after a reload.** Whether a given wallet keeps a request open after the requesting page reloads is wallet-specific and unverified. Recovery treats it as uncertain.
5. **The wallet's return value.** Whether `eth_sendTransaction` returns the GenLayer transaction ID on StudioNet through a wallet is **unverified**. Stage A verified it only for the local-key path.

### 4.4 Browser API requirement (not a dependency)

The Web Locks API is required for cross-tab safety. It is standard in current Chromium, Firefox and Safari. Without it, writes are refused. Storage alone has no atomic compare-and-set, so there is no safe fallback.

---

## 5. Confirmation screen (item 4)

`components/WriteConfirmation.tsx`:

| Required element | Shown as |
|---|---|
| StudioNet and chain ID 61999 | "GenLayer Studio Network (StudioNet), chain ID 61999", plus whether the wallet itself reports that chain |
| Connected account | Full address, as the wallet reports it |
| Target contract | Full address |
| Function name | `create_case`: creates a new case with you as the claimant |
| Human-readable case fields | All nine arguments, in contract order. Issues numbered I1, I2…; reply window in hours; remedy marked advisory |
| On-chain warning | "Signing sends one transaction that **creates a new case on chain** … cannot be edited or withdrawn" |
| Wallet-mismatch advice | Reject the request if the wallet shows another network, a non-zero fee, or different details |
| Privacy warning | "… **may be publicly visible and cannot be deleted**. Do not include personal data …" |
| Final user action | An acknowledgement checkbox, then "Sign in wallet" |

**When the final button is enabled:** only when there are no blockers and the user has acknowledged.

**Blockers, each listed with its reason:**
- writes disabled or blocked by an unresolved write;
- no account;
- wrong or unknown wallet chain;
- no contract;
- invalid case details.

**Rendering and wording:**
- all values render as text (a test injects markup);
- no "verdict", "winner", "loser", "ruling" or "judgment".

**Encoding test:** the screen's data is decoded back out of the real encoded calldata, and the decoded values equal the displayed ones (`createCase.test.ts`).

---

## 6. Test evidence

Run on 2026-10-18 in `frontend/`, Node 24.18:

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `tsc -p scripts/stage-a` | pass |
| `npm run lint` | pass |
| `npm test` | **530 passed / 27 files** (was 437 / 23) |
| `npm run build` | pass |

| File | Tests | Covers |
|---|---|---|
| `write/durableSession.test.ts` (new) | 27 | write-ahead ordering; save failure stops the send; storage, corrupt-record and no-lock refusals; reload with open prompt, before forward, after hash; double begin; two tabs; second tab opened mid-operation; unique IDs; account change; chain change; wallet without events; timeout plus late hash, then reconcile to found; malformed response; real-SDK fallback; old-callback isolation; cross-tab merge; reconciliation cases (`effect_final`, non-final, absent, wrong case, read failures, nothing to reconcile); Web Locks adapter |
| `write/pendingStore.test.ts` (new) | 23 | round trip; unavailable or throwing storage; failed save; probe; 8 corrupt-record cases; snapshot parsing; no secrets or calldata stored; `blockReason` incl. unavailable storage; reload recovery table |
| `write/createCase.test.ts` (new) | 19 | limits and argument order parsed from the contract; 13 validation cases; code-point counting; displayed equals encoded (decoded calldata); notes |
| `components/WriteConfirmation.test.tsx` (new) | 17 | every required element; field order; text-not-HTML; warnings; wording; acknowledgement; double click; 8 blocker cases; preview page disabled and makes passive wallet reads only; safety status from storage |
| `write/isolation.test.ts` | 5 | §2.5 |
| `tx/state.test.ts` | 35 | plus `confirmed_by_state` and `RECONCILED_EFFECT_FINAL` |
| `config/testDeployments.test.ts` | 3 | plus the Stage A record |

**Unchanged and checked:**
- `contracts/vericourt.py` SHA-256 is `25bc9e0b…79333`;
- `package.json` dependencies are `genlayer-js 1.1.8`, `react` / `react-dom 19.3.1`;
- `CONTRACT_WRITES_ENABLED = false`.

---

## 7. Remaining risks, and the exact manual steps for a future one-transaction browser-wallet test

### 7.1 Remaining risks

1. **Wallet compatibility is unverified:**
   - a 0-gas-price legacy (`type: 0x0`) request with a `chainId` field, from an empty account;
   - the `eth_sendTransaction` return value;
   - behaviour of pending requests on reload.
2. **The wallet may alter fee or nonce in its UI.** Only the user's comparison with the review screen catches this (§4.3).
3. **Effect-based reconciliation exists only for `create_case`.** An uncertain `create_case` with no hash and no visible effect **stays blocked indefinitely**. Clearing it is a deliberate manual step (§7.3). Other methods have no effect check yet.
4. **The safety record is per browser profile.** Another browser or device is not blocked.
5. **The wiring is not built:** confirm → `DurableWriteSession` → `writeContract`, polling to finality, the post-finality `VERIFIED` read, and a reconcile button. It needs its own approved phase, with:
   - random operation IDs (`crypto.randomUUID`);
   - read-only pre-checks for the baseline and nonce;
   - the same tests.

### 7.2 Manual steps for a future single browser-wallet write

These steps are not yet approved. Each needs your explicit go-ahead.

1. **Approve the wiring phase** (§7.1 item 5) and review it. Writes enabled only in a clearly labelled local experiment build, never in the default build.
2. **You** create a **dedicated browser profile** used only for this test.
3. **You** install a wallet extension from its official store in that profile and create a **new throwaway wallet**:
   - never import a real account;
   - the recovery phrase stays with you: never paste it into chat, a file or the app.
4. **You** add StudioNet to the wallet manually:
   - RPC `https://studio.genlayer.com/api`;
   - chain ID `61999`;
   - verify both in the wallet's network settings.
5. Start the experiment build on `http://127.0.0.1:5173` with `VITE_VERICOURT_CONTRACT_ADDRESS=0x3258A80A86920792354A9b7e59D5Ed2409E96220`, in that profile only.
6. On `#/wallet`:
   - press Connect;
   - confirm the account shown is the throwaway one;
   - confirm the chain shows 61999 "Matches StudioNet".
7. On `#/live`, run the read-only check: it must pass.
8. Confirm the write-safety status reads "No unresolved write is recorded in this browser".
9. Enter **fictional** case data, every field starting with "FICTIONAL", with a respondent address that is not yours.
10. On the review screen, check every field, the network, the account and the contract. Tick the acknowledgement. Press **Sign in wallet** **once**.
11. In the wallet prompt, verify all of these, and **reject** if anything differs:
    - network StudioNet / 61999;
    - account = the throwaway;
    - fee 0 / no fee;
    - interaction with `0xb7278A61aa25c888815aFC32Ad3cC52fF24fE575`.
12. Approve once. Don't press anything again. Don't use the wallet's "speed up" or "cancel".
13. **If the outcome is uncertain** (timeout, error, closed tab):
    - do not retry;
    - run read-only reconciliation;
    - check the wallet's activity list.

    The block stays until reconciliation resolves it.
14. Wait for finality, up to 30 min, and the `latest-final` read showing exactly one new matching case.
15. Afterwards:
    - stop the experiment build;
    - writes stay disabled in the default build;
    - write the report.

**Stop conditions:**
- any mismatch in steps 6–11;
- any guard refusal;
- any uncertain outcome (reconcile only).

### 7.3 Manual recovery of a permanently blocked record

There is no in-app override, by design. In this order:

1. Check the wallet's activity for a transaction from the account at that time.
2. Check `get_party_case_ids(account)` at `latest-final` for a matching case.
3. Only when you are satisfied it was not sent, or it was sent and is accounted for, remove the `vericourt.write.pending.v1` key from this site's storage in the browser's developer tools.

---

## 8. Stop

Preparation is complete. **No live wallet request or transaction submission will happen without your explicit approval** of the wiring phase and of the test itself.
