# Phase 2.13: integration harness hardening (local only)

Status: complete locally, not yet run against StudioNet. No network calls, deployments, transactions, dependency installs or commits were made (see §8).

## 1. Root cause of the Phase 2.8 hang

Evidence: `integration-logs/studionet-rerun-pytest-output.txt`, `integration-logs/studionet-smoke-2026-10-15T08-58-23.818591+00-00.json`, and the installed SDK source (genlayer-py 0.16.3, genlayer-test 0.29.2, web3 8.0.0, requests 2.34.2).

**What happened**

1. All six writes completed in about 220 s. The last one, `request_assessment`, was decided after 129.1 s: UNDETERMINED / MAJORITY_DISAGREE, with the leader's execution SUCCESS.
2. The harness then started `_reads(latest-nonfinal)`, which makes five `gen_call` reads. No `reads_latest_nonfinal` step was ever logged.
3. The process stayed blocked in `ssl.py` (a socket read) until it was interrupted manually. The pytest total was 1949.9 s, so it hung for about 29 minutes.
4. The old harness didn't log individual reads, so which of the five reads stalled is unknown.

**Root cause**

`genlayer_py/provider/provider.py`, `GenLayerProvider.make_request`, calls `requests.post(self.url, json=payload, headers=...)` with **no `timeout`**. requests then waits on the socket forever. This is the single choke point:
- every genlayer-py call (reads, writes, status polls) goes through it;
- every web3 call made by the client goes through it too, because `GenLayerClient` builds `Web3(provider=self.provider)`.

**Contributing factors**

- No overall run deadline. pytest-timeout isn't installed, and installs weren't allowed.
- The log was written only in `finally`. Had the process been killed rather than interrupted, nothing would have been saved.

## 2. Audit of the old harness

### 2.1 Every network operation, and where it could block

| Operation (old harness) | RPC method(s) | Bounded before? |
|---|---|---|
| `gl_client` fixture → `create_client` → `initialize_consensus_smart_contract` | `sim_getConsensusContract` | No (no HTTP timeout) |
| `get_current_nonce` (preflight) | `eth_getTransactionCount` via web3 | No |
| `deploy_contract_tx` / `.transact()` → `write_contract` / `deploy_contract` | `sim_getConsensusContract`, `eth_getTransactionCount`, `eth_estimateGas`, `eth_sendRawTransaction` | No |
| …then `_send_transaction` → `w3.eth.wait_for_transaction_receipt(tx_hash)` | `eth_getTransactionReceipt`, polled every 0.1 s | Overall wait capped at 120 s by web3's `Timeout`, which can't interrupt a single blocked request |
| `wait_for_transaction_receipt(status=ACCEPTED)` | `eth_getTransactionByHash` (StudioNet shares localnet's chain id 61999) | Retry loop is finite (interval × retries); each request is unbounded |
| `get_contract_schema` | `gen_getContractSchema` | No |
| `.call()` reads (`_reads`, `get_case`, `get_case_status`) | `gen_call` | No. **This is where Phase 2.8 hung.** |
| Finality wait (`status=FINALIZED`) | `eth_getTransactionByHash` | Loop finite, each request unbounded |

### 2.2 How results were represented, and the problems with that

**SDK behaviour, verified in source:**
- `wait_for_transaction_receipt(status=ACCEPTED)` returns on **any decided state**: ACCEPTED, UNDETERMINED, LEADER_TIMEOUT, VALIDATORS_TIMEOUT, CANCELED or FINALIZED.
- When retries run out it raises `GenLayerError`, the same type it raises for RPC failures. The only way to tell them apart is the message text.
- `get_transaction` raises `KeyError` for an unknown status name and `TypeError` for a null result.

**The old harness's success checks were ambiguous:**
- **The leader-only check is misleading.** gltest's `tx_execution_succeeded` looks only at the receipt whose `mode` is `leader`. It returns True for the Phase 2.8 assessment transaction, which validators rejected (shown in `test_phase_2_8_assessment_is_classified_as_validator_disagreement`).
- **Finalized was treated as success.** `_require_consensus_ok` accepted status ACCEPTED or FINALIZED without looking at `result_name`. The Phase 2.8 assessment later became **FINALIZED with MAJORITY_DISAGREE**, so had it been read at that point it would have counted as a success.
- **Two different failures were indistinguishable.** The finality wait caught every exception into `assessment_finality_not_observed`, so a timeout looked the same as a read failure.
- **The first case ID was hard-coded** (`VC-000001`), and a returned evidence ID was never compared with the expected one.

### 2.3 Could retries create duplicate writes?

No retry existed at any layer:
- genlayer-py has no retry logic;
- requests' default `HTTPAdapter` uses `Retry(0, read=False)`;
- gltest's `transact()` submits once;
- the harness's own comment said "no retries".

**The real gap was uncertainty, not duplication.** If `eth_sendRawTransaction` (or the web3 receipt wait after it) failed, the old harness raised and lost the information. It couldn't tell whether the transaction had reached the node, and it had no explicit rule against submitting again.

### 2.4 The ambiguous record

The Phase 2.8 case is the only record ever used, and it is deliberately unclear:
- each party offers only its own TEXT statement;
- the reply claims a scope change that no document supports.

The four real model proposals split on I2 (NOT_SUPPORTED vs UNRESOLVED) and on I1 (PARTIALLY_SUPPORTED vs UNRESOLVED; see `assessment-proposal-comparison.txt`). Running this record alone can show disagreement, but it can never show that agreement is reachable.

## 3. Timeout and status-handling design

All code is in `tests/integration/harness.py`. It makes no requests at import time.

### 3.1 Bounded requests: `BoundedProvider` and `make_client`

**`BoundedProvider`** subclasses `GenLayerProvider` and keeps its payload, headers and error contract. It adds three things:
- **Timeouts:** every request passes requests' supported `timeout=(connect, read)` argument.
- **Request spacing:** at least 1.1 s between requests. This keeps the harness under StudioNet's 60 requests/minute limit, including inside the SDK's own 0.1 s receipt-polling loop.
- **A request journal:** the method, outcome and duration of each request. Request parameters are never stored. The journal keeps only the Ethereum hash that `eth_sendRawTransaction` returns.

**Failures raise `RpcError`**, which subclasses `GenLayerError` so SDK code paths behave as before. Its `kind` is one of:
- `connect_timeout` or `read_timeout` (these two are the timeouts);
- `transport_error`;
- `invalid_response`, for example a non-JSON HTTP 429;
- `rpc_error`.

The message names the RPC method and the endpoint. The harness never retries a request.

**`make_client`** builds `GenLayerClient` directly, because `create_client` would send `sim_getConsensusContract` through the unbounded provider before the new one could be installed.
- It installs the bounded provider on both `client.provider` and `client.w3.provider`.
- It works on a deep copy of the chain object, because the SDK mutates the shared module-level `studionet` object.

### 3.2 Configurable bounds: `Timeouts`, all overridable through `VERICOURT_*` environment variables

| Setting | Default | Bounds |
|---|---|---|
| `http_connect_timeout_s` | 10 | TCP/TLS connect, per request |
| `http_read_timeout_s` | 60 | Longest silence between response bytes, per request |
| `min_request_spacing_s` | 1.1 | Rate-limit spacing |
| `write_decision_timeout_s` | 300 | Polling an ordinary write until it is decided |
| `assessment_decision_timeout_s` | 900 | Polling `request_assessment` until it is decided |
| `finality_timeout_s` | 900 | Polling the assessment transaction until FINALIZED |
| `poll_interval_s` | 6 | Polling cadence (must be at least the request spacing) |
| `max_consecutive_read_failures` | 3 | Failed status reads in a row that end a poll as READ_FAILURE |
| `run_budget_s` | 5400 | Whole run; checked before every operation starts |
| *(fixed by the SDK)* `SDK_SEND_RECEIPT_TIMEOUT_S` | 120 | web3 receipt wait inside genlayer-py's submit; not configurable (§7) |

`Timeouts.from_env` reads only its own variable names and rejects values that are non-numeric or not positive.

### 3.3 Outcome categories: `classify_transaction`

Classification reads the status, the consensus result (`result_name`) and the leader receipt together. The leader receipt is the one with `mode == "leader"`: in Phase 2.8 the list also held the leader's own validator-mode receipt, which had `execution_result` ERROR.

| Category | Rule |
|---|---|
| `SUBMITTED` | The node returned a GenLayer transaction ID; nothing has been observed yet |
| `PENDING` | UNINITIALIZED / PENDING / ACTIVATED / PROPOSING / COMMITTING / REVEALING / APPEAL_* / READY_TO_FINALIZE |
| `ACCEPTED_SUCCESS` | ACCEPTED + MAJORITY_AGREE + leader SUCCESS + result `return` (not final) |
| `FINALIZED_SUCCESS` | Same, with status FINALIZED |
| `ACCEPTED_EXECUTION_FAILED` / `FINALIZED_EXECUTION_FAILED` | MAJORITY_AGREE on a leader ERROR or a `rollback` / `contract_error` / `error` result |
| `VALIDATOR_DISAGREEMENT` | `result_name` MAJORITY_DISAGREE, whatever the status. No state change. `final` is true once FINALIZED |
| `UNDETERMINED` | Status UNDETERMINED without MAJORITY_DISAGREE; NO_MAJORITY / TIMEOUT / DETERMINISTIC_VIOLATION; LEADER_TIMEOUT / VALIDATORS_TIMEOUT / CANCELED |
| `UNRECOGNIZED` | Unknown status, missing result, no leader receipt, or an undecodable result. **Never** counted as success |
| `TIMED_OUT_UNKNOWN` | The poll deadline passed. The actual status is unknown; the last observation is kept for the report |
| `READ_FAILURE` | N consecutive status reads failed (an RPC error, or the SDK's KeyError/TypeError) |
| `NOT_SUBMITTED` | The submit call failed before `eth_sendRawTransaction` was attempted (definite) |
| `SUBMISSION_REJECTED` | The node answered `eth_sendRawTransaction` with a JSON-RPC error |
| `SUBMISSION_UNCERTAIN` | `eth_sendRawTransaction` timed out or hit a transport error: it may or may not be on-chain |
| `SUBMITTED_UNCONFIRMED` | The node accepted the raw transaction (its Ethereum hash is kept), but no GenLayer transaction ID was obtained |

**A write counts as successful only if its category is `ACCEPTED_SUCCESS` or `FINALIZED_SUCCESS`.** An accepted transaction, or a returned receipt, is never enough on its own.

### 3.4 Polling: `poll_transaction`

- Each poll has a finite deadline, `min(configured timeout, remaining run budget)`.
- Sleeps are clipped to the time remaining.
- It always returns exactly one terminal category; it never raises for a read problem and never submits anything.
- **"Decided" mode** stops at the first non-PENDING category.
- **"Final" mode** keeps polling past ACCEPTED and UNDETERMINED until FINALIZED, CANCELED or UNRECOGNIZED.

### 3.5 Writes: `WriteGuard`

- Writes must follow the approved plan, which is printed in the preflight, in order.
- Each write name is marked as attempted **before** it is sent, so a write can be attempted at most once.
- After a failed submission, the guard checks the request journal to see whether `eth_sendRawTransaction` was attempted and what happened to it, then classifies the failure (§3.3).
- **Any outcome other than `SUBMITTED` halts the guard.** Every later write is refused without being sent.

The harness never resubmits. On an uncertain submission it logs "not resubmitted; check the account nonce/explorer manually before any further write" and stops.

### 3.6 Runner

The runner applies one policy:
- **Ordinary writes** must reach `*_SUCCESS`.
- **The assessment** may legitimately end as:
  - a success, including an agreed `ATTEMPT_FAILED`;
  - `VALIDATOR_DISAGREEMENT`;
  - `UNDETERMINED`.
- **Anything else halts the run:** a timeout, a read failure, an unrecognised status or an execution failure.

**Checks after each step**

| After | Check |
|---|---|
| Case creation | Case count before and after; the new case's claimant, respondent, title and status (no hard-coded ID) |
| Each evidence submission | The returned evidence ID equals the expected one |
| The reply | READY_FOR_ASSESSMENT, locked |
| A successful assessment | Stored outcome equals the returned value; snapshot digest; issue coverage |
| A disagreement | **State unchanged:** READY_FOR_ASSESSMENT, 0 attempts, no stored assessment |
| Finality | Reads at latest-final match latest-nonfinal |

**Reads and logging**

- A read failure is logged as READ_TIMEOUT or READ_FAILURE, naming the contract, function and arguments, and it stops the run.
- If finality isn't observed within the window, that is a **warning**, recorded with its category, not a harness failure.

### 3.7 Logging: `StepLog`

- The JSON log is rewritten atomically after **every** step, so a run that is killed still leaves a log.
- The throwaway accounts' private keys are registered as secrets and replaced with `[REDACTED]` before anything is printed or written.
- No environment values are logged except the approval flag and the timeout settings.

## 4. Test fixtures (`tests/integration/case_fixtures.py`)

Both fixtures are fictional, deterministic and pure ASCII. Each is checked in direct mode exactly as the harness will submit it (`tests/direct/test_integration_fixtures.py`). No on-chain cases were created.

### 4.1 `clear`: positive control (new)

- **Agreement:** a fixed-price widget contract with two signed acceptance criteria: (1) a settings page with theme and language options, and (2) an export button that downloads the user's data as CSV. The final milestone is payable when both are delivered.
- **Single issue (I1):** "The v1.0 build delivered as final does not include the CSV export button required by acceptance criterion 2."
- **E1 (claimant, TEXT):** a signed acceptance-criteria excerpt, criterion 2 (I1).
- **E2 (respondent, TEXT):** the respondent's own v1.0 release notes: "Known gaps: CSV export is not implemented in this release." (I1)
- **Reply:** "we accept that the CSV export button is not in the v1.0 build", while arguing that payment should still be released.

**Expected result:** I1 SUPPORTED, citing E1 and/or E2, so the outcome is `CLAIM_SUPPORTED`. The remedy is advisory and not checked.

**Why it is useful:**
- The fact is corroborated by the agreement and by the respondent's own document.
- It is expressly accepted in the reply.
- Nothing depends on silence or on a party's own uncorroborated assertion.

So it tests whether agreement and a stored v2 assessment are reachable at all.

**Not guaranteed.** The main risk is shown in direct mode: if one validator answers PARTIALLY_SUPPORTED, the derived outcome becomes `CLAIM_PARTIALLY_SUPPORTED`. That disagrees with the leader, and nothing is recorded. A disagreement here would be a finding about agreement rates, not a harness failure.

### 4.2 `ambiguous`: negative control (the Phase 2.8 record, reused deliberately)

The record is identical to Phase 2.8: issues "Export button missing" and "Settings page incomplete"; E1 is the claimant's scope excerpt (I1); E2 is the respondent's change note (I1, I2); the reply is unchanged. It is kept identical so the v2 rules can be compared with the v1 result on exactly the same input. It is no longer the only test.

**Expected result:**
- I2 UNRESOLVED (E2 is only the respondent's own assertion);
- I1 UNRESOLVED or PARTIALLY_SUPPORTED;
- outcome `INCONCLUSIVE` or `CLAIM_PARTIALLY_SUPPORTED`;
- or, likely, `VALIDATOR_DISAGREEMENT` with no state change.

**Unexpected:** `CLAIM_SUPPORTED` or `CLAIM_NOT_SUPPORTED`.

**Phase 2.8 proposals rescored under the v2 rules** (`test_ambiguous_phase_2_8_split_under_v2_rules`):

| Pair | v2 result |
|---|---|
| Mistral and GPT (both P,U) | Agree |
| Sonnet's U,U vs those | Disagree |
| Gemini's N on I2 vs others | Disagree |

### 4.3 Plan

The default `VERICOURT_FIXTURES=clear,ambiguous` makes **11 writes**: 1 deploy, then 5 per fixture (create, 2 evidence, reply, assess). `VERICOURT_FIXTURES=clear` reduces this to 6. The plan is printed before the first write, and the guard refuses anything outside it.

`evaluate_expectation` records whether each expectation was met. It is informational and never fails the run.

## 5. Files changed

| File | Change |
|---|---|
| `tests/integration/harness.py` | **New.** Bounded provider, client factory, classification, polling, write guard, runner, step log |
| `tests/integration/case_fixtures.py` | **New.** The two fixtures and the expectation evaluator |
| `tests/integration/test_studionet_smoke.py` | **Rewritten** on top of the harness. Same approval guard (`VERICOURT_RUN_STUDIONET=1`), studionet-only and leader_only refusal; fixture selection; preflight now includes timeouts and plan |
| `tests/harness/test_harness_offline.py` | **New.** 64 offline tests |
| `tests/direct/test_integration_fixtures.py` | **New.** 13 direct-mode fixture tests |
| `pytest.ini` | `testpaths = tests/direct tests/harness` (the smoke test is still not collected by a bare `pytest`) |
| `docs/PHASE_2_13_HARNESS_REPORT.md` | **New.** This report |

**Not changed:**
- `contracts/vericourt.py` (MD5 `D7E5DFA0AA8D412FD8430415FFB2491B`, last written before this phase), so there is no change to assessment logic, outcome mapping, agreement matrix, storage or ABI;
- `requirements.txt`, `gltest.config.yaml`;
- all existing direct tests;
- `integration-logs/` (read only);
- other docs.

## 6. Test results

All tests ran in WSL, in the project venv.

| Check | Result |
|---|---|
| `pytest` (default testpaths: direct + harness) | **419 passed**: 342 existing direct tests, 13 fixture tests, 64 harness tests |
| Offline guard | An autouse fixture replaces `socket.connect` / `create_connection` / `getaddrinfo` with a failure; no harness test tripped it |
| Smoke test `--collect-only`, with `VERICOURT_RUN_STUDIONET` explicitly unset | Imports cleanly; 1 test collected, not run |
| Mutation run on a scratch copy of `harness.py` | **17/17 caught** (details below) |
| `genvm-lint check` / `typecheck` / `schema` (contract, `GENVM_VERSION=v0.2.16`) | Passed; 0 type errors; 14 methods (9 view, 5 write), unchanged |
| `pyright` on `harness.py`, `case_fixtures.py`, `test_studionet_smoke.py` | 0 errors, after fixing two type-narrowing findings |

**Mutation run details.** Two mutations survived the first run:
- the `Runner.write` stop on a timeout (it was masked by a later check);
- the halted-run check at the start of a fixture.

I added `test_runner_write_itself_stops_on_unknown_status` and a no-reads-after-halt assertion. The "deadline enforced late" mutation was caught as a hang under the fake clock.

**What the tests cover**

- **Timeout classification:**
  - read vs connect timeouts, transport errors, non-JSON responses and JSON-RPC errors are distinct, and each names the method;
  - a timed-out poll never reports an execution failure.
- **Phase 2.8 replay:**
  - the stall mode now ends in a typed `read_timeout` for `gen_call` and `eth_getTransactionByHash`;
  - the real Phase 2.8 transaction is decoded by genlayer-py's own `get_transaction` and classified `VALIDATOR_DISAGREEMENT`, final.
- **Polling deadlines:**
  - the poll count is bounded and sleeps add up to exactly the timeout;
  - the last sleep is clipped;
  - read-failure threshold, transient recovery, and the SDK raising KeyError;
  - finality polling waits past ACCEPTED and UNDETERMINED.
- **Uncertain submission:**
  - genlayer-py's real `write_contract`, with `eth_sendRawTransaction` timing out, gives `SUBMISSION_UNCERTAIN`, sent exactly once, and the guard then refuses;
  - when the node accepts the raw transaction but the receipt can't be read, the result is `SUBMITTED_UNCONFIRMED` with the Ethereum hash kept;
  - all five submission-failure kinds are covered.
- **Duplicate-write prevention:**
  - a repeated, out-of-order or post-halt write is refused without being sent;
  - a malformed transaction ID is not treated as submitted;
  - after an assessment timeout, no further write or read happens.
- **Runner flow** (with a fake client):
  - the full 11-write plan runs with one success and one disagreement;
  - a disagreement on an ordinary write stops the run;
  - a disagreement that changed state is flagged;
  - a read timeout, an evidence-ID mismatch and an exhausted run budget each stop the run.
- **Other:**
  - log scrubbing of secrets, and the log rewritten after each step;
  - environment parsing reads only `VERICOURT_*` variables;
  - plan composition.

## 7. Remaining limitations

1. **The read timeout is inter-byte, not total.** A server that keeps trickling bytes could hold one request longer than `http_read_timeout_s`. A hard per-request wall clock would need the request to run in a thread that is abandoned when time is up. That is unsafe for writes, because an abandoned `eth_sendRawTransaction` could still land after the harness has reported a timeout. **I did not introduce it.** The Phase 2.8 failure mode, a silent socket, is fully covered.
2. **The SDK's submit receipt wait isn't configurable.** genlayer-py 0.16.3 calls web3's `wait_for_transaction_receipt(tx_hash)` with web3's defaults: 120 s, polling every 0.1 s. The request spacing slows that polling to roughly one request per 1.1 s. The 120 s limit itself can only be changed by editing the SDK, which I didn't do.
   - **Worst-case time before a transaction ID exists:** 4 pre-send requests, each up to about 70 s plus spacing, then the 120 s receipt wait plus one in-flight request, roughly 7 minutes.
   - **Worst case for a poll:** its timeout plus one in-flight request (up to about 70 s).
3. **The run budget is checked between operations, not pre-emptively.** No pytest-level timeout exists: pytest-timeout isn't installed, and installs weren't allowed.
4. **No automatic reconciliation.** After `SUBMISSION_UNCERTAIN` or `SUBMITTED_UNCONFIRMED`, the harness stops. Someone has to check the account nonce or the explorer manually before approving any further write.
5. **Classification of failed executions is untested on the network.** The rules come from the SDK's enums and the result-code decoder; StudioNet hasn't yet produced an observed execution failure. Unknown shapes fall to `UNRECOGNIZED`, which halts the run. It is never treated as success.
6. **Only the StudioNet code path is covered.** StudioNet shares localnet's chain ID in genlayer-py 0.16.3, so `get_transaction` uses `eth_getTransactionByHash`. The testnet consensus-data code path (several requests per read) is not covered.
7. **The new code is verified only with fake HTTP.** It has not run against StudioNet. Agreement on the `clear` fixture is not guaranteed.
8. **The approved write count changes.** The default plan is 11 writes, against Phase 2.8's 6, so it needs its own approval. Selecting a single fixture gives 6.
9. Earlier open items (M3, L2–L4) are unaffected.

## 8. Confirmation

During Phase 2.13:
- **No network or RPC calls:**
  - all new tests use injected fake HTTP behind a socket guard;
  - the smoke test was only collected, with the approval flag explicitly unset;
  - `genvm-lint` was run locally exactly as in earlier phases.
- No deployments, transactions or StudioNet tests.
- No dependency installs or upgrades.
- No commits.

The contract is unchanged. Next step, which needs approval: a controlled StudioNet run of this harness, choosing `clear`, `ambiguous` or both, so 6 or 11 writes.
