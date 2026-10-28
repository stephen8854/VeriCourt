# Phase 3.7: MVP acceptance audit

**Date:** 2026-10-19.

**Scope:** verification and release readiness only. No feature work, no transactions, no deployments, no dependency changes, no contract changes, no commits.

## Verdict

| Layer | Verdict |
|---|---|
| **Intelligent Contract** (`contracts/vericourt.py`) | **ACCEPTED.** Lint clean; 454 direct and harness tests pass; every brief §7 test topic is covered; three StudioNet assessment runs plus two live writes (Phases 2.14–2.17C, 3.5A, 3.6) |
| **Read path, wallet layer, safety-critical write infrastructure** (guard, persistence, gate, confirmation, monitoring, reconciliation) | **ACCEPTED.** 616 frontend tests; the ordinary build has no write path; one live browser-wallet write verified end to end (Phase 3.6) |
| **MVP as defined by the brief and spec** | **NOT READY FOR RELEASE.** The core user workflows (brief §4 flows 2–6 and 9–10; brief Phase 4; spec Journeys A–F) **are not implemented in the UI**. The spec's definition of done ("core flows work from wallet connection through report export") is **not met** |

There is no defect in what exists. The gap is unbuilt scope: the brief's **Phase 4, core UI flows**, was never started. The project went from Phase 3 (frontend foundation) into write-safety work (Phases 3.5–3.6), and that work is a prerequisite for Phase 4.

---

## 1. Changes made in this phase

| File | Change |
|---|---|
| `frontend/src/config/testDeployments.ts` | `laterWrites` gains `VC-000003` (Phase 3.6 transaction `0x1574…08e0`). The header comment now says the contract holds 3 cases |
| `frontend/src/config/testDeployments.test.ts` | asserts both later writes, unique hashes, and that the live-check evidence is untouched |
| `docs/PHASE_2_17C_NO_REPLY_STUDIONET_REPORT.md` | Addendum 2 (`VC-000003`) |
| `docs/PHASE_3_7_ACCEPTANCE_AUDIT.md` | this report |

**One self-caught issue during the audit.** My first wording of the `VC-000003` record contained the text "write-experiment". The live-check page bundles that config, so the string tripped the ordinary build's write-path canary (1 hit). It was descriptive text, not code, but I reworded it rather than loosen the audit. The canary is back to **0**.

---

## 2. Regression results

| Gate | Command | Result |
|---|---|---|
| Frontend typecheck | `npm run typecheck` | pass |
| Script typecheck | `tsc -p scripts/stage-a` | pass |
| Frontend lint | `npm run lint` | pass |
| Frontend tests | `npx vitest run` | **616 passed / 30 files** |
| Ordinary production build | `npm run build` | pass; **0** write-path or experiment strings in `dist/` (7 canaries) |
| Experiment build, no phrase | `vite build --mode write-experiment` | gate compiles to `ack: void 0, contract: void 0`, so it is inert |
| Experiment build, armed | the same, with phrase and contract | gate inputs = phrase plus `0x3258…6220` only |
| Contract lint | `genvm-lint check contracts/vericourt.py --json` (GenVM v0.2.16) | `ok`; lint 3/3; schema valid; 14 methods (9 view, 5 write) |
| Contract direct and harness tests | `pytest` in WSL (`~/.venvs/vericourt`) | **454 passed** (60 s) |
| Contract integrity | SHA-256 | `25bc9e0b…79333`, unchanged since Phase 2.17C |
| Dependencies | `npm audit` / `--omit=dev` | **0 vulnerabilities** (all severities) / 0 |
| Live state (read-only, 13 requests) | scratchpad verify script | chain 61999; code hash match; deploy and Stage A transactions FINALIZED; `get_case_count` **3** (final and non-final); `VC-000001` DECIDED, `VC-000002` AWAITING_RESPONSE |

**Integration (consensus) evidence on StudioNet:**
- Phases 2.14, 2.15 and 2.17C: assessment runs (clear, ambiguous, no-reply).
- Phase 3.5A Stage A: SDK local-key write.
- Phase 3.6: browser-wallet write, `VC-000003`, FINALIZED / MAJORITY_AGREE.

---

## 3. Requirements traceability

**Legend:**
- ✔ met;
- ◐ partly met;
- ✘ not met;
- n/a: not applicable.

### 3.1 Brief §4: core MVP flows

| # | Flow | Status | Evidence / gap |
|---|---|---|---|
| 1 | Connect injected wallet and verify network | ✔ | `#/wallet`; `wallet/*`; explicit-connection grant (Phase 3.6 fix) |
| 2 | Create case | ◐ | Contract ✔. UI: **only** the gated experiment, with **fixed fictional data**; no create-case wizard or form |
| 3 | Initial statement and evidence | ✘ (UI) | Contract `submit_evidence` ✔; no UI |
| 4 | Reply and counter-evidence | ✘ (UI) | Contract `submit_reply` ✔; no UI |
| 5 | Eligibility per contract rules | ✔ (contract) | lock and deadline rules plus tests; no UI surface |
| 6 | Request assessment | ✘ (UI) | Contract `request_assessment` ✔; no UI |
| 7 | Pending / consensus / finality display | ◐ | State model and monitoring ✔, used only by the experiment's create flow |
| 8 | Structured assessment and limitations | ◐ | `CaseSnapshot` plus display rules ✔, shown **only** on the live-check diagnostic for `VC-000001` |
| 9 | Timeline and transaction references | ◐ | Only on the live-check diagnostic; no general case-detail view |
| 10 | Browser-generated report export | ✘ | Not implemented |

### 3.2 Brief §8: UI areas

| Area | Status |
|---|---|
| Landing / How it works | ✔ |
| Wallet / network connection | ✔ |
| Dashboard or honest discovery fallback | ◐ An honest placeholder; "Open a case by ID" exists but is **disabled**; no local recent-case list; `get_party_case_ids` is available but not wired |
| Create-case wizard | ✘ (fixed-data experiment only) |
| Case detail and timeline | ✘ (diagnostic only) |
| Evidence register | ✘ |
| Right-of-reply panel | ✘ |
| Assessment request / transaction status | ◐ The status machinery exists; the request UI does not |
| Assessment result | ◐ Diagnostic only |
| Protocol diagnostics | ✔ (`#/wallet`, `#/live`) |
| Report preview / export | ✘ |
| Privacy and limitation notices | ◐ (§3.4) |

### 3.3 Spec §2: MVP acceptance criteria

| Criterion | Status |
|---|---|
| Wallet connects; UI identifies the network | ✔ |
| Create a case with required fields and see transaction feedback | ◐ (fixed fictional fields, gated build only) |
| Participants submit statements and evidence per the contract's rules | ✔ contract / ✘ UI |
| Only authorized participants act | ✔ (contract tests) |
| Defined right-of-reply window | ✔ contract / ✘ UI |
| No assessment before conditions | ✔ |
| Assessment normalized and validated before becoming state | ✔ |
| Malformed AI output cannot become a valid outcome | ✔ |
| UI differentiates submitted / pending / finalized / failed | ◐ (create flow only) |
| Inspect timeline and transaction identifiers | ◐ (diagnostic only) |
| Direct tests and lint pass; integration run where available | ✔ |
| No backend or off-chain database | ✔ |

### 3.4 Brief §10: privacy and legal copy

| Required text | Status |
|---|---|
| "Before you submit…" before case creation **and** evidence submission | ◐ A paraphrase is on `#/limitations`. The review screen has its own warnings ("public and permanent", "creates a case on chain"), but **not** the brief's exact text, and it lacks the "AI-assisted assessment, not legal advice or a guarantee" sentence. No evidence UI exists |
| A file hash verifies integrity, not authenticity | ✔ (`contract/notices.ts`, rendered with assessments) |
| External links can change or become unavailable | ✘ not present |
| Consensus is not a guarantee of objective truth | ✔ (Landing, notices) |
| Silence is not proof against the non-responding party | ✔ (no-response notice; claimant-only caution) |
| An outcome is marked final only with verified network status | ✔ (Limitations; `finalityLabel`; `verified` requires a latest-final read) |
| Report label "not a court judgment or legal opinion" | ✘ (no report) |

### 3.5 Brief §7: contract requirements and test coverage

**Contract requirements, all ✔:**
- `gl.Contract`;
- pinned Depends header (v0.2.16 runner);
- documented storage types;
- access control;
- state transitions and bounds;
- typed normalized assessment;
- snapshot digest and lock;
- capped retries (`MAX_ASSESSMENT_ATTEMPTS = 2`);
- view methods for the frontend;
- history log;
- no secrets;
- no admin override.

**Test topics, all covered:**

| Topic | Tests |
|---|---|
| Valid create | `test_create.py` |
| Empty or oversized fields | 12 tests |
| Access control | `test_reply`, `test_evidence`, `test_lifecycle` |
| State transitions | `test_lifecycle` |
| Assessment before reply conditions | `test_cannot_assess_before_lock` and others |
| No response | `test_no_reply_fixture`, deadline tests |
| Evidence limits | `test_per_party_limit` (10), `test_per_case_limit` (20) |
| Unknown evidence IDs | 9 tests |
| Malformed output | 9 tests |
| LLM and error paths | `test_model_call_failure_changes_nothing` and others |
| Snapshot lock | the locked-record tests |
| Duplicates and retries | `test_retry_after_failure_can_succeed` and others |
| No overwrite of a decided result | `test_decision_cannot_be_overwritten` |
| Equivalence and normalization | `test_equivalence.py` (36 matching tests) |

### 3.6 Spec §17: definition of done

| Item | Status |
|---|---|
| The same explicit case model in product and contract | ✔ (enums parsed from the contract source) |
| Every contract write has authorization, bounds and state validation | ✔ |
| Documented equivalence strategy | ✔ (`docs/ASSESSMENT_AGREEMENT_DESIGN.md`) |
| Verified GenLayerJS APIs and inspected schema | ✔ (genlayer-js 1.1.8 source-verified; live reads; Phase 3.6 write) |
| The UI never invents success or finality | ✔ (the `verified` gate; display rules) |
| **Core flows work from wallet connection through report export** | **✘** |
| Lint and direct tests pass; integration done or blocker documented | ✔ |
| No backend, database, Supabase, Firebase, Fly.io or server keys | ✔ |
| Forensic Pop design and accessibility | ◐ tokens, skip link, focus on navigation, reduced-motion rule ✔; **mobile layout not verified in this phase** (§6) |
| Privacy and legal limits visible before submission | ◐ (§3.4) |

---

## 4. Display-safety audit (Phase 2.18B rules)

| Rule | Status |
|---|---|
| UNRESOLVED shown as "Evidence the assessment considered — no direction established" | ✔ `display/citations.ts:13` |
| No-response notice, exact text | ✔ `contract/notices.ts` (the enum and notice tests parse the contract) |
| Claimant-only caution, exact text | ✔ `display/caution.ts:12–13` |
| "A majority of the validators that voted" | ✔ `display/provenance.ts:33`. Holds for `VC-000003`'s vote (3 AGREE, 2 IDLE) |
| `DECIDED` → "Assessment recorded"; "Final" only with a latest-final read | ✔ `display/labels.ts:26`; `finalityLabel` |
| Remedies advisory | ✔ provenance `advisory` blocks; `notices.ts:26`; Landing |
| No verdict / winner / loser | ✔ `forbidden-terms.test.ts` scans every generated label; the review-screen test scans its text; no forbidden-word hits in `src` outside tests |

**Note:** the experiment's uncertain-state message says "…is not proof that the write failed". This is procedural wording that *denies* proof, not an adjudication claim. It is outside the label scan's scope, and acceptable.

---

## 5. Security review

| Area | Finding |
|---|---|
| Write-path isolation | The ordinary build has no write path (0/7 canaries). `isolation.test.ts` pins the single gated dynamic import. Five-condition runtime gate; localhost-only bind |
| Write safety | one request per operation (guard); byte-exact intent; write-ahead record; cross-tab lock; uncertain operations block across reloads; reconciliation needs positive evidence; success needs finality plus a latest-final read. Mutation checks: 12 + 16 + 18 + 7, all caught |
| Wallet events | the `connectGrant` fix covers 5 race orderings and 8 negative cases; switch-away-and-back does not restore the grant |
| Secrets | **none found**: no `.env` files, no PEM or private-key markers, no mnemonic assignments, no key-named 64-hex values. `.gitignore` covers `.venv`, `integration-logs/`, `.env*`, `node_modules`, `dist` |
| Rendering | `dangerouslySetInnerHTML` banned by lint; a test injects markup into the review screen and checks it renders as text |
| Dependencies | `npm audit`: 0 vulnerabilities. Exact pins. **ESLint 9.39.5 is deprecated upstream** but required by genlayer-js's peer range (known, Phase 3.2) |
| Not done | no CSP header (static hosting would set it, and there is no deployment yet); no third-party pen test |

---

## 6. Not verified in this phase

1. **Mobile layout and keyboard walk-through.**
   - **What happened:** the browser pane was hidden, so measurements returned `innerWidth = 0`. The results were discarded, not reported.
   - **Verified instead:** from code and the DOM: a skip link exists; `#main` is focusable for focus-on-navigation; a `prefers-reduced-motion` rule exists.
   - **Manual step:** open `npm run preview` at 375 px width and tab through each page.
2. **The live-check page in a browser** against the now 3-case contract. The equivalent reads were done by script; the page only requires `VC-000001 ≤ count`, so 3 is compatible.

---

## 7. Residual-risk register

| # | Risk | Likelihood / impact | Mitigation in place | Owner action |
|---|---|---|---|---|
| R1 | **Core UI workflows missing** (§3) | certain / blocks MVP release | none (unbuilt) | Phase 4 |
| R2 | The wallet changes fields after the guard's check (seen: gas limit 500k → 750k) | medium / low on gasless StudioNet | operator prompt check; post-hoc signed-bytes verification | Keep the prompt checklist; consider showing the expected gas range |
| R3 | StudioNet accepts duplicate raw transactions and does not validate nonces | low / medium | one-request guard, durable record, lock, duplicate-case detection | none |
| R4 | The safety record is per browser profile | low / medium | documented | Explain in the user-facing write flow |
| R5 | StudioNet RPC limit, 500 requests per hour per IP | medium / medium (reads fail during live use) | bounded polling | Budget polling in Phase 4 (the live check is ~23 requests; monitoring 10 s is ~180 per 30 min) |
| R6 | No designated application deployment; only throwaway test contracts | certain / blocks release | allow-list limited to test contracts | Decide and deploy (§5 procedure in Phase 3.5) |
| R7 | The title regenerates on remount (experiment) | certain / UX friction only | re-review required | Phase 4 forms make this moot |
| R8 | Privacy-copy gaps (§3.4) | certain / medium | partial copy | Phase 4 |
| R9 | ESLint 9 deprecated | low / low | pinned | Revisit when genlayer-js allows |
| R10 | The one unexplained 544/27 test-count run (Phase 3.6) | low / low | not recurred in more than 10 runs | none |
| R11 | Desktop app auto-starts preview servers from `.claude/launch.json` | low / low | file removed | Avoid that file during live tests |

---

## 8. Recommendation

**Release decision: NOT READY.** The safety-critical foundations are in place and verified on-chain. To meet the MVP definition, **Phase 4 (core workflows)** is needed, built on the existing guarded write stack:
- a create-case form;
- case detail and timeline (live reads by ID; local recent-case IDs labelled browser-local);
- an evidence register;
- right of reply;
- an assessment request and result;
- report export with the required label;
- the exact §10 copy.

**Prerequisite decisions for you:**
1. **Write scope.** Generalize the experiment gate to all five contract writes, or keep it gated per action. Stay localhost and experiment-only until release.
2. **An application deployment** (R6).
3. Whether Phase 4 targets the throwaway test contract for development.

Phase 4 has **not** been started.
