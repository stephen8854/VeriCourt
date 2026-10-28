# Phase 3.5: write-path preflight and transaction safety audit

**Recommendation: READY WITH CONDITIONS** for a *separately approved*, minimal write test, done in two stages:
- **Stage A:** an SDK-only test from Node with a throwaway in-memory account. **No browser wallet.**
- **Stage B:** a browser-wallet test, only after Stage A passes.

A browser-wallet write is **NOT READY** to attempt directly. Its two key unknowns can only be settled by a live write, and Stage A settles the riskier one without involving any wallet.

This phase was research only:
- no transactions, signatures, deployments or keys;
- no network calls (offline analysis only);
- no code, dependency or contract changes.

**Labels:**
- **[Source]**: genlayer-js 1.1.8 / viem 2.57.7 as installed in `frontend/node_modules`. Line numbers refer to `genlayer-js/dist/index.js` unless stated.
- **[Docs]**: the GenLayer documentation snapshot saved in Phase 0 (fetched 2026-10-14, `scratchpad/docs/full-docs.txt`) and the package README.
- **[Recorded]**: StudioNet data captured in earlier phases.
- **[Offline]**: computed locally from recorded data in this phase.
- **[Inference]**.
- **UNVERIFIED**.

## 1. The write path with a browser wallet

### 1.1 Configuration

- **Client:** `createClient({ chain: studionet, account: <address string>, provider: <EIP-1193> })`.
- **Wallet routing:** viem turns a string `account` into `{ address, type: "json-rpc" }` (`viem/_esm/accounts/utils/parseAccount.js`) [Source]. The transport then sends **only** `eth_accounts`, `eth_requestAccounts`, `eth_sendTransaction`, `eth_signTransaction`, `personal_sign` and `eth_signTypedData_v4` to the provider (`PROVIDER_METHODS`, 2354–2361). **Everything else** goes to the StudioNet RPC through a `fetch` with no timeout (2377–2419) [Source].
- **Two clients:** the README recommends a read client and a write client (README §"Using with a wallet provider") [Docs].

### 1.2 `writeContract` (667–696) → `_sendTransaction` (1090–1199)

1. **Calldata:** GenVM calldata (`makeCalldataObject` + `serialize`) is wrapped by `_encodeAddTransactionData` (937–973) into `addTransaction(sender, recipient, numInitialValidators=5, maxRotations=3, txData)` [Source].
   - The SDK's StudioNet ABI has only the 5-input overload, so the **primary** encoding is V5 and the **fallback** is V6 (adds `validUntil`).
   - [Offline] The recorded Phase 2.8 StudioNet transaction's calldata decodes with the SDK's ABI as exactly this V5 `addTransaction` (selector `0x27241a99`). StudioNet has accepted this encoding.
2. **Before the wallet:** `getCurrentNonce` (`eth_getTransactionCount`, block `"pending"`, 55–67), `estimateTransactionGas` (`eth_estimateGas`; **any failure is caught and replaced by 200 000**, 1105–1115) and `eth_gasPrice` (failure only logs a warning, 1148–1158). All three go to the RPC, not the wallet [Source].
3. **The wallet call:** `eth_sendTransaction` to the wallet with:
   - `from`, `to: chain.consensusMainContract.address`, `data`, `value: "0x0"`, `gas`, `nonce`, `type: "0x0"` (legacy), `chainId: "0xf22f"`, and `gasPrice` if obtained (1160–1175);
   - preceded by `assertChainMatch`, which **returns immediately for Studio chains** (2362–2363), so the SDK does not check the wallet's chain on StudioNet [Source].
4. **On Studio:** the SDK **returns the wallet's `eth_sendTransaction` result directly** (1176–1178). It does not wait for an EVM receipt and does not extract the transaction ID [Source].
   - On other chains it waits for the receipt and extracts the ID from `NewTransaction` / `CreatedTransaction` logs (1179–1189).
   - The local-account path does this on every chain, Studio included (1116–1147).
5. **Fallback resend:** if the first attempt throws an error that `isAddTransactionAbiMismatchError` matches ("invalid pointer", "could not decode", "invalid arrayify value", "types/value length mismatch"; 1047–1070), the SDK **repeats steps 2–4 with the V6 encoding**. In the wallet path that is a **second wallet prompt** (1191–1198) [Source].

### 1.3 Return value

- **Declared type:** `Promise<any>` (`index-C3Ul1Rte.d.ts` 2834–2845) [Source].
- **Runtime on Studio with a wallet:** whatever the wallet's `eth_sendTransaction` resolves to. For a standards-compliant wallet that is the 32-byte hash of the signed EVM transaction [Inference, from the EIP-1193 / `eth_sendTransaction` convention].

### 1.4 Is that hash the GenLayer transaction ID?

- **[Docs] In general, no:** "The outer EVM transaction has an EVM transaction hash… The created Intelligent Contract transaction has a protocol transaction ID… Do not assume that the two identifiers… are interchangeable" (`full-docs.txt` 1508–1513).
- **[Docs] Studio is different:** it "tracks contract and account state in its local database" and "does not fully model the live network's chain-layer and ghost-contract behavior" (8574–8576).
- **[Offline] On StudioNet they are the same, for the one recorded transaction:**
  - `keccak256(sim_config.signed_rollup_transaction)` of the Phase 2.8 assessment transaction equals its GenLayer `hash`/`tx_id`: `0xf6c085c9…07a1`;
  - the signed transaction recovers to the recorded sender (`0x71ac…d478`).

  So the GenLayer transaction ID is the hash of the signed EVM transaction. This is consistent with genlayer-js returning the EVM hash on Studio.
- **UNVERIFIED for genlayer-js plus a browser wallet.** The recorded transaction came from genlayer-py, sent with `eth_sendRawTransaction` to the zero address. A wallet transaction goes through the wallet's own broadcast and to a different address (§2), and Studio could treat it differently.

### 1.5 Can the value be passed to `getTransaction`, and can status and finality be observed?

- **[Source]** Studio `getTransaction` calls `eth_getTransactionByHash` and adds `statusName` (1496–1505).
- **[Recorded, Phase 3.3]** Live browser lookups of six StudioNet transaction IDs worked, and `classifyTransaction` handles the returned shape (finality via `statusName`, consensus via `result_name`, the leader receipt by `mode`).
- **UNVERIFIED for a freshly wallet-submitted transaction:**
  - whether the transaction is retrievable immediately after `eth_sendTransaction` resolves;
  - what an unknown or not-yet-indexed hash returns. [Inference] If StudioNet returns `null`, the SDK will throw a `TypeError` (it reads `.status` of null), which must be treated as "not found yet / read failure", never as a status.

### 1.6 How failures surface [Source + Inference]

| Event | How it surfaces | Was anything sent? |
|---|---|---|
| Wallet rejection | `eth_sendTransaction` rejects (EIP-1193 code 4001) | No [Inference] |
| Pre-wallet RPC failure (`eth_getTransactionCount`, `eth_gasPrice`) | `fetch` error or JSON-RPC error object is thrown before the wallet is asked. `eth_gasPrice` failure is swallowed; `eth_estimateGas` failure is silently replaced by 200 000 | No |
| Pre-wallet hang | The SDK's `fetch` has no timeout, so `writeContract` never settles. **If the app gives up, the SDK may still prompt the wallet later** | No, but possible later |
| Wallet or RPC error after signing (for example the node rejects the broadcast) | Wallet-specific error from `eth_sendTransaction` | Unknown |
| Malformed return | No validation in the SDK: `writeContract` returns whatever the wallet gave | Unknown |
| Wallet promise never settles | `writeContract` never settles | **Uncertain** |
| ABI-like error message | Silent second attempt with V6 encoding (second prompt) | Possibly twice |

## 2. Consensus-contract discrepancy

- **Where the SDK address comes from [Source]:**
  - `chains.studionet.consensusMainContract.address = 0xb7278A61aa25c888815aFC32Ad3cC52fF24fE575` (`chunk-XCQTIUTU.js` 4034–4035, used in the chain at 8016–8043). The ABI is bundled with it.
  - `initializeConsensusSmartContract()` is a deprecated no-op that only warns: "The consensus contract is now resolved from the static chain definition" (2345–2349).
  - [Docs] confirms this for "the v2 client" (`full-docs.txt` 6546) and warns that "chain identity and consensus contract addresses must move together" (1792).
- **Where it is used [Source]:**
  - as the **`to`** of every write and deploy;
  - its ABI to **encode** `addTransaction` and to **parse** `NewTransaction` events (local-account path only);
  - `consensusDataContract` (`0x88B0…`) is used only by the **non-Studio** `getTransaction` path (1506–1514).
  - **Not used** for StudioNet reads (`gen_call`) or Studio transaction lookups.
- **The zero address:**
  - [Recorded] It is what the StudioNet RPC method `sim_getConsensusContract("ConsensusMain")` returned in the Phase 2.14, 2.15 and 2.17C read-only preflights.
  - genlayer-py 0.16.3 used that value for Studio chains, so all Python-harness writes, which StudioNet accepted, were sent to `0x0000…0000`. [Offline] The Phase 2.8 signed transaction decodes with `to = 0x000…000`, gas price 0, legacy, chain 61999.
- **Consequence:** genlayer-js 1.1.8 would send the same calldata to `0xb7278A61…` instead.
  - Nothing in the local docs or SDK establishes how StudioNet treats a transaction to that address: whether it ignores `to`, accepts it, rejects it, or handles it as a plain transfer.
  - **UNVERIFIED, and the main risk of the write path.** It is not concluded harmless. No address was guessed or substituted.

## 3. Gasless submission on StudioNet

- **[Docs]** "Studio's EVM-compatible wallet layer is gasless: `eth_gasPrice` returns `0`, and `eth_estimateGas` returns a compatibility estimate" (8572).
  - Consensus v0.6 protocol fees are a separate layer that "can still be enabled", to be detected from the SDK fee estimate (8572, 1794–1806, 10092–10102).
  - v0.6 belongs to the genlayer-js **v2.0 RC** family on studio-dev (61997), not to the 1.1.8 / StudioNet (61999) combination (1777–1792).
- **[Offline]** The recorded StudioNet transaction had gas price 0 and value 0 and was accepted.
- **[Recorded]** All 18 Python-harness writes in Phases 2.14–2.17C used fresh, unfunded accounts with gas price 0, and all succeeded.

**What a browser-wallet write needs:**

| Requirement | Status |
|---|---|
| A **wallet signature** (`eth_sendTransaction` always prompts) | Yes [Source] |
| A **funded account** | Not if gas price is 0 and value is 0 [Docs + Recorded]. Whether a given wallet will sign a 0-gas-price transaction from a 0-balance account is **UNVERIFIED** |
| A **relayer or special handling** | None in the SDK. The wallet broadcasts itself, so it must be configured with StudioNet (chain 61999, RPC `https://studio.genlayer.com/api`) [Source + Inference] |
| **Config not yet implemented** | A write client with `account` + `provider`; an app-side chain check before every write (the SDK skips it on Studio); timeouts; the safeguards in §4 [Source] |
| **v0.6 fee distribution** | Not supported by 1.1.8. Not needed on StudioNet as observed on 2026-10-17 [Recorded]. Re-check before the test [Inference] |

## 4. Safe write lifecycle

### 4.1 States

| # | State | Entered when | Success? |
|---|---|---|---|
| 1 | Not submitted | No write started, or reconciliation proved nothing was sent | — |
| 2 | Wallet approval pending | `eth_sendTransaction` forwarded to the wallet | no |
| 3 | Rejected before submission | Wallet returned 4001, or a pre-wallet step failed before any `eth_sendTransaction` | no; nothing sent |
| 4 | Submitted, transaction ID known | Wallet returned a well-formed 32-byte hash (on Studio this *should* be the GenLayer ID, §1.4) | no; not yet |
| 5 | Submitted, transaction ID unknown | `eth_sendTransaction` was forwarded but no valid hash came back (timeout, malformed, error after signing) | **uncertain: blocks all writes** |
| 6 | Transaction pending | Status lookups show a pending state | no |
| 7 | Execution failed | ACCEPTED + MAJORITY_AGREE + leader not `return` | no |
| 8 | Validator disagreement | `result_name` MAJORITY_DISAGREE (not final) | no; no state change |
| 9 | Undetermined | UNDETERMINED without disagreement, NO_MAJORITY, timeouts, CANCELED | no |
| 10 | Finalized successfully | FINALIZED + MAJORITY_AGREE + leader `return`, **and** the expected state change seen in a `latest-final` read | **yes, only here** |
| 11 | Finalized unsuccessfully | FINALIZED with disagreement, a failed execution or inconclusive | no |
| 12 | Status lookup failed or timed out | Repeated read failures or the poll deadline passed | **uncertain: blocks writes** |

"Accepted (not final)" is shown as an intermediate state between 6 and 10. It is never reported as success.

### 4.2 Fit with the existing code

- **`tx/classify.ts`:** already provides the decided categories, verified on the live genlayer-js shape (Phase 3.3).
- **Gaps in `tx/state.ts`, all small changes for the implementation phase:**
  - "rejected before submission" collapses into `idle` with a note;
  - "finalized unsuccessfully" isn't separate from `execution_failed`, `validator_disagreement` and `undetermined`;
  - "ID unknown" and "uncertain" are one state;
  - there's no "not found yet" handling.

### 4.3 Supporting the model without modifying the SDK

Pass `createClient` a **guarded EIP-1193 provider** that wraps `window.ethereum` [Inference: the SDK accepts any `provider` and routes only `PROVIDER_METHODS` to it, 2381–2388]. The wrapper:
1. Forwards `eth_sendTransaction` **at most once per armed write**. A second call (the V6 fallback) is refused, which blocks the duplicate prompt from §1.2 step 5.
2. **Checks before forwarding:**
   - `eth_chainId` is `0xf22f`;
   - `from` is the connected account;
   - `data` starts with selector `0x27241a99` and the encoded recipient equals the configured contract;
   - `to` is the address that Stage A verified.
3. **Records** (a journal, as in the Phase 2.13 harness): forwarded or not, the returned hash or error code, timestamps, the pre-send nonce. Never parameters that could identify keys.
4. **Disarms** when the app abandons a write (timeout or navigation), so a late SDK call can never reach the wallet.
5. **Refuses** `eth_sign`, `personal_sign`, `eth_signTypedData*`, `eth_signTransaction` and `wallet_*` network methods.

The app then:
- runs `writeContract` under a deadline;
- takes the hash from the **journal**, not the SDK result alone;
- **requires** them to match when both exist;
- polls `getTransaction` with a bounded deadline, treating not-found as "not found yet" until the deadline;
- never retries.

**Read-only reconciliation for states 5 and 12, before any further write is allowed:**
- **Nonce:** `eth_getTransactionCount(account, "latest" and "pending")` against the recorded pre-send nonce.
- **Hash:** if a hash is known, look up the transaction.
- **Contract state:**
  - `create_case`: `get_party_case_ids(claimant)` count and the newest case's title against the intent;
  - `submit_evidence`: the case's evidence list against the intended label and reference;
  - `submit_reply`, `process_reply_deadline`, `request_assessment`: the case status (the contract rejects repeats of these).
- **Outcome:** only "provably not sent" (nonce unchanged after the deadline, and state unchanged) returns to state 1. Anything ambiguous stays blocked, with instructions to check the wallet's activity list.

## 5. Deployment and duplicate-write safeguards

**Future procedure** (nothing deployed now):

1. **Pick the deployment explicitly.** Record it in a committed, reviewed config entry, separate from `config/testDeployments.ts`, with:
   - network name and chain ID (61999);
   - contract address;
   - deploy transaction ID;
   - the SHA-256 of the reviewed `contracts/vericourt.py`;
   - the reviewed source revision;
   - the deployer address (public);
   - date and purpose.

   Test deployments stay in a separate type that the write layer cannot accept [Inference: type-level separation].
2. **Verify before enabling writes,** reusing the Phase 3.3 checks; refuse writes on any mismatch:
   - `eth_chainId = 0xf22f`;
   - `gen_getContractCode` hashes to the recorded SHA-256;
   - the deploy transaction's `contract_address` equals the address;
   - `get_contract_info` reports the expected schema and methodology versions.
3. **Prevent duplicates:**
   - one in-flight write per (contract, account) globally, not just per action, persisted in `localStorage` so a reload can't bypass it;
   - a pending record with the action, an argument digest (no free text), the pre-send nonce, the transaction ID if any, and a timestamp;
   - `create_case` / `submit_evidence` re-enabled only after reconciliation (§4.3);
   - every write UI requires an explicit confirmation showing exactly what will be written publicly.
4. **Audit record:**
   - for experiments, a report and log in `docs/` / `integration-logs/` with the chain, contract, transaction IDs, statuses, read-backs and the journal;
   - no private keys, seed phrases or wallet secrets anywhere;
   - Stage A's throwaway key exists only in process memory and is never printed or written (as the Phase 2.13 `StepLog` scrubber does).

## 6. Proposed minimal experiment (requires separate approval)

### Stage A: SDK-only, no browser wallet

- **Goal:** settle whether genlayer-js 1.1.8 can submit to StudioNet with its static consensus address, whether its transaction ID equals the EVM hash, and whether it is gasless. This uses the SDK's **local-account** path, which waits for the EVM receipt and extracts the transaction ID from logs, so both identifiers are observable side by side.
- **Writes: exactly 1.** `create_case` on the existing Phase 2.17C throwaway contract `0x3258A80A…6220`, with fictional, tagged data (it would become `VC-000002`). No deploy.
  - Alternative if you prefer not to reuse that contract: deploy plus `create_case` (2 writes).
- **Preconditions:**
  1. **Read-only checks first:** `eth_chainId`, `sim_getConsensusContract("ConsensusMain")` (record the value), `eth_gasPrice` (expect `0x0`), the code-hash check of the target contract, and `get_case_count`.
  2. A throwaway key generated in memory for this one process: never persisted, printed or reused; nonce 0 checked.
  3. Every network call bounded by a timeout. Exactly one write, never retried.
  4. A log in `integration-logs/`, scrubbed of the key.
- **Record:**
  - the EVM hash (from the raw-transaction path);
  - the transaction ID from the `NewTransaction` log;
  - the `to` used and whether StudioNet accepted it;
  - `getTransaction` from submission to FINALIZED;
  - the `latest-final` read-back of the new case.
- **Stop conditions:**
  - any precondition fails;
  - `eth_gasPrice` is not 0;
  - the SDK throws before or after sending;
  - the transaction ID is missing, or differs from the EVM hash and can't be explained;
  - the status isn't FINALIZED_SUCCESS by the deadline;
  - the read-back doesn't show exactly one new case matching the intent.

  In every case: no resubmission, and a report.

### Stage B: browser wallet (only after Stage A passes)

- **Requires:**
  - a wallet **you** operate in a dedicated test browser profile, with a throwaway account that holds nothing;
  - StudioNet added manually to that wallet;
  - the guarded provider from §4.3;
  - a temporary, clearly labelled experiment build, with writes disabled again afterwards;
  - you present to approve one `create_case`.
- **Verifies:**
  - the wallet path's return value;
  - the wallet's acceptance of a 0-gas-price transaction;
  - the transaction-ID match;
  - the UI lifecycle.
- **Not done by Claude:** Claude does not use your everyday browser or wallet.

## 7. Verified vs inference vs unknown

**Verified:**

| Fact | Basis |
|---|---|
| Write and deploy code path, argument shapes, V5-primary/V6-fallback encoding, Studio wallet path returning the wallet's hash unprocessed, no Studio chain check, 200 000 gas fallback, deprecated consensus initialisation, static `0xb727…` address, provider routing set | [Source] |
| StudioNet GenLayer transaction ID = keccak of the signed EVM transaction (one Python-path transaction); that transaction went to the zero address with gas price 0 and V5 calldata | [Offline] |
| Studio documented as gasless at the EVM layer; EVM hash vs protocol ID documented as generally distinct | [Docs] |
| Live genlayer-js transaction shape and classification | [Recorded] (Phase 3.3) |

**Inference:**
- the wallet returns the signed-transaction hash;
- on Studio that hash should be the transaction ID;
- 4001 means nothing was sent;
- the guarded-provider design works with the SDK's transport.

**Unknown (UNVERIFIED):**
- StudioNet's handling of a transaction to `0xb7278A61…`;
- genlayer-js transaction IDs on a live write;
- wallet acceptance of gasless transactions from an empty account;
- what `getTransaction` returns for a just-submitted or unknown hash;
- wallet error codes after signing;
- whether StudioNet still runs without v0.6 fees on the test date.

## 8. Exact remaining blockers

1. **(Critical)** The consensus-contract address (`0xb727…` in the SDK vs `0x0` in Studio's report and genlayer-py's writes): settled by Stage A.
2. **(Critical)** The transaction-ID return value for genlayer-js writes: Stage A for the SDK; Stage B for the wallet path.
3. **(High)** A real wallet signing a 0-gas-price transaction from an empty account on 61999: Stage B.
4. **(High)** The SDK's fallback resend and unbounded pre-wallet fetches: the guarded provider plus disarm (§4.3), built and tested before Stage B.
5. **(Medium)** Not-found handling right after submission: observed in Stage A and handled in the poller.
6. **(Medium)** The lifecycle gaps in `tx/state.ts` (§4.2): implementation work.
7. **(Medium)** No designated application deployment (§5).
8. **(Low)** README claims the SDK throws on a wrong chain; that is false on Studio [Source vs Docs]. The app's own chain check covers it.

## 9. Confirmation

- No transactions, signatures, deployments, private keys or wallet permission changes.
- No network calls.
- No dependency, contract, test or application code changes. The only file created is this report.
- One offline Node script in the session scratchpad read the recorded fixture and genlayer-js's own chain/ABI definitions.
- Waiting for explicit approval before any write experiment.
