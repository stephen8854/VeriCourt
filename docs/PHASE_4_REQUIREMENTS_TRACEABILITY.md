# Phase 4.0A: requirements traceability and architecture

**Date:** 2026-10-19.

**Scope:** planning only.
- No source, test, contract or configuration file was changed. This document is the only new repository file.
- No transaction, wallet prompt, deployment, dependency change or commit.
- One read-only verification of the development target ran from a scratchpad script (6 RPC requests, §2).

**Status: READY FOR REVIEW.** Phase 4.0B (read-only case experience) will not start until you approve this plan.

**Legend (all tables):**
- ✔ implemented and tested;
- ◐ partly implemented;
- ✘ not implemented;
- ⊘ cannot be implemented correctly with the current contract (§5);
- ? not verified.

**Milestones referenced:**
- **4.0B:** read-only case experience;
- **4.0C:** review and test of 4.0B;
- **4.1–4.6:** write workflows and report (§9). Each needs separate approval, and none sends a transaction without separate, explicit authorization.

---

## 1. Sources read

| Document | Location | Read |
|---|---|---|
| Product, protocol and design spec | `VeriCourt_Product_Protocol_Design_Spec.md` | in full |
| Coding-agent build brief | `VeriCourt_Claude_Code_Build_Brief.md` | in full |
| Phase 3.7 acceptance audit | `docs/PHASE_3_7_ACCEPTANCE_AUDIT.md` | in full |
| Phase 3.6 browser-wallet test checklist | `docs/PHASE_3_6_BROWSER_WALLET_TEST_CHECKLIST.md` | in full |
| Phase 3.5C write wiring report | `docs/PHASE_3_5C_WRITE_WIRING_REPORT.md` | in full |
| Intelligent Contract | `contracts/vericourt.py` (1480 lines) | in full |
| Frontend source | `frontend/src/**`: pages, components, display, contract, live, wallet, tx, write, experiment, config | every non-test module that a Phase 4 view touches, in full; the rest of `src/write` and `src/experiment` by structure and exports |

**All requested documents exist at the expected paths.** Nothing had to be searched for or reconstructed.

---

## 2. Development target: verified read-only

**Target:** `0x3258A80A86920792354A9b7e59D5Ed2409E96220` on StudioNet (chain 61999). This is the Phase 2.17C throwaway test deployment, `config/testDeployments.ts`.

**How it was checked:**
- **Run:** 2026-10-19 15:44 UTC.
- **Method:** a scratchpad script. Every request passed through the Stage A bounded fetch with a read allow-list of `eth_chainId`, `gen_getContractCode` and `gen_call`.
- **Log:** `integration-logs/phase-4-0a-readonly-verify-20261019T154410Z.json` (git-ignored).

| Check | Result |
|---|---|
| `eth_chainId` | `0xf22f` (61999) ✔ |
| Deployed code SHA-256 | `25bc9e0b…79333`. Equals the repository's `contracts/vericourt.py` **and** the recorded expectation ✔ |
| `get_case_count` at latest-final / latest-nonfinal | 3 / 3 ✔ |
| `get_party_case_ids(0x16fD…105A, 0, 10)` | `{"total": 1, "case_ids": ["VC-000003"]}` ✔. This view is not yet wired in the app; genlayer-js 1.1.8 encodes JS numbers for `offset` and `limit` correctly |
| `get_case_history("VC-000003")` | one `CASE_CREATED` entry at `1792391915` (2026-10-19 06:38:35 UTC); `reply_deadline=1792395515` (07:38:35 UTC) |
| Requests | **6, all read-only** |

**Treated as a test deployment, not production.** It holds three fictional cases:

| Case | State |
|---|---|
| `VC-000001` | DECIDED; the response was recorded as no reply by the deadline |
| `VC-000002` | AWAITING_RESPONSE (Stage A) |
| `VC-000003` | AWAITING_RESPONSE (Phase 3.6) |

**A useful fixture for Phase 4.0B:** the reply deadline of `VC-000003` has **passed**, yet its status stays AWAITING_RESPONSE because nobody has called `process_reply_deadline`. The read-only views must show this state correctly (§6.6).

No case will be overwritten or reset; the contract has no method that could.

---

## 3. The contract interface, as Phase 4 must use it

### 3.1 Writes (5)

| Method | Caller | Preconditions (enforced on chain) | Effect | Returns | Idempotent? |
|---|---|---|---|---|---|
| `create_case(respondent, category, title, agreement_summary, expected_deliverable, claim, requested_remedy, issues[], reply_window_seconds)` | anyone; the sender becomes the claimant | respondent ≠ sender and ≠ zero address; category in `SOFTWARE, DESIGN, WRITING, OTHER`; text limits (§3.3); 1–5 distinct issues; reply window between 1 hour and 30 days | new case `VC-nnnnnn`, AWAITING_RESPONSE / PENDING; issues `I1…`; history `CASE_CREATED`; both parties indexed | case ID | **No.** A repeat creates a second case |
| `submit_evidence(case_id, evidence_type, label, description, content_ref, sha256, issue_ids[])` | claimant **or** respondent | not locked; AWAITING_RESPONSE; **now ≤ reply_deadline**; at most 10 items per party and 20 per case; type `LINK` (http(s) URL ≤ 512, optional SHA-256), `TEXT` (≤ 2000, no SHA-256) or `FILE_DIGEST` (SHA-256 required, optional file name ≤ 200); 1–5 known, distinct issue IDs | item `E{n}`; history `EVIDENCE_SUBMITTED` | evidence ID | **No.** A repeat adds a duplicate item and uses up quota |
| `submit_reply(case_id, reply)` | respondent only | AWAITING_RESPONSE / PENDING; now ≤ deadline; reply ≤ 4000 | response SUBMITTED; **the record locks immediately**; READY_FOR_ASSESSMENT; history `REPLY_SUBMITTED` and `SNAPSHOT_LOCKED` | — | Effectively yes: a second call fails ("not awaiting a response") |
| `process_reply_deadline(case_id)` | either party | AWAITING_RESPONSE / PENDING; **now > deadline** | response NO_RESPONSE_BY_DEADLINE; record locks; READY_FOR_ASSESSMENT; history `REPLY_WINDOW_EXPIRED` and `SNAPSHOT_LOCKED` | — | Effectively yes: a second call fails |
| `request_assessment(case_id)` | either party | READY_FOR_ASSESSMENT; locked; digest intact; attempts < 2; no assessment stored | Either a validated assessment is stored (DECIDED), or a consensus-agreed invalid output counts one attempt (after 2: ASSESSMENT_FAILED). **Reverted or UNDETERMINED transactions change nothing and do not count** | outcome, or `ATTEMPT_FAILED` | **Dangerous to repeat.** After one failed attempt, a duplicate uses up the **last** attempt (§8.3) |

### 3.2 Views (9)

| View | Arguments | Used by the app today | Phase 4 use |
|---|---|---|---|
| `get_contract_info` | — | live check | limits and enum discovery; a schema check before showing data |
| `get_case_count` | — | live check | case-ID existence (IDs are sequential and never deleted) |
| `get_case` | case ID | live check, reconciliation | case detail; finality comparison |
| `get_case_status` | case ID | live check | dashboard rows (smaller than `get_case`) |
| `get_case_evidence` | case ID | live check | evidence register |
| `get_case_history` | case ID | live check | timeline |
| `get_assessment_status` | case ID | live check | assessment status and eligibility |
| `get_assessment` | case ID | live check | assessment result |
| `get_party_case_ids` | address, offset, limit (1–50) | **not wired** (missing from `live/gateway.ts` `READ_METHODS`); used by the experiment's reconciliation reader | "Your cases" dashboard |

### 3.3 State machine and limits (from the contract source)

```
create_case ─▶ AWAITING_RESPONSE / PENDING ── evidence from either party (until the deadline, before the lock)
   ├─ submit_reply (respondent, ≤ deadline)       ─▶ lock ─▶ READY_FOR_ASSESSMENT / SUBMITTED
   └─ process_reply_deadline (either, > deadline) ─▶ lock ─▶ READY_FOR_ASSESSMENT / NO_RESPONSE_BY_DEADLINE
READY_FOR_ASSESSMENT ── request_assessment ─┬─ valid ─────────────▶ DECIDED (terminal)
                                            ├─ invalid, attempt 1 ─▶ READY_FOR_ASSESSMENT (1 attempt left)
                                            └─ invalid, attempt 2 ─▶ ASSESSMENT_FAILED (terminal)
ASSESSMENT_PENDING: reserved, never stored ("pending" is the transaction's status, not a case status)
```

**Limits** (code points):

| Field | Limit |
|---|---|
| title | 5–120 |
| agreement summary | 2000 |
| deliverable | 1000 |
| claim | 4000 |
| remedy | 1000 |
| issues | 1–5, each ≤ 300 |
| reply | 4000 |
| evidence label | 120 |
| evidence description | 1000 |
| text excerpt | 2000 |
| URL | 512 |
| file name | 200 |
| `get_party_case_ids` page | ≤ 50 |

Control characters other than `\n` and `\t` are rejected throughout.

**Errors:** prefix `[EXPECTED]` for business rules, `[LLM_ERROR]` and `[TRANSIENT]` inside the assessment.

**Times** are the transaction timestamp (`_now()`), in Unix seconds.

**History entries** carry `seq`, `action`, `actor`, `at` and `detail`, **but no transaction hash** (§5).

---

## 4. Traceability matrix

### 4.1 Required product workflows

| # | Workflow | Spec / brief source | Contract reads / writes | Current implementation (files) | Status | Planned milestone |
|---|---|---|---|---|---|---|
| 1 | **Create case** | Spec Journey A, §10.3 wizard; brief §4 flow 2 | write `create_case`; reads `get_case_count`, `get_party_case_ids`, `get_case` (preflight and verification) | Gated experiment only, with fixed fictional input: `experiment/createCaseFlow.ts`, `ExperimentWritePanel.tsx`, `components/WriteConfirmation.tsx`, `write/createCase.ts` (validation mirrors the contract) | ◐ | **4.2**: an editable wizard on the existing guarded `create_case` path |
| 2 | **Case list / dashboard** | Spec §10.2, discovery constraint; brief §8 "Case discovery" | `get_party_case_ids` (paged), `get_case_status` per ID, `get_case_count` | `pages/Dashboard.tsx`: an honest placeholder; "Open a case by ID" is **disabled** | ✘ | **4.0B** |
| 3 | **Case detail and status** | Spec §10.4; Journey E header | `get_case` (both variants), `get_assessment_status` | Only the `#/live` diagnostic for `VC-000001` (`components/CaseSnapshot.tsx`) | ◐ (diagnostic) | **4.0B** |
| 4 | **Case timeline / history** | Spec §10.4, §11 timeline; brief §4 flow 9 | `get_case_history` | Read and validated in the live check; **never rendered** | ✘ | **4.0B** (the history entries). Transaction references: ⊘ beyond locally known hashes (§5, G1) |
| 5 | **Evidence submission and register** | Spec Journey B, §7; brief §4 flow 3 | write `submit_evidence`; read `get_case_evidence` | Register: a minimal list in `CaseSnapshot`. Submission: none | Register ◐; submission ✘ | Register **4.0B**; submission **4.3** |
| 6 | **Respondent right of reply** | Spec Journey C; brief §4 flow 4 | write `submit_reply`; reads `get_case` (response state, deadline) | Response-state label only | ✘ | Read-only reply display **4.0B**; reply form **4.4** |
| 7 | **Reply-deadline handling** | Spec Journey C.4–5; brief §5 invariants | write `process_reply_deadline`; reads `reply_deadline`, `response_state` | No-response notice (`display/notices.ts`). No deadline display, no action | ◐ | Deadline display **4.0B**; the action **4.4** |
| 8 | **Assessment request and status** | Spec Journey D; brief §4 flows 6–7 | write `request_assessment`; read `get_assessment_status` | Status read in the live check only; no request UI | ✘ | Read-only status **4.0B**; request **4.5** |
| 9 | **Assessment results and cited evidence** | Spec Journey E; brief §4 flow 8 | read `get_assessment`, `get_case_evidence` | `CaseSnapshot` with the Phase 2.18B display rules (citations, caution, provenance, remedy, notices), **diagnostic only** | ◐ | **4.0B**: reuse the display rules in the general case view |
| 10 | **Downloadable report** | Spec Journey F, §10.7; brief §8 "Report export" | all case reads | None | ✘ | **4.6** (browser-generated; no dependency, no service) |
| 11 | **Wallet, network, transaction lifecycle, uncertain-state recovery** | Spec §9 frontend, §14; brief §8 "Transaction UX" | wallet `eth_chainId`, `eth_accounts`, `eth_requestAccounts`; SDK write; `getTransaction`; reconciliation reads | ✔ wallet and network (`wallet/*`, `#/wallet`). ✔ lifecycle and uncertain-state recovery for `create_case` (`tx/state.ts`, `write/*`, `experiment/*`). Live-verified in Phase 3.6 | ◐ (one method) | Generalize per write in **4.1** (§8). No change in 4.0B |
| 12 | **Privacy disclosures, evidence limitations, external-link warnings** | Brief §10; spec §13, §7 | — | `pages/Limitations.tsx` (a paraphrase), Landing, contract notices; **missing** the exact "Before you submit" text and "External links can change…" (§4.2) | ◐ | Exact copy constants and link warning **4.0B**; shown at each submission point **4.2–4.4** |

### 4.2 Privacy and limitation requirements

**Mandatory text, exactly as written in brief §10 and spec §13:**

> **Before you submit:** Information written to a public blockchain may be visible and permanent. Do not submit passwords, private keys, confidential information, or personal data you do not have permission to share. VeriCourt provides an AI-assisted assessment, not legal advice or a guarantee of a legally binding result.

| Requirement | Source | Exact wording required? | Current status | Plan |
|---|---|---|---|---|
| P1 "Before you submit…" before case creation **and** evidence submission | brief §10, spec §13 | **Yes**, the text above | ◐ A paraphrase on `#/limitations`; **not** on the review screen | **4.0B:** one exported constant with the exact text, plus a test comparing it to the brief. **4.2 / 4.3:** rendered on the create and evidence review screens before the acknowledgement |
| P2 Onchain information may be permanent and public | your Phase 4 §5; covered by P1 | Covered by P1 | ◐ | P1 |
| P3 Evidence may be sensitive; redact or avoid submitting it | your Phase 4 §5 | The brief has no exact text beyond P1 | ◐ (P1 paraphrase) | P1, **plus** a supplementary sentence on the evidence form, e.g. "Remove or redact sensitive details before you reference a document." It is added next to P1, never instead of it. **Wording to confirm (§10, D5).** Note: VeriCourt has **no upload**; the copy must not imply that files are uploaded |
| P4 "External links can change or become unavailable." | brief §10, spec §13 | **Yes** | ✘ | **4.0B:** a constant, shown next to every rendered external link in the evidence register; **4.3:** on the evidence form |
| P5 Evidence registration records metadata and references; the contract does not verify external files or URLs | your Phase 4 §5; spec §7 | No exact brief text. The contract's own notice applies verbatim | ✔ `NOTICE_EXTERNAL_NOT_OPENED` (assessments, `#/limitations`); per-item notes in `display/citations.ts` | **4.0B:** shown in the evidence register as well |
| P6 Not a court judgment, legal advice or guaranteed enforcement | P1; contract `STANDARD_NOTICES[0]`; `display/remedy.ts` | P1 and the contract notice are exact | ✔ in assessments and Landing | Kept; also in the case view and the report |
| P7 "A file hash helps verify file integrity; it does not prove that the file is authentic or true." | brief §10, spec §13 | **Yes**, spec wording | ✔ (contract `STANDARD_NOTICES[2]`) | Also next to `FILE_DIGEST` items in the register (4.0B) |
| P8 "Protocol consensus is not a guarantee of objective truth." | brief §10 | Brief wording; the contract's variant is used today | ✔ (contract variant) | Unchanged |
| P9 "A missing response is recorded as a procedural fact, not automatic proof against the non-responding party." | spec §13 | The contract notice is verbatim | ✔ (`NOTICE_NO_RESPONSE`) | Unchanged |
| P10 Final only when network status confirms it | brief §10, spec §13 | Rule, not text | ✔ (`finalityLabel`; `verified` needs a latest-final read) | Applied to every case view (§6.5) |
| P11 Report label: "VeriCourt case report — not a court judgment or legal opinion." | brief §8, spec Journey F | **Yes** | ✘ | **4.6** |

**A test gap to close in 4.0B.** `display/forbidden-terms.test.ts` scans generated labels only, and bans "proof" and "truth". Mandatory copy such as P8 and P9 legitimately contains those words. 4.0B will extend the scan to the new pages' static text, with an **explicit allow-list of the exact mandatory sentences only**, so the ban still applies to everything else.

### 4.3 Contract method coverage

| Method | Kind | Wired today | Phase 4 milestone |
|---|---|---|---|
| `get_contract_info` | view | live check | 4.0B (schema and version check) |
| `get_case_count` | view | live check | 4.0B (existence of an ID) |
| `get_case` | view | live check, reconciliation | 4.0B |
| `get_case_status` | view | live check | 4.0B (dashboard rows) |
| `get_case_evidence` | view | live check | 4.0B |
| `get_case_history` | view | live check (not rendered) | 4.0B |
| `get_assessment_status` | view | live check | 4.0B |
| `get_assessment` | view | live check | 4.0B |
| `get_party_case_ids` | view | experiment reconciliation only | 4.0B (add to the read gateway allow-list) |
| `create_case` | write | gated experiment | 4.2 |
| `submit_evidence` | write | — | 4.3 |
| `submit_reply` | write | — | 4.4 |
| `process_reply_deadline` | write | — | 4.4 |
| `request_assessment` | write | — | 4.5 |

### 4.4 Safety requirements (locked constraints)

| Constraint | Enforced today by | How Phase 4 keeps it |
|---|---|---|
| Contract and storage unchanged | SHA-256 `25bc9e0b…` checked by the live check, a unit test and the preflight | No contract edits. 4.0C re-hashes the contract |
| No dependency upgrades | exact pins in `package.json` / lockfile | 4.0B uses only React, the existing SDK read path, `crypto.subtle` and DOM APIs |
| No commits, deployments or transactions | process | Unchanged |
| The ordinary production build cannot submit | `CONTRACT_WRITES_ENABLED = false`; build-time fold of the experiment import (`pages/WritePreview.tsx:44`); `write/isolation.test.ts`; `dist/` canary scan (7 strings) | 4.0B adds **no** write imports. The isolation test already forbids pages and components from referencing `writeContract`, `eth_sendTransaction`, the durable session, the guard runner and the guarded provider. 4.0C re-runs the canary scan |
| Experimental writes gated and localhost-only | `config/writeGate.ts` (5 conditions), `vite.config.ts` 127.0.0.1 binding | Unchanged in 4.0B. The 4.1 generalization keeps all 5 conditions (§8.1) |
| Guards, allow-list, uncertain-write recovery, build isolation never weakened | `write/guard.ts`, `guardedProvider.ts`, `durableSession.ts`, `pendingStore.ts`, `writeLock.ts`; mutation suites | Not touched in 4.0B. 4.1 extends them per method without removing checks, and re-runs the mutation suites |
| No backend, database, indexer, keeper, API or server key | architecture | Discovery uses contract views plus labelled browser-local recent IDs (§6.3) |
| Pinned SDK and verified interfaces | `live/sdkGateway.ts` (4 read operations) | 4.0B reuses the same gateway and only adds `get_party_case_ids` to `READ_METHODS`. Its shape was verified live (§2) |
| Forensic Pop and display-safety language | `styles/tokens.css`, `display/*`, `contract/notices.ts`, `forbidden-terms.test.ts` | 4.0B reuses `display/*` unchanged and extends the forbidden-term scan (§4.2) |
| Never overwrite or reset StudioNet cases | contract has no such method | Nothing to do |
| No wallet prompt in 4.0B | `WalletContext` reads passively (`eth_chainId` and `eth_accounts`, which never prompt); `eth_requestAccounts` only from the Connect button | 4.0B uses the **existing** passive account for "Your cases" and never calls Connect itself |

### 4.5 Acceptance criteria

**Spec §2:**

| Criterion | Today | After 4.0B | Completed by |
|---|---|---|---|
| Wallet connects; the network is identified | ✔ | ✔ | — |
| Create a case with required fields and transaction feedback | ◐ | ◐ | 4.2 |
| Participants submit statements and evidence per the contract's rules | ✘ UI | ✘ | 4.3, 4.4 |
| Only authorized participants act | ✔ contract | ✔ (the UI will also show who may act) | 4.3–4.5 UI hints |
| Defined right-of-reply window | ✔ contract | ◐ (deadline shown) | 4.4 |
| No assessment before conditions | ✔ | ✔ (eligibility shown) | 4.5 |
| Assessment normalized and validated | ✔ | ✔ | — |
| Malformed output cannot become an outcome | ✔ | ✔ (and invalid reads are never rendered) | — |
| UI distinguishes submitted / pending / finalized / failed | ◐ | ◐ | 4.1 |
| Inspect timeline and transaction identifiers | ◐ | ◐ (timeline ✔; transaction IDs limited, §5 G1) | 4.1 (local hashes), 4.6 |
| Lint and tests pass; integration run where available | ✔ | ✔ | 4.0C |
| No backend | ✔ | ✔ | — |

**Your Phase 4 §6 criteria for the first milestone (4.0B + 4.0C):**

| Criterion | How it will be shown |
|---|---|
| Requirements mapped to real source files and contract methods | this document (§4.1, §4.3, §6.8) |
| The read-only case experience uses actual contract data | a live read of `VC-000001…3` on the test contract, through the app's own gateway (§6.9) |
| All displayed outcomes follow the display-safety rules | reuse of `display/*`; tests on new views; the extended forbidden-term scan |
| No new write route | isolation test plus the `dist/` canary scan |
| Existing safety controls intact | the full regression suite plus a contract hash check |
| Tests, typecheck, lint and build pass | the 4.0C gate table |
| Final report separates implemented / partial / unimplemented / unverified | the 4.0C report format |

### 4.6 Spec §14 edge cases

| Edge case | Read-only handling (4.0B) | Write handling |
|---|---|---|
| Wallet unavailable or rejected | "Your cases" shows "Connect a wallet on the Wallet page to list your cases"; open-by-ID still works | ✔ existing |
| Wrong network | The wallet chain does not affect reads (they go to the StudioNet RPC). A wrong-chain banner from the existing wallet state | ✔ existing guard and preflight |
| Missing or invalid contract address | "Not configured" state; no reads attempted | ✔ gate |
| Schema mismatch | Before any case data is shown: deployed code hash and `get_contract_info.schema_version` must match | ✔ preflight |
| Read failure | "Network unavailable" state with the error category (timeout, network/CORS, RPC, unparseable). **No automatic retry**; a manual Refresh | — |
| Wallet rejects a write | — | ✔ existing; 4.1 per method |
| Submitted but pending / failed / rejected by consensus | — | ✔ (`tx/state.ts`); 4.1 per method |
| Receipt unavailable | — | ✔ uncertain-state lock |
| Malformed LLM output | Contract-side ✔. UI shows ASSESSMENT_FAILED and attempt counts neutrally | 4.5 |
| Empty, oversized or invalid input | — | 4.2–4.4 pre-validation mirrors the contract limits |
| Unauthorized action | UI shows the viewer's role (claimant, respondent or none) | Actions hidden or disabled for non-parties; the contract still decides |
| Case already advanced | "Inconsistent or changed" states (§6.6) | Fresh read inside the preflight |
| Duplicate assessment request | Attempts and remaining attempts shown | 4.5 (§8.3) |
| Retry limit reached | ASSESSMENT_FAILED label (existing, neutral) | 4.5 |
| A party never responds | Deadline-passed state (§6.6) | 4.4 |
| The same evidence ID cited twice | Contract rejects it; display de-duplicates groups (`citations.ts`) | — |
| Report with incomplete data | — | 4.6 |

---

## 5. What the current contract cannot support correctly

These are facts of the deployed, unchanged contract. **No contract change is proposed in this document.** Each item has an honest frontend treatment.

| ID | Requirement | Limitation | Treatment without contract changes |
|---|---|---|---|
| **G1** | Timeline with **transaction references** for every event (spec Journey F; brief §8 report) | History entries have no transaction hash. Nothing verified in genlayer-js 1.1.8 or StudioNet lists a contract's transactions, and an indexer is out of scope | The timeline shows contract history (action, actor, time, detail). Hashes appear **only** for writes made from this browser (the local write record) and for the recorded test transactions. Both are labelled "known to this browser" and never presented as complete |
| **G2** | "No response yet" vs "**declined** to respond" (spec Journey C.3) | Only `PENDING`, `SUBMITTED` and `NO_RESPONSE_BY_DEADLINE` exist | Never infer intent. Use the existing neutral labels only |
| **G3** | `DRAFT`, `OPEN`, `CLOSED`, `APPEAL_OR_FINALITY_PENDING` states (spec §6) | Not contract states. `OPEN` is effectively `AWAITING_RESPONSE`; there is no close or acknowledge action; appeals are out of scope | `DRAFT` may exist only as a local, unsent form (4.2). Finality is shown as **transaction or read finality**, separate from case status. No `CLOSED` state is shown |
| **G4** | A deliverable **deadline or milestone** field (spec Journey A.4) | No such field. `reply_deadline` is the response window, not a work deadline | 4.2 wizard: the milestone goes inside the expected-deliverable text, and the form says so |
| **G5** | **Templates** with criteria validated on chain (brief §4) | Only `category` is stored | Templates are UI helpers that prefill text and choose a category; they cannot bypass contract rules |
| **G6** | Counter-evidence **after** replying (spec Journey C.2) | `submit_reply` locks the record at once, so evidence must come **before** the reply. The claimant also cannot add evidence after the respondent replies | 4.4 must warn the respondent first: "Submitting your reply locks the record. Add any evidence first." Shown before the review |
| **G7** | Exact deadline status in the UI | The contract uses the transaction timestamp. The browser only has its own clock | Show the deadline in UTC and say "appears to have passed **by this device's clock**". The contract decides. A read cannot tell whether the deadline has been *processed* until someone calls `process_reply_deadline` |
| **G8** | Authenticity of files or links | The contract stores client-supplied references and hashes only | Display P4, P5 and P7 |
| **G9** | Case discovery for a wallet | ✔ Supported (`get_party_case_ids`). A browse-all view is technically possible, because IDs are sequential and `get_case_count` exists, but would read every case | Use "Your cases" (party index) plus open by ID plus labelled local recent IDs. **No browse-all view** (§10, D4) |

---

## 6. Architecture for Phase 4.0B: read-only case experience

### 6.1 Principles

1. **Read-only by construction.** The new views use only `ReadOnlyGateway` (four operations: `chainId`, `getContractCode`, `readContract`, `getTransaction`). The only gateway change is adding `get_party_case_ids` to `READ_METHODS`. No module in `src/write` (beyond the already allowed pure modules) and nothing in `src/experiment` is imported.
2. **Validate before rendering.** Every read passes `live/validate.ts`, and invalid data is never shown. `validateRead` gains `get_party_case_ids` (`{total: number, case_ids: string[]}`).
3. **Diagnostics stay separate.** `#/live` stays the fixture-comparison check of `VC-000001`. The new case views never compare with recorded fixtures and never use `testDeployments.ts` expectations as case data.
4. **The configured contract only.** Views read `CONTRACT_ADDRESS` (`VITE_VERICOURT_CONTRACT_ADDRESS`). For development this is set to the test contract when starting the dev server. The ordinary build without it shows "not configured" (no hard-coded default).
5. **No automatic polling.** Reads happen on page load and on an explicit Refresh. StudioNet allows about 500 requests per hour per IP (§6.7).

### 6.2 Routes

Hash routes stay static (`app/routes.ts`). The parser gains one parameterized route:

| Route | View | Notes |
|---|---|---|
| `#/app` | Dashboard | "Your cases", "Open a case by ID", "Recently viewed in this browser" |
| `#/case/VC-000001` | Case detail | Tabs or sections: overview, timeline, evidence, reply, assessment |
| `#/live`, `#/wallet`, `#/review`, `#/limitations`, `#/` | unchanged | `#/review` keeps its gated behavior |

**Case-ID validation:** `^VC-\d{6,}$`. The contract zero-pads to 6 digits; IDs above 999 999 would be longer.

### 6.3 Discovery (dashboard)

- **Your cases.** If the wallet state already holds an account from the **passive** read, call `get_party_case_ids(account, offset, 10)`, then `get_case_status` for each ID on the page. Show the role (claimant or respondent, derived from `get_case` on the detail page) and the status.
  - **Paging:** "Load more", 10 per page (the contract allows up to 50).
  - **No account:** a link to `#/wallet`. The dashboard never calls Connect.
- **Open a case by ID.** Validate the format, then go to `#/case/<id>`. The detail view checks existence with `get_case_count`.
- **Recently viewed in this browser.**
  - **Storage:** browser-local, at most 20 IDs, under a new key outside `src/write`. `pendingStore` keeps its exclusive access to the write-safety key.
  - **Label:** "Stored only in this browser. Not a complete or authoritative list."
  - **Reliability:** wrapped in try/catch; works without storage.
  - **Rule:** the list is **only** written when a case was successfully read and validated.

### 6.4 Case detail: reads per load

All reads use the configured contract. Requests are sequential, each with the existing 20 s timeout and **no retry**.

| Step | Read | Variant | Purpose |
|---|---|---|---|
| 0 | `eth_chainId`, `gen_getContractCode`, then SHA-256 | — | Once per session: confirm chain 61999 and that the deployed code equals the reviewed contract (`25bc9e0b…`). Otherwise show "unexpected contract" and nothing else |
| 1 | `get_case_count` | latest-nonfinal | existence: number ≤ count; otherwise "no such case" |
| 2 | `get_case` | latest-final | the record |
| 3 | `get_case` | latest-nonfinal | finality comparison only (§6.5) |
| 4 | `get_case_evidence` | latest-final | register |
| 5 | `get_case_history` | latest-final | timeline |
| 6 | `get_assessment_status` | latest-final | eligibility and attempts |
| 7 | `get_assessment` | latest-final | result, if `exists` |

That is **7 requests per case load** (plus 2 once per session). Dashboard: 1 + up to 10 per page.

### 6.5 Finality display

The record shown is the **latest-final** read.

**Compare with latest-nonfinal `get_case`:**
- **Equal:** the record is shown as "Final (confirmed by a latest-final read)". Every write appends history, so `history_count`, status, evidence count and attempts all change on any write.
- **Different:** the record is shown as final, plus a banner: "Newer changes are not final yet". The banner names what differs (`diffPaths`) and the non-final status label. Non-final content is never shown as the record.
- **Missing at latest-final:** a case that exists only at latest-nonfinal is shown as "Created; not final yet", with the non-final fields marked as not final.

**DECIDED** remains "Assessment recorded". The assessment is labelled final only when the final-read rule holds (existing `finalityFromReads`, applied to whole-record equality).

### 6.6 States the views must render

| State | Condition | Display |
|---|---|---|
| Not configured | `CONTRACT_ADDRESS` unset or invalid | Existing contract-configuration message; no reads |
| Loading | reads in flight | `role="status"` with step progress; no partial case data |
| Empty | "Your cases" total 0; no recent IDs | Empty state with "Open a case by ID" |
| Invalid ID | the format fails | Field error; no request sent |
| Not found | number > `get_case_count` | "No case `VC-…` on this contract" |
| Network unavailable | timeout, network/CORS, RPC error, unparseable response, **including the HTML rate-limit page** | Category plus message; "Nothing was changed; reads are safe to repeat"; manual Refresh |
| Unexpected contract | chain ≠ 61999, code hash differs, or `schema_version` ≠ `vericourt-case-v1` | Stop and show the reason. No case data |
| Malformed data | any read fails validation | That section shows "data not shown" (as `CaseSnapshot` does) and lists the validation problems |
| **Inconsistent data** | any cross-read contradiction: `evidence_count` ≠ evidence list length; `history_count` ≠ history length; `assessment.exists` with status ≠ DECIDED (or the reverse); assessment `case_id` or `snapshot_digest` ≠ the case's; a cited ID not in the register; an unknown enum value; `locked_evidence_count` ≠ evidence length after the lock | Warning panel naming the contradiction. The affected section is not rendered as authoritative. Unknown enums use the existing "Unrecognised …" labels |
| Not final | §6.5 | Banner |
| Deadline passed but not processed | `AWAITING_RESPONSE` / `PENDING`, and device time > `reply_deadline` | "The reply window appears to have closed (by this device's clock). Either party can now ask the contract to record that no reply was received; this action is not available in this build." Never "no response" until the contract says so. **Live example:** `VC-000002` and `VC-000003` |
| Locked / ready | READY_FOR_ASSESSMENT | Lock reason, time and snapshot digest; "an assessment can be requested by either party (not available in this build)"; attempts remaining |
| Assessment failed | ASSESSMENT_FAILED | Existing neutral label: "…says nothing about the merits of the claim" |
| Decided | DECIDED plus a valid assessment | The full Phase 2.18B display (§6.7) |

### 6.7 Display safeguards (reuse, no new wording for outcomes)

- **Outcome and determinations:** `display/labels.ts` (no verdict, winner or loser). `outcomeNeedsIssueDetail` means per-issue determinations are always shown with a partial or inconclusive outcome.
- **Citations:** `display/citations.ts`. UNRESOLVED is shown as "Evidence the assessment considered — no direction established"; uncompared lists are labelled; unknown IDs show "Not found in the locked record".
- **Claimant-only caution:** `display/caution.ts`, exact text.
- **Provenance:**
  - decision block versus advisory block, through `display/provenance.ts`;
  - "a majority of the validators that voted";
  - the contract's `display_notice` comes first.
- **Remedy:** `display/remedy.ts` (advisory; "does not pay, refund, hold or enforce anything").
- **Notices:** stored notices verbatim, through `checkStoredNotices`, plus `STANDARD_NOTICES`.
- **Rendering:** all text is rendered as React text (lint bans `dangerouslySetInnerHTML`).
- **External links:**
  - turned into anchors only when `new URL()` parses them with protocol `http:` or `https:`;
  - `target="_blank" rel="noopener noreferrer nofollow"`, a visible "external link" marker, and the full URL as text;
  - P4 next to them.
  - Anything else is shown as plain text.
- **Refactor:** the assessment blocks are moved out of `CaseSnapshot` into a shared component, so `#/live` and `#/case/…` render through **the same** code. The existing `CaseSnapshot` tests must still pass unchanged.

### 6.8 Files planned for 4.0B

| File | Change |
|---|---|
| `src/app/routes.ts` | `#/case/<id>` route plus an ID parser |
| `src/App.tsx` | case route |
| `src/live/gateway.ts`, `src/live/validate.ts` | `get_party_case_ids` read and its validator |
| `src/cases/caseReads.ts` (new) | read orchestration with a contract check, the sequence in §6.4, timeouts, and a typed result with the states in §6.6. No React |
| `src/cases/consistency.ts` (new) | pure cross-read checks (§6.6 inconsistent data) |
| `src/cases/recentCases.ts` (new) | labelled browser-local recent IDs (try/catch; bounded) |
| `src/display/deadline.ts` (new) | deadline and lock wording (pure; forbidden-term scanned) |
| `src/contract/copy.ts` (new) | exact brief §10 / spec §13 sentences (P1, P4, P7, P11), with a test that reads them from the brief and spec files so they cannot drift |
| `src/components/AssessmentView.tsx` (new, extracted) | shared assessment rendering (§6.7) |
| `src/components/EvidenceRegister.tsx`, `CaseTimeline.tsx`, `CaseHeader.tsx` (new) | register, timeline and header |
| `src/components/CaseSnapshot.tsx` | uses `AssessmentView`; behavior unchanged |
| `src/pages/Dashboard.tsx` | real discovery (§6.3) |
| `src/pages/CaseDetail.tsx` (new) | case detail |
| Tests | see §6.9 |
| `frontend/README.md`, `docs/PHASE_4_0B_…` | documentation |

**Not touched:**
- `src/write/**`, `src/experiment/**`;
- `config/writeGate.ts`, `config/network.ts` (`CONTRACT_WRITES_ENABLED` stays `false`), `config/testDeployments.ts`;
- `contracts/`, `tests/`, `package.json`, the lockfile.

### 6.9 Tests for 4.0B / 4.0C

- **Route parser:** valid, invalid and edge IDs.
- **`caseReads`** with the existing `test/fakeGateway.ts`:
  - every §6.6 state;
  - request count and order;
  - no retry;
  - timeout categorization;
  - **no wallet method is called**;
  - the contract check gates all case reads.
- **`consistency`:** each contradiction, one at a time.
- **Views:** render the recorded `VC-000001` (decided, no reply) and fixtures for awaiting, deadline passed, ready, failed and not final:
  - UNRESOLVED wording;
  - claimant-only caution;
  - provenance blocks;
  - no forbidden terms in the rendered page text, outside the allow-listed mandatory sentences.
- **Links:** `javascript:` and malformed URLs are rendered as text; https links get `rel` and the marker.
- **Recent cases:** storage throwing; bound of 20; written only after a valid read.
- **Isolation:** the existing tests, plus a new assertion that `src/cases`, `CaseDetail` and `Dashboard` import nothing from `src/write` or `src/experiment`.
- **4.0C gates:** typecheck, lint, the full `vitest run`, `npm run build`, the 7-string canary scan on `dist/`, the contract SHA-256, and Python tests only if a contract-adjacent file changes (none is planned).
- **One live read-only pass:** with your approval, run the dev server against the test contract and open `VC-000001…3` through the app's own gateway (about 30 requests).

---

## 7. Read-only versus wallet-write actions

| Action | Kind | Contract call | Wallet prompt? | Milestone |
|---|---|---|---|---|
| List my cases | read | `get_party_case_ids`, `get_case_status` | No (passive account only) | 4.0B |
| Open a case by ID | read | `get_case_count`, case views | No | 4.0B |
| View detail, timeline, evidence, reply, deadline | read | case views | No | 4.0B |
| View assessment status and result | read | `get_assessment_status`, `get_assessment` | No | 4.0B |
| Compute a file's SHA-256 locally | local | — | No (`crypto.subtle`, no upload) | 4.3 |
| Export or print a report | local | uses data already read | No | 4.6 |
| Connect wallet | wallet (accounts) | — | Yes, explicit user action (existing) | — |
| Create case | **write** | `create_case` | Yes | 4.2 |
| Submit evidence | **write** | `submit_evidence` | Yes | 4.3 |
| Submit reply | **write** | `submit_reply` | Yes | 4.4 |
| Record that the deadline passed | **write** | `process_reply_deadline` | Yes | 4.4 |
| Request assessment | **write** | `request_assessment` | Yes | 4.5 |

---

## 8. Write path requirements for later milestones (not part of 4.0B)

### 8.1 Gate and build isolation

Every write stays in `src/experiment` behind the same build-time fold and the same five runtime conditions:
1. mode;
2. exact phrase;
3. allow-listed contract;
4. localhost host;
5. `CONTRACT_WRITES_ENABLED === false`.

The ordinary build stays write-free: the canary scan runs after every milestone.

### 8.2 Requirements for each method

Each method must get the same treatment `create_case` has today:

| Requirement | Generalization needed |
|---|---|
| Review screen that encodes exactly what is shown | one input module per method (like `write/createCase.ts`), feeding both the screen and the arguments |
| Preflight under the lock | shared checks (chain, sender, code hash, gas price 0, `nonce latest == pending`) plus a `gen_call` simulation of **that** method from **that** sender, plus per-method state checks (role, status, deadline, quota, attempts) |
| Guard | Already method-generic: `WriteIntent.method` and byte-exact arguments. No change to the checks |
| Durable record and lock | Already generic; the single-key store means **one unresolved write per browser profile at a time**, across all methods. Keep it |
| Monitoring and verification | Success needs finality **plus** a latest-final read showing the **method's** effect |
| Effect check for reconciliation | Today only for `create_case`. Needed per method (below) |

**Effect checks** (all read-only, against a baseline taken in the preflight):

| Method | Effect check |
|---|---|
| `submit_evidence` | after the baseline `evidence_count`, exactly one new item from the sender with the same label, description, `content_ref` and SHA-256. More than one is ambiguous, never success |
| `submit_reply` | `response_state` SUBMITTED and `reply` equal to the intent |
| `process_reply_deadline` | `response_state` NO_RESPONSE_BY_DEADLINE and a `REPLY_WINDOW_EXPIRED` entry |
| `request_assessment` | `assessment_attempts` above the baseline. Then DECIDED with an assessment, or an `ASSESSMENT_ATTEMPT_FAILED` entry for that attempt number |

### 8.3 Risks particular to each method

| Method | Risk | Mitigation |
|---|---|---|
| `request_assessment` | **A duplicate or blind retry after a failed first attempt uses up the last attempt** and makes the case ASSESSMENT_FAILED for good. Long consensus (an LLM call); UNDETERMINED is possible and changes nothing | Strict uncertain-state lock (existing). Show remaining attempts. Never retry automatically. A separate acknowledgement when only 1 attempt remains. A longer finality window (to be measured; Phase 2.14–2.17C runs give the reference) |
| `submit_reply` | Locks the record. Evidence after it is impossible (G6) | A warning and an evidence checklist before the review |
| `submit_evidence` | Not idempotent; uses up the per-party quota of 10 | One-request guard; effect check; show remaining quota |
| `process_reply_deadline` | Rejected if run before the chain timestamp passes the deadline (device clock skew) | Preflight simulation catches it; the wording says "by this device's clock" |
| All | The wallet may change the gas limit (seen: 500k → 750k, R2) | Keep the prompt checklist |

---

## 9. Proposed milestone sequence

**Order:** smallest safe steps, reads before writes. Each milestone ends with tests, a report and a stop.

| Milestone | Content | Sends transactions? | Needs |
|---|---|---|---|
| **4.0B** | Read-only case experience (§6) | No | approval of this plan |
| **4.0C** | Review and tests: the full gates; one live read-only pass through the app (about 30 requests) | No | approval for the live read pass |
| **4.1** | Generalize the experiment write stack per method: input modules, per-method preflight and effect checks, mutation suites. Still gated, localhost only. Offline tests only | No | decision D1 |
| **4.2** | Create-case wizard (spec §10.3 steps 1–5), P1 on review, templates as helpers, local draft | Only in a later, separately approved live test | 4.1 |
| **4.3** | Evidence form: LINK, TEXT, FILE_DIGEST with local SHA-256; P1, P3, P4, P7 | Same | 4.1 |
| **4.4** | Reply form (with the G6 warning) and the deadline action | Same | 4.1 |
| **4.5** | Assessment request with the §8.3 safeguards | Same | 4.1 |
| **4.6** | Browser-generated report: print view and download, with the P11 label | No | — |
| **Phase 5** | Hardening: mobile and keyboard walk-through (still NOT VERIFIED from 3.7), accessibility, copy review | — | — |

**Suggested live testing:** one approved, fictional live write per method, in the order 4.3 → 4.4 → 4.5, on the test contract, using cases that you create. Each would get a review document like Phase 3.6, with the exact transaction approved first.

---

## 10. Decisions needed from you

| # | Decision | Recommendation | Blocks |
|---|---|---|---|
| D1 | Write scope: generalize the gated experiment to all five methods, or gate each method separately | One generalized experiment, still behind all five conditions and localhost-only, with **one method per explicitly approved live test** | 4.1 |
| D2 | Application deployment (Phase 3.7 R6) | Not needed until release. Develop against the verified test contract | release |
| D3 | Does the ordinary build read a contract only when `VITE_VERICOURT_CONTRACT_ADDRESS` is set? | Yes: no hard-coded default. Dev runs set it to `0x3258…6220` | 4.0B |
| D4 | Browse all cases (G9) | No. Only "Your cases", open by ID and local recent IDs | 4.0B |
| D5 | Supplementary evidence-redaction sentence (P3) | Approve or replace the proposed wording before 4.3. 4.0B does not need it | 4.3 |
| D6 | Live read-only pass in 4.0C (about 30 RPC requests) | Approve, to show "uses actual contract data" | 4.0C |

---

## 11. Risks for this phase

| # | Risk | Mitigation |
|---|---|---|
| A1 | StudioNet rate limit (500 requests per hour per IP) during development and testing | No polling; about 7 requests per case load; tests use fakes; only one planned live pass |
| A2 | Showing non-final data as fact | Final read is primary; non-final changes are only a banner (§6.5) |
| A3 | Refactoring `CaseSnapshot` disturbs the verified display rules | Extraction only; existing tests unchanged and must pass; a forbidden-term scan of the rendered pages |
| A4 | Device-clock deadline wording misleads | "By this device's clock"; never claims no-response until the contract records it |
| A5 | Local recent IDs taken as authoritative | Explicit label; written only after a validated read |
| A6 | A new view accidentally pulls in a write module | Existing isolation test plus a new import assertion plus the `dist/` canary scan |

---

## 12. Stop

Phase 4.0A is complete. **No source code was modified.**

The next step is Phase 4.0B as described in §6. It starts only after you approve, ideally with answers to D3, D4 and D6. D1, D2 and D5 can wait until their milestones.
