# Phase 4: core workflows (4.0B–4.6) implementation report

**Date:** 2026-10-20.

**Instruction:** "finish up this build, take the necessary steps, make sure everything works smoothly". I took this as approval to implement the Phase 4 plan in `docs/PHASE_4_REQUIREMENTS_TRACEABILITY.md`, using its recommended defaults:
- **D1:** one generalised, gated experiment for all five writes;
- **D3:** contract only from build configuration, no default;
- **D4:** no browse-all view;
- **D5:** redaction wording as proposed;
- **D6:** one live read-only pass.

**Locked constraints, all kept:**
- no contract change: SHA-256 `25bc9e0b…79333` is unchanged;
- no dependency change;
- no commit or deployment;
- **no transaction or wallet prompt**: the live checks were reads only;
- the ordinary build cannot send.

## Status by requirement

| Requirement | Status | Where |
|---|---|---|
| Case dashboard / discovery | **Implemented** | `pages/Dashboard.tsx`. Three sources: "Your cases" from `get_party_case_ids` with the wallet's *passive* account; open by ID; recently viewed, stored in this browser and labelled as such |
| Case detail and status | **Implemented** | `pages/CaseDetail.tsx`, `components/CaseRecord.tsx` |
| Timeline / history | **Implemented, with the known limit** | `components/CaseTimeline.tsx`. Contract history in full. Transaction IDs only for recorded test runs and writes sent from this browser (contract gap G1) |
| Evidence register | **Implemented** | `components/EvidenceRegister.tsx`. Safe external links; "External links can change…"; file-hash note |
| Reply / deadline display | **Implemented** | `display/caseText.ts`. A passed but unrecorded deadline is described "by this device's clock" and never as "no response" |
| Assessment status and result | **Implemented** | Reuses the Phase 2.18B rules unchanged (`components/AssessmentView.tsx`, extracted from `CaseSnapshot`) |
| Create case | **Implemented (experiment build only)** | `experiment/CreateCaseWizard.tsx`: 5 steps (spec §10.3), per-step validation mirroring the contract, templates as hints only |
| Evidence submission | **Implemented (experiment build only)** | `experiment/CaseActionForms.tsx` `EvidenceForm`: LINK, TEXT, FILE_DIGEST; SHA-256 computed locally with `crypto.subtle`, no upload |
| Right of reply | **Implemented (experiment build only)** | `ReplyForm`, with the G6 warning: the reply locks the record, so add evidence first |
| Reply-deadline action | **Implemented (experiment build only)** | `DeadlineForm` (`process_reply_deadline`) |
| Assessment request | **Implemented (experiment build only)** | `AssessmentForm`. Shows the locked record; separate confirmation for the last attempt; never simulated, because that would run the model |
| Transaction lifecycle and uncertain-state recovery, all five writes | **Implemented** | `experiment/createCaseFlow.ts` (`submitWrite` plus per-method specs), `write/effects.ts`, `write/pendingStore.ts` |
| Downloadable report | **Implemented** | `pages/CaseReport.tsx` (`#/report/VC-…`). Exact label, print / save as PDF, standalone `.html` download, no scripts |
| Privacy copy (brief §10, spec §13) | **Implemented, verbatim** | `contract/copy.ts`. `copy.test.ts` reads the brief and spec files, so the text cannot drift |
| Live write of the four new methods | **Not verified (by design)** | Needs your separate approval of each exact transaction (§6) |
| A designated application deployment | **Not done** | Decision D2 |

## 1. Safety design (unchanged guarantees, extended per method)

**Ordinary build:**
- reads only;
- `CONTRACT_WRITES_ENABLED` stays `false`;
- every write UI sits in `src/experiment`, reached only through the single build-time-folded import in `pages/WritePreview.tsx`;
- **`dist/` contains none** of the 7 Phase 3.7 write-path strings, nor `submitWrite` or `CreateCaseWizard`.

**Write path, every method:** each write has the full `create_case` treatment:
- a review screen that encodes exactly what it shows;
- an acknowledgement plus one click;
- the common preflight under the cross-tab lock: wallet chain and account, RPC chain, gas price 0, code hash, `nonce latest == pending`;
- **method checks from fresh reads**:
  - the case must read identically at latest-final and latest-nonfinal;
  - role, state, quotas and attempts;
- a `gen_call` simulation where safe;
- the write-ahead record;
- the guard: one request, byte-exact calldata;
- monitoring;
- success only after finality **plus** a latest-final read showing the method's effect. More than one matching change is ambiguous, never success.

**Effect checks** (`write/effects.ts`), used for verification and for reconciling an uncertain write:

| Method | Effect |
|---|---|
| `create_case` | unchanged from Phase 3.5C |
| `submit_evidence` | exactly one identical new item **after the baseline count** |
| `submit_reply` | response SUBMITTED with the same text |
| `process_reply_deadline` | NO_RESPONSE_BY_DEADLINE |
| `request_assessment` | the attempt count rose above the baseline |

**The write-safety record:** the expected effect is now a per-method union. Parsing is strict and fail-closed: a mismatched effect makes the record unreadable, which blocks every write. Phase 3.6 records stay readable.

**Read path:**
- the configured contract is checked once per session: chain, code hash, schema versions;
- independent reads run in parallel: a cold case load fell from about 14 s to about 4 s, with the same 11 requests;
- a read that failed at the network level is retried **once** after 1.5 s; timeouts and RPC errors are not;
- there is no polling.

## 2. Verification evidence

**Gates (frontend, `frontend/`):**

| Gate | Result |
|---|---|
| `npm run typecheck`; `tsc -p scripts/stage-a`; `npm run lint` | pass |
| `npx vitest run --maxWorkers=2` | **792 passed / 39 files** (Phase 3.7: 616 / 30). `--maxWorkers=2` because this machine has about 1.7 GB of free memory: the default worker count timed out while starting workers, before any test ran |
| `npm run build` | pass |
| `npm audit` | 0 vulnerabilities |
| `dist/` write-path scan | 0 hits for every string |
| Experiment build, unarmed | gate inputs compile to `ack: void 0, contract: void 0`: inert |

**Contract (unchanged):**
- 454 Python tests pass (WSL, 94 s);
- `genvm-lint` passes: 14 methods (9 view, 5 write).

**Mutation check:** 14 deliberate breaks of new safety-critical lines; **14/14 caught**. Two (M5: evidence baseline ignored; M14: a timeout retried) were first missed, and each got a direct test.

**Live, read-only** (production bundle built with the test contract, browser pane), about 50 requests in total:

| Check | Result |
|---|---|
| `VC-000001` | Final record; register; timeline with the 5 recorded transaction IDs; INCONCLUSIVE outcome with "no direction established" citations, provenance blocks and verbatim notices |
| `VC-000002` | Rendered as a report: exact label at both ends, finality, versions, "not signed" note |
| `VC-000003` | "The reply window appears to have closed (…, by this device's clock)", not "no response"; Phase 3.6 create transaction listed |
| A transient "Failed to fetch" seen once | Shown as "StudioNet could not be read… safe to repeat"; the manual retry succeeded. This led to the categorisation fix and the single network retry |
| **Mobile, 375 px** (closes Phase 3.7's not-verified item) | 0 px horizontal overflow on all 8 routes |
| **Accessibility** | Every interactive element has an accessible name; no positive tab indexes; one h1 per page |

**Display safety:**
- the forbidden-term scan now covers the new history, lock, reply-window and action wording for every state and role;
- page tests scan rendered pages for verdict, winner, loser, ruling, guilty and liable, outside the exact mandatory sentences;
- duplicate screen-reader alerts on form errors were found and removed.

## 3. Files

**New:**
- `src/cases/`: `caseReads`, `consistency`, `actions`, `localHistory`, `knownTransactions`, `useCaseData`, plus tests;
- `src/components/`: `AssessmentView`, `CaseRecord`, `CaseTimeline`, `EvidenceRegister`, `ExternalLink`, `CaseLoadStatus`, `FormField`;
- `src/pages/`: `CaseDetail`, `CaseReport`, plus tests;
- `src/display/caseText.ts`, `src/contract/copy.ts`, `src/config/contract.ts`;
- `src/write/caseActions.ts`, `src/write/effects.ts`, plus tests;
- `src/experiment/`: `CreateCaseWizard`, `CaseActionForms`, plus tests.

**Changed:**

| Area | Files |
|---|---|
| Routing and shell | `app/routes.ts`, `App.tsx`, `Layout.tsx` |
| Read gateway and errors | `live/gateway.ts`, `live/validate.ts`, `live/errors.ts` (adds `get_party_case_ids`; a wrapped "Failed to fetch" is a network error) |
| Pages and review | `pages/Dashboard.tsx`, `pages/Limitations.tsx` (exact notices), `pages/WritePreview.tsx` (build flag and query only; the gated import is unchanged), `components/WriteConfirmation.tsx` (generic review plus the mandatory warning) |
| Write path | `components/CaseSnapshot.tsx`, `experiment/createCaseFlow.ts`, `experiment/ExperimentWritePanel.tsx`, `experiment/sdkExperiment.ts`, `write/pendingStore.ts`, `write/reconcileReader.ts` |
| Styles and docs | `styles/global.css` (case, timeline, evidence slips, form and print styles), `frontend/README.md` |
| Tests | `App.test.tsx`, `forbidden-terms.test.ts`, `isolation.test.ts`, `readCheck.test.ts`, `experimentHarness.ts` |

**Not touched:**
- `contracts/`, `tests/`, `package.json`, the lockfile;
- `config/writeGate.ts` (allow-list and five conditions);
- `config/network.ts`;
- the guard, runner, durable session and lock.

**Temporary:** `.claude/launch.json` was created for the live preview and **deleted** afterwards; the server is stopped.

## 4. Known limitations

1. **Transaction IDs in the timeline** are limited to recorded test runs and this browser's own writes (G1). The contract stores none, and no verified API lists them.
2. **Contract-shaped gaps (G2–G7):**
   - no "declined" state;
   - no CLOSED state;
   - no milestone field: it goes into the deliverable text;
   - templates are hints only;
   - a reply locks the record;
   - deadlines are judged by the device clock until the contract records them.
3. **Per-profile safety:** the write-safety record and lock are per browser profile.
4. **The wallet may change the gas limit** (R2). Keep the prompt checklist from `PHASE_3_6_BROWSER_WALLET_TEST_CHECKLIST.md` §3.5.
5. **`request_assessment` is never simulated**, because simulation would run the model. Its deterministic preconditions are read-checked instead.
6. **The local draft of the wizard is kept in memory only** and is lost on reload.
7. **No CSP header:** set it at the static host when a deployment exists.

## 5. How to run

**Read-only app against the test contract:**

```bash
VITE_VERICOURT_CONTRACT_ADDRESS=0x3258A80A86920792354A9b7e59D5Ed2409E96220 npm run dev
```

**Write experiment (only with your approval of each transaction):** same five conditions as Phase 3.6 (`frontend/README.md`). Then:
- `#/review?action=create_case`
- `#/review?action=submit_evidence&case=VC-…`
- `#/review?action=submit_reply&case=VC-…`
- `#/review?action=process_reply_deadline&case=VC-…`
- `#/review?action=request_assessment&case=VC-…`

The case page links to these when the action is allowed.

## 6. Next steps (need your decision)

1. **Live tests of the four new writes**, one approved transaction each, fictional data, on the test contract, in this order:
   1. `process_reply_deadline` on `VC-000003`: its deadline has passed, it can be run by its throwaway claimant `0x16fD…105A`, and it is the smallest effect;
   2. `submit_evidence` and `submit_reply` on a new fictional case;
   3. `request_assessment`.

   Each would get a Phase 3.6-style exact-transaction review first.
2. **D2:** an application deployment and a static host, with a CSP header, for release.
