# Phase 3.6: browser-wallet test preparation (audit + operator checklist)

**Scope:** preparation only.
- No wallet prompt was opened, no signature requested, nothing broadcast or deployed, no key generated.
- No production code was changed.
- One local-only file was added: `.claude/launch.json`, two dev-server configurations used for the rehearsal in §2.3.

**Note on the request:** the Phase 3.6 instructions arrived truncated after Step 3, item "7". Items 7 and later in §3 are this document's own additions (§3.7–§3.10), not your text. Please send the rest if it asked for something else.

**Verdict: ready for the single controlled browser-wallet test, subject to your explicit approval.** Every audited guarantee holds in the code and is covered by tests. One low-severity robustness finding is recorded (§2.2, F1); it fails safe and needs no change before the test.

---

## 1. Evidence reviewed

**Reports:**
- `PHASE_3_5A_GUARD_IMPLEMENTATION_REPORT.md`
- `PHASE_3_5A_STAGE_A_REPORT.md`
- `PHASE_3_5B_BROWSER_WALLET_PREPARATION_REPORT.md`
- `PHASE_3_5C_WRITE_WIRING_REPORT.md`

**Re-run on 2026-10-18 against the code as it is on disk:**

| Check | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run lint` | pass |
| `npm test` | **600 passed / 30 files** |
| `npm run build` | pass |
| `contracts/vericourt.py` SHA-256 | `25bc9e0b…79333` (unchanged) |
| `CONTRACT_WRITES_ENABLED` | `false` (`config/network.ts:20`) |
| Dev server binding | `127.0.0.1:5173`, `strictPort` (`vite.config.ts:6`), so the experiment page is not reachable from the LAN |

**Ordinary `dist/`, zero matches for each of these:**
- "Write experiment build"
- the acknowledgement phrase
- `write-experiment`
- `beginWithPreflight`
- "VeriCourt write guard"
- `createSdkWriteClient`

`eth_requestAccounts` appears twice in the ordinary bundle, both expected:
- the Phase 3.4 Connect button;
- genlayer-js library code inside the lazy read-only gateway chunk. That client has no account and no provider, and the gateway object exposes four read methods only (`live/sdkGateway.ts`).

---

## 2. Audit of the experiment gate and write path (Step 2)

### 2.1 Requirements

| Requirement | Holds? | Where (code) | Proven by |
|---|---|---|---|
| The ordinary production build cannot initiate a transaction | **Yes** | `pages/WritePreview.tsx:45`: `import.meta.env.MODE === "write-experiment" ? lazy(import(...)) : null`, folded to `null` at build time | `dist/` scan (§1); `isolation.test.ts` pins the pattern and forbids any other reference to `src/experiment`; panel test "ordinary build" |
| The experiment build requires all five gate conditions | **Yes** | `config/writeGate.ts:43–49` (mode, exact phrase, allow-listed contract, localhost host, ordinary flag still false) | `writeGate.test.ts` (22 tests); mutations P11–P13 caught; bundle check: an unarmed experiment build compiles to `ack: void 0, contract: void 0` |
| Target restricted to the reviewed test contract | **Yes** | `EXPERIMENT_CONTRACTS = [PHASE_2_17C_NO_REPLY.address]` (`writeGate.ts:24`); preflight code-hash check (`createCaseFlow.ts:132`); guard checks the encoded `_recipient` | gate tests; preflight "contract code differs" test; P5 caught |
| Wallet explicitly connected in the current tab | **Yes** | `createCaseFlow.ts:97` requires `explicitConnection`, set only by Connect and lost on an account switch, disconnect or Forget (`wallet/walletState.ts`) | `writeGate.test.ts` "explicit wallet connection"; panel test "requires an explicit Connect"; P1, P14 caught |
| Chain rechecked before submission | **Yes** | preflight wallet + RPC chain (`createCaseFlow.ts:123, 128`); guard reads the wallet chain right before forwarding (`guardedProvider.ts:61`) | flow and guard tests; P2, P6 caught |
| Sender rechecked | **Yes** | preflight `eth_accounts[0]` (`createCaseFlow.ts:126`); guard: `from`, encoded `_sender`, `eth_accounts[0]` (`guardedProvider.ts:65`) | "wallet's own account differs"; P3 caught |
| Contract code rechecked | **Yes** | `createCaseFlow.ts:132` (SHA-256 of `gen_getContractCode`) | P5 caught |
| Nonce rechecked | **Yes** | preflight `latest == pending` (`:136`); pending nonce pinned in the intent (`:168`); the guard refuses any other nonce | "pending transaction" test; "nonce differs" test; P7, P18 caught |
| Calldata rechecked | **Yes** | guard: byte-equal calldata, V5 selector, decoded fields (`guard.ts` `checkCalldata`; `guardedProvider.ts:49`) | 40 guard tests; Phase 3.5A M2 |
| Simulation | **Yes** | `gen_call` simulation must return a case ID (`createCaseFlow.ts:140`) | "simulation fails" test |
| Durable write-ahead | **Yes** | record saved before the guard exists (`durableSession.ts:232`); the forward is saved before the wallet call, and a failed save vetoes it (`guard.ts:228`) | write-ahead ordering test; "write-ahead save fails → nothing sent"; N1 caught |
| Preflight runs under the cross-tab lock | **Yes** | `durableSession.ts:202–207` (lock → recovery → check → preflight → record) | "another tab cannot start meanwhile"; P17 caught |
| One user action → at most one wallet transaction request | **Yes** | UI: `fired` ref plus disabled state (`WriteConfirmation.tsx:46–51`); panel `running` ref; session: one guard per operation, single synchronous permit (`guard.ts:172`); forwards the checked copy (`guardedProvider.ts:80`) | double-click tests (UI and flow); real-SDK V6 fallback tests; N13 caught |
| Uncertain operations stay blocked across reloads and tabs | **Yes** | persistent record; recovery only under the lock; `reset()` refuses unresolved records (`durableSession.ts:319`); compare-and-swap saves (`:164`); a broken tab is blocked for good (`:194`) | `durableSession.test.ts`, `pendingStore.test.ts`, flow tests; N2–N6, N14, N15, P15 caught |
| Success requires finality plus a matching post-finality read | **Yes** | `VERIFIED` only after `finalized` and exactly one matching case at latest-final (`createCaseFlow.ts:212, 297`); a timeout gives `timed_out_unknown`, never failed | monitoring tests; P8, P9, P10 caught |

**No guard was weakened.**

### 2.2 Findings

**F1 (low; fails safe; no change made).** In `submitCreateCase`, if building the write client threw *after* `beginWithPreflight` succeeded:
- **Effect:** this tab would keep the lock and show "A write is in progress" until a reload.
- **Why it is safe:** nothing would have been sent, and the reload recovers it as `not_sent`.
- **Why it cannot happen today:** the only throw in `createSdkWriteClient` is for a non-address sender, which `flowBlockers` already rejects.
- **When to fix:** consider an explicit abandon path in a later clean-up phase.

**F2 (residual risk, not a defect).** StudioNet does not reject duplicate raw transactions (Stage A source review). Some wallets rebroadcast pending transactions.
- **Mitigation:** Stage A saw a receipt available immediately, which makes a rebroadcast unlikely.
- **Detection:** the post-finality check refuses to call success if **more than one** matching case appears, and reports it as ambiguous.

**F3 (residual risk).** The guard checks the *request*. The wallet decides what it *signs*: it may change the fee, nonce or type in its own UI. Only the operator's comparison in §3.5 catches that.

### 2.3 Browser rehearsal (no wallet, gate off)

| Rehearsal | What was checked | Result |
|---|---|---|
| Built-in browser, `window.ethereum` **undefined**; experiment dev server **without** the phrase or contract | `#/review` | Showed "Write experiment build", the two missing gate conditions, all nine fictional fields, both warnings, and every blocker. "Sign in wallet" was disabled. No pending-write record was created; no console errors |
| Ordinary dev server | `#/review` | Showed only "Transaction review / Preview only" with the writes-disabled reason. No experiment banner; button disabled |

Both servers were stopped afterwards.

---

## 3. Operator checklist for the single test (Step 3)

The operator is **you**. Claude does not operate the wallet. Work top to bottom, and stop at the first box that does not match.

### 3.1 Browser and wallet prerequisites

- [ ] **Browser:** a current Chrome (or another Chromium browser) with the Web Locks API. Every current Chromium has it; the app refuses writes without it.
- [ ] **Profile:** a **dedicated browser profile** used for nothing else.
- [ ] **Extensions:** **only one** wallet extension in that profile. Two wallet extensions fight over `window.ethereum`.
- [ ] **Wallet:** installed from its official store, with a **new throwaway wallet** created inside it.
  - Never import a real account or seed.
  - Write the recovery phrase on paper. Never paste it into chat, a file or the app.
- [ ] **Balance:** the throwaway account has **no funds**. None are needed: StudioNet is gasless.
- [ ] **Repo state:** `frontend/` on the reviewed state. `npm test` shows 600 passing; `npm run build` passes.
- [ ] **Approval:** you have explicitly approved this one test in chat.

### 3.2 StudioNet network and chain ID 61999

- [ ] **Add the network by hand** in the wallet's network settings:
  - name: any, e.g. "GenLayer StudioNet";
  - RPC URL: `https://studio.genlayer.com/api`;
  - chain ID: `61999`;
  - currency symbol: any, e.g. `GEN`.

  The app never adds or switches networks for you. Any such request is a reason to stop.
- [ ] **Select it** in the wallet as the active network.
- [ ] **Start the experiment build** in `frontend/`:

  ```bash
  VITE_VERICOURT_WRITE_EXPERIMENT=I-UNDERSTAND-THIS-SENDS-ONE-REAL-STUDIONET-TRANSACTION VITE_VERICOURT_CONTRACT_ADDRESS=0x3258A80A86920792354A9b7e59D5Ed2409E96220 npx vite --mode write-experiment
  ```

- [ ] In the test profile, open **`http://127.0.0.1:5173/#/wallet`** and press **Connect**. Confirm both:
  - the account is your throwaway address;
  - the chain shows `61999` "Matches StudioNet".

### 3.3 Confirm the intended test contract

The expected contract is `0x3258A80A86920792354A9b7e59D5Ed2409E96220`, the Phase 2.17C throwaway test deployment (`config/testDeployments.ts`).

- [ ] **`#/live`:** run **Live read-only check**. It must pass: chain, deployed code hash, `VC-000001` reads, known transactions.
- [ ] **`#/review` banner:** reads "Write experiment build … Target: the throwaway test contract `0x3258A80A86920792354A9b7e59D5Ed2409E96220`".
- [ ] **`#/review` "Contract" row:** the same address.
- [ ] **No blockers:** the review screen is shown and the "cannot be sent yet" list is gone.
- [ ] **No status panel above the review.** If a status panel appears instead, an earlier write is recorded: **stop**.

### 3.4 Inspect the fictional case fields

On `#/review`, read every row of "Case details that will be written":

- [ ] **Respondent:** `0xF1C710A100000000000000000000000000000001` (fictional; not your address).
- [ ] **Category:** `OTHER`.
- [ ] **Title:** "FICTIONAL TEST - VeriCourt browser-wallet write `<timestamp>`".
- [ ] **Text fields:** agreement summary, expected deliverable, claim and remedy each begin with "FICTIONAL" or say "fictional".
- [ ] **Issues:** `I1` "FICTIONAL - placeholder issue for a browser-wallet write test".
- [ ] **Reply window:** `3600 seconds (1 hour)`.
- [ ] **Network row:** "chain ID 61999" plus "Wallet is on StudioNet". **Your account:** the throwaway. **Function:** `create_case`.
- [ ] **Warnings:** read both ("creates a case on chain", "public and permanent").
- [ ] **Acknowledge and click once:** tick the box, then press **Sign in wallet** **once**.

### 3.5 What the wallet prompt must show, and when to reject

Exactly **one** transaction prompt should open. Check every line:

| Field | Expected | If different |
|---|---|---|
| Type of request | A **transaction** (send/confirm), not a signature, message, typed-data, "switch network" or "add network" request | **Reject** |
| Origin / site | `127.0.0.1:5173` or `localhost:5173` | **Reject** |
| Network | Your StudioNet entry, chain ID **61999** | **Reject** |
| From / account | The throwaway account | **Reject** |
| To / interacting with | **`0xb7278A61aa25c888815aFC32Ad3cC52fF24fE575`**: genlayer-js's consensus entry point. This is **not** the VeriCourt address, which is encoded inside the data; StudioNet routes by that (Stage A). | **Reject** |
| Amount / value | **0** | **Reject** |
| Network fee / gas fee | **0** (or "no fee") | **Reject** |
| Data (if shown) | Starts with `0x27241a99` (`addTransaction`) | **Reject** |
| Nonce (advanced view, if shown) | The account's current transaction count: `0` for a brand-new wallet | **Reject** |
| A second prompt appearing | Never expected | **Reject it**, then follow §3.7 |

If everything matches, **approve once**. Afterwards:
- don't press anything else;
- **don't use the wallet's "speed up" or "cancel"**;
- leave the tab open.

### 3.6 Recognizing the states

The panel's headline and status line:

| You see | Meaning | Do |
|---|---|---|
| Status line "Waiting for your wallet…" | The single request is open, or the preflight is running | Answer the wallet prompt |
| Alert "Nothing was sent. The preflight check failed…" | A pre-check failed before any request | Stop and investigate. A new attempt needs a new review and click, and only after you've understood the cause |
| **"You rejected the request"** / "Nothing was sent." | Wallet rejection (4001) | Done. Settled |
| "Write in progress … Status: submitted / pending / accepted. Accepted is not final" | Submitted; consensus running. Stage A took about 54 s to finality | Wait |
| "Finalized; confirming the case" | Final; the confirming read is still due | Wait, or press **Check status (read-only)** |
| **"Case created and confirmed"**, naming the transaction and `VC-…` | **Success**: finalized and confirmed by a latest-final read | Record it (§3.8) |
| **"The write may have been sent"** / **"The outcome is not known yet"**, with recovery steps | **Uncertain:** timeout (240 s submission, 30 min finality), lost connection, malformed answer, or a reload mid-prompt. **Not a failure** | Follow §3.7 |
| "The transaction finalized without creating the case" | Final, but failed, disputed or undetermined | Stop; record |
| "Finalized, but the case was not found" | The confirming read disagrees | Stop; record; don't write again |
| "Case confirmed by contract state (limited evidence)" | The case exists at latest-final, but the transaction was never identified | Record as limited evidence; don't write again |
| Alert "The write's outcome could not be saved…" | Browser storage failed | Stop. Reload once to recover the stored record; don't write again |

### 3.7 If anything is uncertain (my addition)

1. **Do not retry.** Don't click Sign again, don't open a new tab to try again, don't use the wallet's speed-up or cancel.
2. Open the wallet's **activity** list and note whether a transaction appears.
3. Press **Run read-only check**. It looks up the recorded transaction and the contract's cases, and sends nothing.
4. The block lifts only on positive evidence. If it stays unresolved, stop and report; manual recovery is `PHASE_3_5B…` §7.3.

### 3.8 What to record (my addition)

- [ ] The timestamps of the click, the prompt and the approval.
- [ ] The wallet prompt contents (a screenshot of the prompt is fine: it holds no secrets). **Never photograph the recovery phrase.**
- [ ] The transaction hash shown by the panel, and the final headline with its `VC-…` ID.
- [ ] Whether exactly one prompt appeared.

Claude can then make **read-only** checks, with your approval:
- `getTransaction` on the hash;
- whether the hash equals the GenLayer transaction ID;
- the latest-final `get_case` and the case count.

### 3.9 Stop conditions (my addition)

Stop at:
- any mismatch in §3.2–§3.5;
- any second prompt;
- any guard or preflight refusal;
- any uncertain state (reconcile only);
- a status panel present before you start;
- the experiment banner not naming `0x3258…6220`.

### 3.10 After the test (my addition)

- [ ] Stop the dev server (Ctrl+C).
- [ ] The ordinary build is unaffected and remains write-free. Don't commit any `.env` file containing the phrase; none is needed, because the variables are given inline.
- [ ] Keep or remove the throwaway profile as you prefer; it holds nothing of value.
- [ ] Ask Claude for the post-test report (read-only verification).

---

## 4. Stop

Preparation is complete. **Nothing will be sent until you explicitly approve the live browser-wallet test**, and you operate the wallet.
