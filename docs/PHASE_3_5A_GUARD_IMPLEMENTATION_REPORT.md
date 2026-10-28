# Phase 3.5A: guarded write path, implementation and audit

**Status:** implemented and tested offline. Nothing was sent to StudioNet. No transaction, deployment, wallet signature or private key was created. No dependency changed. `contracts/vericourt.py` is unchanged (SHA-256 `25bc9e0b…79333`). Writes stay disabled, and the new code is not connected to the UI.

**Short answer to the blocker question:** the SDK's V6 fallback **can** be controlled safely without modifying genlayer-js. The control does not rely on hiding or rewording errors. It sits at the only two places the SDK can create a transaction (the wallet provider and the account's `signTransaction`), and both accept exactly one request per operation. The fallback still runs inside the SDK, is refused at the guard, and is written to the journal. A test runs the real genlayer-js 1.1.8 `writeContract` and shows this.

Labels used below:
- **[Verified offline]:** shown by tests running the real SDK code against in-memory mocks.
- **[Source]:** read from `node_modules/genlayer-js/dist/index.js` (1.1.8).
- **[Unverified]:** needs a live run.

---

## 1. Files changed

**New: `frontend/src/write/`** (not imported by any page; enforced by a test)

| File | Purpose |
|---|---|
| `bytes.ts` | Hex helpers, a strict canonical RLP codec, and a legacy signed-transaction parser (no hashing, no keys) |
| `addTransaction.ts` | Strict encoder/decoder for the V5 `addTransaction(address,address,uint256,uint256,bytes)`. Selector `0x27241a99` |
| `intent.ts` | `buildWriteIntent`: the exact request one approved operation may make, built with the SDK's own exported calldata helpers. `studionetWriteParams()` reads the SDK's studionet constants |
| `guard.ts` | `WriteGuard` (single-use permit, disarm, journal), `GuardRefusal`, and pure request checks |
| `guardedProvider.ts` | Guarded EIP-1193 provider for the browser-wallet path (Stage B shape) |
| `guardedAccount.ts` | Guarded local account for the SDK-only path (Stage A shape). It wraps a caller-supplied signer |
| `guardedFetch.ts` | Guarded `fetch` for Stage A: an RPC allowlist and at most one `eth_sendRawTransaction`, of the exact signed bytes |
| `runner.ts` | `runGuardedWrite`: bounded wait; the outcome is derived from the journal (`not_sent` / `rejected` / `submitted` / `uncertain`) |
| `reconcile.ts` | Read-only reconciliation decision (pure) |
| `session.ts` | `WriteSession`: the state model plus one guard per operation; blocks while uncertain |
| `*.test.ts` | `encoding`, `guardedProvider`, `guardedAccount` (including fetch), `runner` (including reconcile and session), `sdkPath` (real SDK), `isolation` |

**Modified**

| File | Change |
|---|---|
| `frontend/src/tx/state.ts` | Extended from 13 to 18 phases (§5). New events: `NOT_SENT`, `NOT_FOUND_YET`, `VERIFIED`, `VERIFICATION_MISMATCH`. `RECONCILED_NOT_SENT` now carries its basis. Non-final failures now block |
| `frontend/src/tx/state.test.ts` | Rewritten for the extended model |
| `frontend/README.md` | Short "Guarded write path" section |

**New test helper:** `frontend/src/test/writeHarness.ts`. It provides:
- a fake wallet and an in-memory JSON-RPC responder;
- a fake signer that returns structurally valid legacy RLP with **dummy r/s values** (not a signature).

**Unchanged:**
- `package.json` / `package-lock.json`;
- `config/network.ts` (`CONTRACT_WRITES_ENABLED = false`);
- every page and component;
- the Python contract, its ABI, storage layout and tests.

---

## 2. The exact request path, and how duplicates are prevented

### 2.1 What genlayer-js 1.1.8 does on `writeContract` [Source]

1. **`writeContract`** (667–696):
   - builds `_txData = serialize([encode(makeCalldataObject(method, args)), leaderOnly])`;
   - calls `_encodeAddTransactionData` (937–973). For studionet (an ABI with 5 inputs), the **primary encoding is V5 and the fallback is V6**.
2. **`_sendTransaction`** (1090–1199):
   - reads the nonce once (`eth_getTransactionCount`, `pending`);
   - runs `sendWithEncodedData(primary)`.
   - **Fallback:** if that throws an error whose text contains "invalid pointer", "could not decode", "invalid arrayify value" or "types/value length mismatch" (`isAddTransactionAbiMismatchError`, 1047–1070), it calls `sendWithEncodedData(fallback)`, **with the same nonce**.
3. **Inside `sendWithEncodedData`:**
   - `eth_estimateGas` (failure falls back to 200000), then `eth_gasPrice`;
   - **Wallet path** (account given as an address string, 1148–1178): `eth_sendTransaction`. On Studio it returns the result directly (1176).
   - **Local-account path** (account object with `type: "local"`, 1116–1146):
     - `account.signTransaction(request)`, then `eth_sendRawTransaction`;
     - then `waitForTransactionReceipt`;
     - then it needs a `NewTransaction` or `CreatedTransaction` log, **and throws if there is none**.
4. **Transport routing** (2377–2419):
   - With an address-string account, only `PROVIDER_METHODS` (2354–2361) go to `config.provider`; `window.ethereum` is used only when no provider is given.
   - Everything else goes to the global `fetch` (looked up at call time), with no timeout and `retryCount: 0` (2425).
   - viem's `sendRawTransaction` also uses `retryCount: 0`.

### 2.2 Wallet path (future Stage B)

```
app ─► runGuardedWrite(deadline) ─► client.writeContract
         SDK reads (fetch → RPC): nonce, estimateGas, gasPrice
         SDK ─► guardedProvider.request("eth_sendTransaction", params)
              1. guard.claim()           ← synchronous; the single permit is taken before any await
              2. copy params; check: from, to = consensus address, selector 0x27241a99,
                 decoded _sender/_recipient/_txData, full calldata byte-equal,
                 value 0, chainId param 0xf22f, gasPrice 0, nonce (if pinned)
              3. wallet eth_chainId == 0xf22f, wallet eth_accounts[0] == sender
              4. if the guard was closed meanwhile → refuse
              5. forward the checked copy ONCE ─► wallet prompt
              6. record result: hash | rejected(4001) | error | malformed
```

Every other method is refused, including:
- `eth_requestAccounts`, `eth_signTransaction`, `personal_sign`;
- `eth_sign`, `eth_signTypedData_v4`;
- `wallet_*`;
- `eth_sendRawTransaction`.

`eth_chainId` and `eth_accounts` pass through as reads.

### 2.3 Local-account path (future Stage A)

```
app ─► runGuardedWrite(deadline) ─► client.writeContract   (client account = guarded local account)
         SDK reads via guardedFetch (read allowlist, 20 s abort each)
         SDK ─► guardedAccount.signTransaction(request)
              1. guard.claim()  (synchronous)
              2. copy only the 8 transaction fields; check type legacy, chainId 61999, to,
                 calldata byte-equal, value 0, gasPrice 0, gas ≤ 30M, nonce present / pinned
              3. inner signer signs (key never leaves the caller's closure)
              4. parse the signed bytes; every field must equal the approved copy, else withhold
              5. if the guard was closed while signing → withhold
              6. record the signed bytes (public once broadcast) and optional precomputed hash
         SDK ─► guardedFetch("eth_sendRawTransaction", bytes)
              only the exact recorded bytes, only once, only while the operation is open
              record: hash | rpc_error | transport_error | malformed
```

### 2.4 Duplicate prevention: the layers

| Duplicate source | Blocked by | Evidence |
|---|---|---|
| SDK V6 fallback (wallet) | The permit was already used, so the second `eth_sendTransaction` is refused before the wallet is called | `sdkPath.test.ts`: real SDK; wallet sees 1 send; RPC log shows the SDK did run the fallback (a second `eth_estimateGas` + `eth_gasPrice`) [Verified offline] |
| SDK V6 fallback (local) | The second `signTransaction` is refused; the inner signer is never called | `sdkPath.test.ts`: signer called once, 1 broadcast [Verified offline] |
| Double click / concurrent calls | Synchronous `claim()`. If a duplicate arrives during the first call's pre-send checks, **the whole operation closes and nothing is forwarded** (fail closed) | `guardedProvider.test.ts` |
| Second user action through the app | `WriteSession.begin` requires state `idle`; each operation gets a new guard; guards are never re-armed; `runGuardedWrite` refuses a used guard | `runner.test.ts` |
| Late SDK call after the deadline | The deadline disarms the guard; every later request is refused | `runner.test.ts` |
| Re-broadcast of signed bytes | `claimBroadcast`: only the recorded bytes, once, while open | `guardedAccount.test.ts` |
| Any refusal | Closes the operation for good; a "corrected" second request is also refused | `guardedProvider.test.ts` |

**Not a brittle workaround:**
- Errors from the wallet or RPC are passed through to the SDK unchanged.
- The guard does not rewrite errors to steer the SDK away from its fallback.
- The fallback happens and is visibly refused at a structural boundary.

The guard's own `GuardRefusal` messages avoid the four fallback phrases (a test checks this). That only means a refusal does not itself provoke a pointless fallback attempt; if one happens, it is refused too.

---

## 3. Bounded waiting and unknown submission

- **`runGuardedWrite(guard, submit, { timeoutMs })`:**
  - races the SDK call against a deadline;
  - **always disarms the guard before returning**;
  - derives the outcome from the journal.
- **The deadline cancels nothing already started.** genlayer-js has no cancellation. A wallet prompt that is already open stays open, and the user can still approve it. This code does not assume otherwise.
  - The late result is still written to the journal (`settledAfterDisarm: true`), so reconciliation can use a late hash or a late 4001.
  - Read calls in `guardedFetch` are aborted after 20 s. That is harmless, because they are reads.
  - **The broadcast itself is never aborted:** aborting the HTTP request would only lose the response.

**Outcomes (`runner.ts`):**

| Journal state | Outcome |
|---|---|
| No request ever left the guard (any SDK error, or the deadline) | `not_sent` (guard is closed, so nothing can leave later) |
| Wallet 4001 | `rejected` |
| Wallet hash, SDK returned the same value | `submitted` |
| Wallet hash, SDK returned something else | `uncertain: sdk_result_mismatch` |
| SDK returned a value with no guarded request | `uncertain: sdk_returned_without_guarded_request` (possible bypass) |
| Forwarded, deadline passed | `uncertain: timeout_while_wallet_open` |
| Forwarded, non-4001 error | `uncertain: wallet_error_after_forward` |
| Forwarded, malformed result | `uncertain: malformed_wallet_response` |
| Signer: failed, withheld, or still signing at the deadline | `not_sent` (the bytes cannot be released after close) |
| Signed, never broadcast, guarded fetch installed | `not_sent` |
| Signed, RPC returned a hash | `submitted` (even if the SDK then throws, e.g. no `NewTransaction` log) |
| Signed, broadcast timed out / RPC error / transport error / malformed | `uncertain` (with the precomputed hash if a hasher was supplied) |

---

## 4. Checks before any request may leave

| Check | Wallet path | Local path |
|---|---|---|
| Chain ID | Wallet `eth_chainId` = `0xf22f` (the SDK skips this on Studio, 2363), and the `chainId` param if present | `chainId` = 61999 in the request **and** in the signed bytes (EIP-155 `v`) |
| Sender | `from`, wallet `eth_accounts[0]`, and the encoded `_sender` | Wrapper refuses a signer whose address ≠ intent sender; encoded `_sender` |
| Target | `to` = intent `consensusAddress` | `to` in request and signed bytes |
| Selector | `0x27241a99` (V5) | same |
| Method and arguments | Decoded `_recipient` = contract; `_txData` = the approved call; full calldata byte-equal | same, plus a signed-bytes comparison |
| Value / gas price | 0 / 0 (StudioNet expected gasless) | 0 / 0; gas ≤ 30,000,000 |
| Nonce | Equals the pre-checked nonce when pinned | Present; equals the pin when pinned |

**On the consensus address:** the intent's `consensusAddress` is the SDK's static studionet value `0xb7278A61aa25c888815aFC32Ad3cC52fF24fE575`. A test pins it so a dependency change cannot move the target silently.
- **The mismatch is not resolved.** StudioNet reports `0x0` for this contract, and every earlier genlayer-py write went to `0x0` (the recorded Phase 2.8 transaction parses with `to = 0x000…000`).
- The guard only guarantees the request goes exactly where the intent says. Whether StudioNet accepts a transaction sent to `0xb727…` is **[Unverified]** until Stage A.

---

## 5. Transaction state model (`tx/state.ts`)

18 phases. **Settled** phases (a user may RESET to idle):
- `idle`
- `rejected`
- `not_sent`
- `finalized_unsuccessful`
- `verified`
- `verification_mismatch`

**Every other phase blocks new writes.**

| Required state | Phase(s) |
|---|---|
| Rejection | `rejected` (4001); `not_sent` (refused or failed before any request) |
| Confirmed submission | `submitted` (hash known; not success) |
| Uncertain submission | `submission_uncertain` |
| Pending execution | `pending`, then `accepted` (still not success) |
| Disagreement | `validator_disagreement` (non-final; **now blocks**) |
| Undetermined outcome | `undetermined` (non-final; **now blocks**) |
| Execution failure | `execution_failed` (non-final; **now blocks**); `finalized_unsuccessful` |
| Finality | `finalized` = final and successful, **post-finality read still due (blocks)** |
| Post-finality verification | `verified` (the **only** success state); `verification_mismatch` |
| Lookup failure / deadline | `read_failure`, `timed_out_unknown` |

**Changes from Phase 3.2:**
- **Rejection is its own state:** rejection no longer collapses into `idle`.
- **Non-final failures block:** a non-final failure, disagreement or undetermined result now blocks, so a transaction that later succeeds cannot be duplicated by a new write.
- **`finalized` requires a `VERIFIED` read:** it no longer counts as success.
- **No retry event:** there is still none (a test checks the event names).

---

## 6. Reconciliation (`reconcile.ts`)

An uncertain write stays blocked until **positive evidence** resolves it:

1. **Found:** a transaction with a hash **recorded by this operation** exists. A hash the operation did not record is not accepted.
2. **Not sent, by the guard journal:** no request ever left the guard, and the guard is closed.
3. **Not sent, by an explicit wallet rejection (4001),** even if it came late.
4. **Not sent, by a combination of evidence.** All of these must hold:
   - an explicit error response (not a timeout, not malformed);
   - an **unchanged nonce at both `latest` and `pending`**;
   - **contract effect absent**;
   - no transaction found by a known hash;
   - **`nonceTrackingVerified` is true.**

   That flag stays false until a live run shows StudioNet advances the sender nonce for a write. Until then rule 4 is off, and such writes stay blocked. This is stricter than the Phase 3.5 proposal.

**Everything else stays unresolved:**
- a timeout with the prompt still open is never "not sent", even with an unchanged nonce;
- a contract effect visible with no recorded transaction gives "do not resubmit".

---

## 7. Tests and build results

Run on 2026-10-17 in `frontend/`, Node 24:

| Command | Result |
|---|---|
| `npm run typecheck` | pass, 0 errors |
| `npm run lint` | pass, 0 problems |
| `npm test` | **437 passed / 23 files** (was 290 / 17) |
| `npm run build` | pass. `dist/` contains none of the guard's strings (`grep` count 0), so the write path is not shipped |

**New and updated tests:**

| File | Tests | Covers |
|---|---|---|
| `write/encoding.test.ts` | 20 | RLP strictness; Phase 2.8 transaction parse and byte-exact re-encode; V5 decode/re-encode; malformed calldata; SDK constants pinned; intent validation |
| `write/guardedProvider.test.ts` | 40 | single forward; private copy; duplicates (sequential, concurrent, after forward); late requests; disarm during pre-reads; late response recorded; 4001; other errors; 4 malformed responses; 9 request mismatches (target, selector, sender, call, chain param, value, gas price, params shape); wrong wallet chain; 3 wrong-account cases; nonce pin; refusal closes the operation; 8 forbidden methods; journal hygiene; fallback phrases |
| `write/guardedAccount.test.ts` | 33 | sign once; field copy; frozen public surface; hasher; wrong sender; fallback refused; 8 request mismatches; other sender's calldata; tampered bytes withheld; signer failure; close-while-signing; fetch: one broadcast, foreign bytes, unsigned, after close, RPC error, transport error, malformed, reads, 5 forbidden methods, URL/batch/GET, allowlist audit |
| `write/runner.test.ts` | 26 | deadline before request (late SDK call refused); deadline while the prompt is open (late hash recorded); no reuse; timeout required; always disarmed; SDK/journal mismatch; bypass detection; malformed; release without broadcast guard; 12 reconciliation cases; session blocking, reconciliation, per-operation guards, rejected, submitted→final→verified |
| `write/sdkPath.test.ts` | 9 | **real genlayer-js 1.1.8 `writeContract`**, both paths: byte-exact intent match; V6 fallback refused (wallet and signer); 4001; wrong wallet chain; different arguments; SDK throws after broadcast (no logs) still gives `submitted`; non-zero gas price stops before signing; nonce read failure |
| `write/isolation.test.ts` | 3 | writes disabled; nothing outside `src/write` imports it; no key generation, mnemonic, browser storage or env access in `src/write` |
| `tx/state.test.ts` | 34 | 18 phases; settled vs blocking partition; verification gate; final/non-final mapping; every blocking phase refuses PREPARE and RESET; reconciliation only from uncertain phases; no retry event |

**Mutation check:**
- **Method:** each safety-critical line was broken in turn, `src/write` + `src/tx` were re-run, and the file was restored. Script: `scratchpad/mutate_3_5a.py`.
- **Result: 12/12 caught:**

| # | Mutation | Result |
|---|---|---|
| M1 | permit reusable | caught |
| M2 | calldata unchecked | caught |
| M3 | wallet chain unchecked | caught |
| M4 | no disarm at deadline | caught |
| M5 | signed bytes released after close | caught |
| M6 | nonce trusted while unverified | caught |
| M7 | second broadcast allowed | caught |
| M8 | forward after close | caught |
| M9 | non-4001 error treated as rejection | caught |
| M10 | uncertain made resettable | caught |
| M11 | SDK result not compared | caught |
| M12 | signer gas price unchecked | caught |

---

## 8. New finding: genlayer-js and genlayer-py encode `leaderOnly=false` differently

The recorded Phase 2.8 genlayer-py write and the genlayer-js helpers produce **identical GenVM calldata**. They differ in the final RLP item, `leaderOnly=false`:
- genlayer-js serializes it as the byte **`0x00`**;
- genlayer-py sent the empty string **`0x80`**.

The SDK's own decoder reads both as `false` [Verified offline, `encoding.test.ts`].

**Whether StudioNet accepts the genlayer-js form is [Unverified].** This is a third thing Stage A will settle, alongside the consensus address and the transaction ID. A rejection here would show up as a failed or reverted submission, and the Stage A stop conditions cover that.

---

## 9. Remaining SDK limitations

1. **No cancellation and no transport timeout.** The deadline only stops the app waiting and closes the guard. An open wallet prompt cannot be withdrawn by the app. The user must reject it in the wallet.
2. **The fallback still runs inside the SDK.** It costs an extra `eth_estimateGas` and `eth_gasPrice` (reads), then a refusal. It cannot be switched off without modifying the dependency. It no longer reaches the wallet or the key.
3. **The local path depends on receipt logs.** It throws when the receipt has no `NewTransaction`/`CreatedTransaction` log, even after a successful broadcast. The runner treats the RPC hash as authoritative in that case. Whether StudioNet receipts carry these logs is [Unverified].
4. **The local path's default receipt wait is long.** viem's default is 180 s, inside `writeContract`. The app deadline must be set with that in mind (Stage A proposal: 240 s).
5. **The SDK has no chain check on Studio** (`assertChainMatch`, 2363). The guard checks the chain instead.
6. **`connect()` and `cancelTransaction()` use `window.ethereum` directly** (1574, 1645–1710) and bypass `config.provider`. The app must never call them during or around a guarded write. Nothing in the app does today.
7. **`createClient({ endpoint })` mutates the shared chain object** (2422–2423), so it is not used.
8. **The transaction hash is not computed locally.** No keccak is available without adding a dependency. On the local path the hash comes from the RPC response, or from an optional hasher the Stage A script would inject (§11, decision D2).

---

## 10. Can the guard prove that no second transaction request occurs?

**Within its boundary, yes:**

- **Wallet path:**
  - The guarded provider forwards at most one `eth_sendTransaction` per operation. The permit is single-use, claimed synchronously, and never re-armed.
  - Every refusal and the deadline close the operation.
  - `requestsForwarded` in the snapshot is 0 or 1 by construction, and tests check it against the fake wallet's own call count, including with the real SDK's fallback.
- **Local path:**
  - At most one signed transaction can exist per operation: the signer is called at most once, and bytes are withheld after close or on mismatch.
  - With the guarded fetch installed, those bytes are broadcast at most once.

**Outside its boundary, no:**

1. **Code that calls the wallet directly.** This includes other code calling `window.ethereum`, other tabs, browser extensions, and the SDK's own `connect()` and `cancelTransaction()`. The guard only sees requests made through it.
2. **The wallet's own behaviour.** Examples are "speed up" or "cancel" replacements, or a wallet re-broadcasting. That is wallet-internal.
3. **Server-side handling** of a single submission, such as StudioNet duplicating it internally.
4. **Anything else holding the inner signer** (Stage A). The script must use the raw account only to build the guarded wrapper.
5. **Reloads (browser).** The block is in memory. Persisting the pending record is a Stage B precondition (§11).

So the guard proves "**this app's SDK call produced at most one transaction request**". It does not prove "the chain received at most one transaction".

---

## 11. Preconditions for a future Stage A write experiment

Nothing below has been executed. **Stage A requires your explicit approval.**

### 11.1 Decisions for you before approval

| # | Decision | Options |
|---|---|---|
| D1 | Target contract | **(a)** Write `create_case` (fictional) to the Phase 2.17C throwaway `0x3258A80A…6220`: 1 write. `config/testDeployments.ts` says that deployment is "never used for writes"; that refers to the app, which still will not write to it, but the comment should be updated if you choose (a). **(b)** Deploy a fresh throwaway contract, then `create_case`: 2 writes, and the deploy goes through a separate guard and intent (needs a small `deployContract` intent, not built yet) |
| D2 | Hash before broadcast | **(a)** Import `keccak256` from viem 2.57.7, already installed as a genlayer-js dependency but not declared, in the one-off script only. **(b)** Declare `viem@2.57.7` (no version change, but a `package.json` change). **(c)** No precomputed hash; rely on the RPC response, so a lost broadcast response stays unresolved. Recommended: (a) or (b) |
| D3 | Deadlines | Proposed: write deadline 240 s (covers viem's 180 s receipt wait); status polling to FINALIZED bounded at 30 min; each read 20 s |

### 11.2 Disposable account, held only in memory (item 9)

1. A one-off Node script (run from `frontend/`, Node 24), written only after approval. It creates the key inside the process with genlayer-js `createAccount()` (`privateKeyToAccount(generatePrivateKey())`, dist 2460–2466).
2. The key variable is used once, to build the inner signer, and then only the guarded account is used:
   - it is never logged, returned, serialized or written;
   - no environment variable or file holds it;
   - the process exits after the run, and nothing is reused.
3. Only public values are logged: the account's **address**, the signed transaction bytes (public once broadcast), hashes, statuses, nonces, and the guard journal.
4. **The journal is checked before saving:** the saved log is scanned for any 64-hex-character string that is not a known transaction or block hash, as the Phase 2.13 `StepLog` scrubber does. A hit aborts saving.
5. The account starts with **nonce 0 and no balance**. Nothing is funded.
6. **Data is fictional and tagged:**
   - the respondent is a second address that is never used to sign;
   - every text field carries a "FICTIONAL — VeriCourt Phase 3.5A Stage A" marker;
   - no real names, emails or links.

### 11.3 Mandatory read-only prechecks (abort on any failure)

1. **Chain:** `eth_chainId` = `0xf22f`.
2. **Gas price:** `eth_gasPrice` = `0x0`.
3. **Nonce:** `eth_getTransactionCount(address, "latest")` = `pending` = 0.
4. **Consensus contract:** record what StudioNet reports for it (Phase 3.5 §2) next to the SDK's static `0xb7278A61…`, for the report. **This does not decide anything.**
5. **Target contract:** for D1(a), `gen_getContractCode` hashes to `25bc9e0b…79333`.
6. **Baseline reads:** `get_case_count` / party case IDs for the new address, for the post-write comparison.
7. **Clean run checks:**
   - `CONTRACT_WRITES_ENABLED` is still `false`;
   - `npm test` is green at the commit used;
   - the guarded fetch is installed as the process's `fetch` before `createClient`;
   - the client's account is the guarded account.

### 11.4 Execution rules

- Exactly **one** `writeContract`, through `WriteSession.begin` → `run`, with `broadcastGuarded: true` and an intent with `expectedNonce: 0n`.
- **No retry and no second operation**, whatever the outcome.
- **Record:**
  - the full journal snapshot;
  - the outcome;
  - the RPC hash, and whether it equals the precomputed hash (D2);
  - the SDK result (`NewTransaction` txId, or the error);
  - `to` as sent (`0xb727…`);
  - whether StudioNet accepted it;
  - `getTransaction` from submission to FINALIZED;
  - nonce after (`latest` / `pending`), to settle `nonceTrackingVerified`;
  - the `latest-final` read-back.

### 11.5 Stop conditions (stop, no resubmission, write a report)

- Any precheck fails.
- Any guard refusal.
- An outcome other than `submitted`.
- Broadcast rejected, e.g.:
  - wrong consensus address;
  - `leaderOnly` encoding rejected;
  - nonce or signature rejected.
- The RPC hash differs from the precomputed hash.
- The SDK's log txId differs from the RPC hash, with no explanation.
- The status is not FINALIZED_SUCCESS by the deadline.
- The `latest-final` read does not show **exactly one** new case matching the fictional intent.

### 11.6 What Stage A would settle, and what it would not

**Settles:** for **genlayer-js, local-account path**:
- whether StudioNet accepts the SDK's static consensus address;
- the `leaderOnly=0x00` encoding;
- whether the RPC hash equals the GenLayer transaction ID;
- gasless signing from a zero-balance account;
- nonce advance;
- receipt logs.

**Does not settle anything about browser wallets:**
- whether a wallet signs a 0-gas-price legacy transaction;
- whether the wallet path's return value is the transaction ID.

The offline Phase 3.5 hash finding and the Stage A result together are still **not proof of browser-wallet behaviour**. That remains Stage B.

### 11.7 Additional preconditions for Stage B (later)

- Stage A passed.
- The pending-operation record persisted across reloads, before any UI is wired.
- A wallet you operate, in a dedicated test profile.
- Your explicit approval of the one prompt.

---

## 12. Confirmation

- **Nothing sent:**
  - no network call to StudioNet (the test setup makes every network API throw; the SDK tests use an in-memory responder);
  - no transaction, deployment or wallet signature;
  - no private key generated (the test signer returns dummy r/s bytes).
- **Nothing changed that was off-limits:**
  - no dependency change;
  - no change to the contract, its ABI, storage layout or Python tests;
  - no commit;
  - writes remain disabled, and `src/write` is not connected to the UI or shipped in the build.
- **Not claimed:**
  - The consensus-address discrepancy is **not** claimed resolved.
  - The offline transaction-hash finding is **not** treated as evidence of browser-wallet behaviour.
