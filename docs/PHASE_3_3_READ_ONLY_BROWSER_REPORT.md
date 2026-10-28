# Phase 3.3: read-only StudioNet browser integration

**Result:** the real frontend, running in a browser, reached StudioNet through genlayer-js 1.1.8. It confirmed the Phase 2.17C test deployment and read all six case views at both `latest-nonfinal` and `latest-final`. Every value decoded and validated, and matched the recorded StudioNet read-back exactly. All six known transactions were looked up and classified `FINALIZED_SUCCESS`.

No CORS or other browser restriction blocked anything. Nothing was written, signed, deployed or retried; contract writes remain disabled.

**Labels:**
- **[Live]**: observed in the browser in this phase.
- **[Recorded]**: StudioNet data captured by the Python harness in earlier phases.
- **[Reconstructed]**: recorded values placed into an inferred shape.
- **[Inference]**: reasoned, not observed.

## 1. Environment

| Item | Value |
|---|---|
| Browser | Claude desktop app browser pane: Chromium 152 (`Chrome/152.0.7977.149`), secure context, **no injected wallet** (`window.ethereum` absent) |
| App | `frontend/` production build (`vite build`), served by `vite preview` at `http://127.0.0.1:4173` |
| SDK | `genlayer-js` 1.1.8 (installed files byte-identical to the copy audited in Phase 3.1), `viem` 2.57.7. Loaded lazily, only when the check starts |
| Endpoint | `https://studio.genlayer.com/api`: the SDK's built-in `chains.studionet` RPC URL (no `endpoint` override) |
| Chain ID observed | **`0xf22f` (61999)** [Live] |
| Contract | `0x3258A80A86920792354A9b7e59D5Ed2409E96220` (Phase 2.17C throwaway deployment, fictional data) |
| Case | `VC-000001` |
| Dates | Runs on 2026-10-17 (run 1, and run 2 after a display fix; identical results) |

## 2. Before any contract read

All [Live], from run 1; run 2 gave the same results.

| Step | Call | Result |
|---|---|---|
| RPC check | `eth_chainId` | `"0xf22f"`, as expected. Response received and decoded |
| Deployment evidence 1 | `getTransaction(0x4557…1567)`, the Phase 2.17C deploy transaction | Returned `data.contract_address = 0x3258A80A86920792354A9b7e59D5Ed2409E96220`, matching |
| Deployment evidence 2 (required) | `gen_getContractCode(0x3258…6220)` | SHA-256 of the returned source = `25bc9e0b2bae1a47a64a1324e54123ff132bf343d4a15d5be4e8f7d762e79333`, **identical** to `contracts/vericourt.py` in this repo (a unit test pins that hash to the file) |
| Contract info | `get_contract_info()` @ latest-nonfinal | Decoded and valid (no recorded counterpart to compare) |
| Case existence | `get_case_count()` @ latest-nonfinal → `1` | `VC-000001` ≤ 1, so the case exists on this contract |

The check is built to stop before any contract read if the chain ID, the code hash or the deploy address does not match. Unit tests cover each of those stops.

## 3. Contract reads

Every read used an explicit consistency mode. **The SDK's default** is `latest-nonfinal` (verified from `dist/index.js` `readContract`). "Matches recorded" compares the live value with the **[Recorded]** Phase 2.17C latest-final read-back.

**Results for every read below, at both variants:** the request reached the endpoint, a response was received, the SDK decoded it, the validator accepted the shape, and the value matched the recording. No errors, timeouts or discrepancies. [Live]

| Function | Args | Matches recorded | Duration (run 1, nonfinal / final) |
|---|---|---|---|
| `get_case` | `"VC-000001"` | yes / yes | 1309 / 1300 ms |
| `get_case_status` | `"VC-000001"` | yes / yes (\*) | 1606 / 1382 ms |
| `get_case_evidence` | `"VC-000001"` | yes / yes | 1382 / 1325 ms |
| `get_case_history` | `"VC-000001"` | yes / yes | 1293 / 1270 ms |
| `get_assessment_status` | `"VC-000001"` | yes / yes | 1278 / 1399 ms |
| `get_assessment` | `"VC-000001"` | yes / yes | 1401 / 1348 ms |

(\*) The harness never recorded `get_case_status`. Its expected value is **derived** from the recorded `get_case`, since every `get_case_status` field is also a `get_case` field.

**Decoding [Live]:**
- genlayer-js's default `jsonSafeReturn` produced plain objects, arrays, strings and booleans.
- Integers came back as JavaScript numbers (all are below 2^53).
- Addresses came back as the contract's checksummed hex strings.
- The decoded values are deep-equal to the genlayer-py read-back, so both SDKs decode these views identically.

**Finality:**
- The case status is `DECIDED` at both variants, so the UI shows **"Assessment recorded"** with **"Final (confirmed by a latest-final read)"**. The finality label is derived from the latest-final read, not from `DECIDED` [Live].
- [Inference] A latest-final read matching latest-nonfinal shows the state is finalized, consistent with the six FINALIZED transactions below.

## 4. Transaction lookups

**[Live]** All six Phase 2.17C transactions were looked up via `client.getTransaction({hash})`. The SDK's Studio path uses `eth_getTransactionByHash`.

| Operation | `statusName` / `status` | `result_name` | `num_of_rounds` | `last_round.validator_votes_name` | Classified |
|---|---|---|---|---|---|
| deploy | FINALIZED / 7 | MAJORITY_AGREE | 1 | AGREE, IDLE, AGREE, IDLE, AGREE | FINALIZED_SUCCESS |
| create_case | FINALIZED / 7 | MAJORITY_AGREE | 1 | AGREE, AGREE, AGREE, IDLE, IDLE | FINALIZED_SUCCESS |
| submit_evidence (E1) | FINALIZED / 7 | MAJORITY_AGREE | 1 | IDLE, IDLE, AGREE, AGREE, AGREE | FINALIZED_SUCCESS |
| submit_evidence (E2) | FINALIZED / 7 | MAJORITY_AGREE | 1 | IDLE, AGREE, AGREE, IDLE, AGREE | FINALIZED_SUCCESS |
| process_reply_deadline | FINALIZED / 7 | MAJORITY_AGREE | 1 | IDLE, AGREE, IDLE, AGREE, AGREE | FINALIZED_SUCCESS |
| request_assessment | FINALIZED / 7 | MAJORITY_AGREE | 1 | IDLE, IDLE, AGREE, AGREE, AGREE | FINALIZED_SUCCESS |

The statuses, results, round counts and vote lists are identical to the Phase 2.17C finality read-back [Recorded].

**Shape returned by genlayer-js 1.1.8 in the browser** [Live; verbatim subset saved as `frontend/src/fixtures/recorded/phase-3-3-live-sdk-tx-subset.json`]:
- **Status fields:** the raw StudioNet snake_case object, plus `statusName: "FINALIZED"`, with `status` turned into the number `7`. Numeric `result: 6` is present alongside `result_name: "MAJORITY_AGREE"`.
- **Missing camelCase fields:** there is **no** `resultName` and **no** `txExecutionResultName`. The UI table shows `txExecutionResultName` as `undefined` because it was not returned.
- **Viem's standard fields:** `blockHash`, `blockNumber`, `to`, `transactionIndex` (all `null`) and `typeHex` (`2`) are added.
- **Leader receipts:** `consensus_data.leader_receipt` has two entries: `mode: "leader"` with `execution_result: "SUCCESS"`, and the leader's own `mode: "validator"` entry with `execution_result: "ERROR"`, `vote: "idle"`. The SDK has already decoded `result`:
  - `{raw, status: "return", payload: {raw, readable: "\"INCONCLUSIVE\""}}`;
  - for the validator-mode entry: `{raw, status: "contract_error", payload: "idle"}`.
- **Last round:** `last_round` (snake_case) includes `validator_votes_name` and numeric `validator_votes` `[5,5,1,1,1]`.
- **Other fields:** `created_at` is an ISO string; `created_timestamp` is a numeric string.

**What the classifier reads:** `statusName`, then `result_name`, then the receipt whose `mode` is `"leader"`, then the decoded result status. It handles this live shape correctly; a new unit test runs it on the verbatim subset.

**Votes:** shown exactly as returned for the last round. No "all validators agreed" claim is made. [Inference] As in earlier phases, IDLE is taken to mean "did not vote in that round"; the SDK does not document it.

## 5. CORS and browser findings

[Live] The browser's Resource Timing data for run 1 shows **23 `fetch` requests** to `https://studio.genlayer.com/api`:
- 1 chain check;
- 1 deploy lookup;
- 1 code read;
- 2 for contract info and case count;
- 12 case reads;
- 6 transaction lookups.

**All returned HTTP 200.** No other origin was contacted apart from the local app server.

- **CORS:** the page could read every JSON-RPC response. The endpoint's CORS policy therefore allows `http://127.0.0.1:4173` for `POST application/json`, including any preflight.
  - Preflight requests are not visible in Resource Timing, so their exact headers were not recorded.
  - The pane's network inspector did not list these cross-origin `fetch` calls; Resource Timing was used instead.
- **Cloudflare:** no challenge was observed. A 403, as seen with Python urllib in Phase 2.8, would have appeared as a non-200 status or an RPC error.
- **Latency:** `gen_call` about 1.3 s each; `eth_getTransactionByHash` about 0.3 s; the first request about 3 s (connection setup).
- **Error surfacing:** errors are shown by category (`timeout`, `network_or_cors`, `rpc_error`, `unparseable_response`, `sdk_error`) with a message clipped to 300 characters. No keys exist in this flow, and no wallet is involved.
- **Error paths not exercised live:** no live call failed. The error and timeout paths are covered by unit tests with mocks only.

## 6. Display-safety rules on live data

All [Live], from the rendered page.

- **Status and finality:** "Assessment recorded" for the status; "Final (confirmed by a latest-final read)" only because the latest-final read matched.
- **No-response notice:** shown verbatim, both under the case and among the stored notices.
- **UNRESOLVED citations:** E1 and E2 are listed only under "Evidence the assessment considered — no direction established", with each item's submitter ("Claimant") and the note that party-supplied text was not checked.
- **Display fix found by live data:** the first live render showed the `partially_checked` note ("agreeing validators shared at least one item") under the UNRESOLVED finding. That is inaccurate: UNRESOLVED citations are never compared across validators. The fix shows that note only for definite determinations, and otherwise "Every listed item exists in the locked record. For this determination, citations are not compared across validators." Run 2 confirmed the fix live, and unit and page tests cover it.
- **Claimant-only caution:** correctly **not** shown, because the finding is UNRESOLVED, not favourable. Its positive cases are unit-tested on the recorded evidence.
- **Decision fields:** labelled "Accepted through validator agreement (a majority of the validators that voted)".
- **Advisory block:** the summary, explanation, reasoning, confidence ("Model's self-reported certainty … not validator-checked, not a probability"), open questions, limitations and remedy appear under "Explanation (AI-generated, not independently verified)" with the contract's stored `display_notice`.
- **Remedy:** "No view on the requested remedy", "Advisory: AI-generated, not checked by validators", the CANNOT_ASSESS ambiguity note, and "VeriCourt does not pay, refund, hold or enforce anything."
- **Banned terms:** "verdict", "winner" and "loser" do not appear. The leader's own limitation text contains "uncontested"; it is leader-generated and shown only inside the advisory block.

## 7. Files changed (all under `frontend/` except this report)

**New:**

| File | Purpose |
|---|---|
| `src/config/testDeployments.ts` (+ `.test.ts`) | The Phase 2.17C deployment: address, case, expected code SHA-256 (test pins it to the repo contract), deploy and transaction hashes from the 2.17C report |
| `src/live/gateway.ts` | Read-only gateway interface: `chainId`, `getContractCode`, `readContract`, `getTransaction` only |
| `src/live/sdkGateway.ts` | genlayer-js implementation. `createClient({chain: studionet})` with no account, provider or endpoint override. A documented cast works around a genlayer-js type declaration that fails under `exactOptionalPropertyTypes` |
| `src/live/errors.ts` | `withTimeout` (no retry; abandons the read) and error categories |
| `src/live/validate.ts` (+ test) | Runtime shape validators for every view; `diffPaths` |
| `src/live/readCheck.ts` (+ test) | The ordered check with stop conditions |
| `src/live/expected.ts` | Recorded Phase 2.17C expectations (`get_case_status` derived) |
| `src/components/CaseSnapshot.tsx` | Renders validated live data through the display helpers only |
| `src/pages/LiveCheck.tsx` (+ test) | The `#/live` page. Sends nothing until clicked; one button, "Run read-only check" |
| `src/test/fakeGateway.ts` | Offline fake built from recorded data, wrapped in a strict proxy that throws on any non-read property |
| `src/fixtures/recorded/phase-3-3-live-sdk-tx-subset.json` | Verbatim subset of a live SDK transaction object |

**Modified:**

| File | Change |
|---|---|
| `src/display/citations.ts` (+ test) | `citationsWereOverlapChecked`, `UNCOMPARED_CITATIONS_NOTE` (the fix above) |
| `src/tx/classify.test.ts` | Live-shape test added |
| `src/fixtures/recorded.ts` | Exposes the raw recorded reads |
| `src/app/routes.ts`, `src/App.tsx` | `#/live` route |
| `src/styles/global.css` | Tables, `h4`, blockquote |
| `frontend/README.md` | Live check section |

**Unchanged:** `contracts/vericourt.py` (MD5 `D7E5DFA0…`), the Python tests and harness, `package.json` and `package-lock.json` (no dependency changes).

## 8. Tests and build

| Command | Result |
|---|---|
| `npm run typecheck` | Pass |
| `npm run lint` | Pass |
| `npm test` | **230 passed** (15 files; Phase 3.2 had 187). Every network API is stubbed to throw; the live gateway is never used in tests |
| `npm run build` | Pass. App chunk 259 KB (80 KB gzipped); SDK chunk 519 KB (108 KB gzipped), loaded only by the live check |

**What the new tests cover (offline):**
- **Stops:** wrong chain, code-hash mismatch, contradicting deploy address and a case that doesn't exist all stop before contract reads.
- **Bad responses:** malformed responses are reported as `malformed`, and the page then shows "no case data is displayed" instead of case data.
- **Failures:** timeouts happen once and are never retried; `TypeError: Failed to fetch` is categorised `network_or_cors`; JSON-RPC errors are categorised `rpc_error`.
- **No writes:** the gateway has no write property (the strict proxy throws on access).
- **Page:** nothing is sent until the button is clicked, the display rules hold on rendered data, and the only button on the live page is the read-only one.

**Bundle scan:**
- The SDK chunk necessarily contains genlayer-js's own write and wallet code, because the library ships the whole client.
- The app's own source calls none of it; the only matches are two comments.
- The app chunk's single `eth_requestAccounts` is the Phase 3.2 wallet-diagnostics "Connect wallet" button (an account request, not a signature).
- No wallet existed in this browser, so no prompt could occur.

## 9. Verified live vs recorded vs inference

- **Verified live:**
  - browser reachability and CORS;
  - the chain ID;
  - deployment identity (code hash and deploy address);
  - all 14 contract reads, decoded, valid and equal to the recording;
  - the default and explicit consistency modes;
  - the latest-final reads;
  - six transaction lookups and their exact returned field names;
  - the display rules on live data.
- **Recorded (not re-observed):**
  - the Phase 2.17C read-back used for comparison;
  - the Python-harness transaction history.
- **Inference:**
  - the meaning of IDLE votes;
  - that the latest-final match implies finalized state;
  - the CORS policy details beyond "responses are readable from this origin".

## 10. Remaining blockers and unverified assumptions

1. **Wallet writes (Phase 3.1 B2, B3, B9) remain unverified:**
   - whether `writeContract` with a browser wallet returns a usable GenLayer transaction ID;
   - the static consensus-contract address versus the zero address Studio reports;
   - gasless wallet writes.

   These need a separately approved write spike.
2. **Behaviour with an injected wallet present:** this browser had none. With a wallet, genlayer-js routes only wallet methods to it, and the gateway calls none (verified from source, not live).
3. **Other browsers and origins:** only Chromium 152 from `http://127.0.0.1:4173` was tested. Other origins, Firefox and Safari, and a deployed host are untested.
4. **Live error paths:** timeouts, RPC errors, rate limits and CORS failures were never triggered live; they are tested only with mocks.
5. **Rate limits:** at about 23 requests per check, the check stays under StudioNet's 60 requests/minute limit, but there is no request spacing in the browser path yet.
6. **No application deployment:** the live check targets a throwaway test contract. `CONTRACT_ADDRESS` stays unset.
7. **Untested on live data:**
   - a favourable finding with the claimant-only caution;
   - a non-final state;
   - a missing assessment;
   - an execution failure.

   They are covered only by unit tests on recorded or inferred data.

## 11. Confirmation

- Only read-only RPC calls were made: `eth_chainId`, `gen_getContractCode`, `gen_call` (`type: "read"`) and `eth_getTransactionByHash`.
- 23 calls in each of the two check runs, plus three single read-only transaction lookups through the same built SDK module, to capture the exact returned fields.
- No deployment, no writes, no signatures, no wallet prompts, no network switching, no retries, no new keys.
- No dependency changes, no backend, no commits.
- Contract writes in the frontend remain disabled.
