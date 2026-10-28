# VeriCourt — Complete Coding-Agent Build Brief

**Purpose:** This is the implementation brief for Claude Code or another coding agent.  
**Project:** VeriCourt — AI-assisted digital-work dispute resolution using GenLayer.  
**Required architecture:** Frontend + Python Intelligent Contract only.  
**Network target:** StudioNet, chain ID `61999`, user-provided endpoint context `https://studio.genlayer.com/api`.  
**Frontend SDK context:** GenLayerJS `1.1.8`, injected wallet.  
**Primary rule:** Verify every GenLayer-specific API against current official documentation before coding. Never invent methods, storage types, network configuration, or transaction lifecycle semantics.

---

## 0. Mission

Implement the smallest complete, testable MVP of VeriCourt. The dApp lets a client and freelancer describe a digital-work disagreement, submit statements and bounded evidence metadata, give both sides a right of reply, request an AI-assisted assessment through a Python Intelligent Contract, and inspect an auditable on-chain case history and outcome.

The product must not pretend that an AI assessment is a court judgment, legal advice, or objective truth. It must show protocol/transaction status honestly and must never mark an outcome final merely because a write was submitted.

**Do not build everything at once. Work phase by phase. Begin with Phase 0 audit only.**

---

## 1. Hard constraints

### Architecture
- Frontend and Python Intelligent Contract only.
- No custom backend.
- No Fly.io.
- No Supabase.
- No Firebase.
- No separate database.
- No server-side API routes, serverless functions, workers, or custom indexer.
- No server-held wallet/private keys.
- Do not add a third-party file upload service for the MVP.
- Do not add a Python backend merely because `genlayer-py` exists; it is for scripts/backend integration only when explicitly needed and authorized. This project does not authorize a backend.

### Network and wallet
The project owner supplied this target context:
- StudioNet.
- Chain ID `61999`.
- `https://studio.genlayer.com/api`.
- GenLayerJS version context `1.1.8`.
- Injected wallet through GenLayerJS.

Before implementation, verify the current official instructions and the correct meaning/placement of each configuration value. Do not assume the URL is interchangeable among RPC, REST API, SDK base URL, or Studio endpoint. Prefer documented built-in network configuration and `genlayer network set` for built-in networks rather than manually overriding RPC configuration. A 0 GEN balance is expected on gasless StudioNet according to the supplied context, but verify current instructions.

### Protocol understanding
- GenLayer is a blockchain/protocol for trustless adjudication, not merely a label for AI contracts.
- Intelligent Contracts are Python contracts extending `gl.Contract`, executed in GenVM.
- The contract may use LLMs, live web/API information, and unstructured inputs according to documented runtime capabilities.
- GenLayer's Optimistic Democracy consensus includes a leader-proposed result, independent validator evaluation, and an appeal/finality process. Represent only states and events that are actually exposed by the current protocol/API.
- GenLayer Chain and GenVM have distinct responsibilities. Do not assume ordinary deterministic EVM semantics for non-deterministic contract operations.
- Every LLM, external web, image, or fuzzy judgment path needs explicit validation and an appropriate equivalence strategy.

### Implementation quality
- Do not leave GenLayer-specific methods guessed.
- Do not claim a test, lint, deployment, or integration succeeded unless it actually ran successfully.
- If an environment/tool/network/account/API is unavailable, report exactly what is blocked and the next command/manual step.
- Keep changes minimal and explain important design decisions.

---

## 2. Official GenLayer context and setup

Use official sources first:
- Skills site: https://skills.genlayer.com/
- Full docs fallback: https://docs.genlayer.com/full-documentation.txt
- SDK reference fallback: https://sdk.genlayer.com/main/_static/ai/api.txt
- GenLayer Gym: https://gym.genlayer.foundation
- Intelligent Oracle: https://intelligentoracle.com
- Project boilerplate: https://github.com/genlayerlabs/genlayer-project-boilerplate

For Claude Code, if plugin commands are available and the user environment authorizes setup:
```text
/plugin marketplace add genlayerlabs/skills
/plugin install genlayer-dev@genlayerlabs
```

Optional MCP context when supported:
```bash
claude mcp add genlayer-docs --transport sse https://docs-mcp.genlayer.com/sse
claude mcp add genlayer npx -- -y genlayer-mcp
```

Do not install or run `genlayernode` for ordinary app/contract development; it is for validator-node operations.

### Required skills
Read the currently installed/current instructions before using each relevant workflow:
- `write-contract` — before and during Intelligent Contract implementation.
- `genvm-lint` — after every contract change.
- `direct-tests` — fast in-memory contract tests.
- `integration-tests` — consensus and network behavior.
- `genlayer-cli` — networks, accounts, deployment, calls, writes, schemas, receipts, traces, and debugging.

Install tools only as needed and according to current official instructions:
```bash
npm install -g genlayer
pip install genvm-linter
pip install genlayer-test
# Only if GLSim is needed and supported:
pip install 'genlayer-test[sim]'
npm install genlayer-js@1.1.8
```

Do not blindly install or upgrade packages before checking the existing repo's package manager, lockfile, and current versions. Pin dependencies in the project according to its existing conventions and verified compatibility.

---

## 3. Phase 0 — audit only (mandatory first phase)

**Do not write or modify application code during Phase 0.**

### Inspect
- Current directory and repository status.
- Existing app framework, source tree, package manager, lockfiles, tests, build scripts, and environment configuration.
- Existing contract files and Python dependencies.
- Existing wallet/client/network code.
- Existing design system/components.
- Current deployment configuration and any contract address/schema.
- Whether the repo is empty, partial, or an existing implementation.

### Read official guidance
- Read the `write-contract` skill and the relevant test/lint/CLI skill instructions.
- Verify current GenLayerJS 1.1.8 APIs for client creation, chain configuration, injected wallet, reads, writes, transaction status, receipts, and events.
- Verify the correct StudioNet config and current deployment/call instructions.
- Verify contract schema retrieval and the current CLI commands.
- Verify supported storage types, caller/address APIs, LLM interface, custom equivalence interface, and pinned GenVM Depends header syntax.
- Use docs MCP if available. Otherwise use the official docs and SDK reference above.
- If documentation cannot be reached, say so and stop before guessing.

### Phase 0 output
Return:
1. A concise inventory of the repo and existing behavior.
2. The current dependency and toolchain versions.
3. The exact official APIs/configuration verified, with links or file references.
4. Any missing environment requirements.
5. A minimal phased plan that respects the constraints.
6. Any product decisions that genuinely block implementation.

Do not ask the user to repeat facts already in this brief. Do not ask broad questions if a safe default is clear.

---

## 4. Product definition

### Product
VeriCourt helps a client and freelancer organize a dispute about digital work. Both parties can present their account and evidence. An Intelligent Contract assesses the structured record and returns a reasoned, bounded outcome. The case history and relevant outcome are recorded through the contract.

**Tagline:** “Evidence in. A reasoned outcome out.”

### Core MVP flows
1. Connect injected wallet and verify network.
2. Create case.
3. Add initial statement and evidence.
4. Responding party submits a reply and counter-evidence.
5. Case becomes eligible for assessment according to contract rules.
6. Authorized participant requests assessment.
7. Display pending/consensus/finality state only as supported by actual API information.
8. Display structured assessment and limitations.
9. Inspect case timeline and transaction references.
10. Export a browser-generated case report.

### Initial case templates
- Software development.
- Design/branding.
- Writing/content.
- Other digital deliverable.

Templates are UI helpers only unless a template identifier/criteria is intentionally stored and validated by the contract. Never allow a frontend template to bypass contract rules.

### Out of scope
- Escrow or payment custody.
- Automated transfer/payment enforcement.
- Legal advice or claims of enforceability.
- Custom backend, Supabase, Firebase, Fly.io, separate database, indexer, worker, or serverless API.
- Upload service for files.
- Unbounded file content or unbounded LLM prompts.
- Unlimited assessment retries.
- Unverified protocol appeals represented as an application appeal feature.

---

## 5. Data model and case lifecycle

Design the model only after checking current GenLayer storage requirements. The following is conceptual; do not copy it into contract code without adapting it to documented storage types.

### Case fields
- Unique case identifier.
- Creator/initiating party address.
- Responding party address, if supplied/required by the chosen flow.
- Case title/category.
- Agreement/scope summary.
- Expected deliverable and relevant milestone/deadline.
- Initiating party's claim.
- Requested remedy.
- Response text and response state.
- Evidence metadata and IDs.
- Current business state.
- Created/updated timestamps only if supported and meaningful in the runtime.
- Assessment snapshot/version.
- Structured assessment output.
- Retry count or equivalent bounded retry state if retries are supported.
- Methodology/schema version.

Use the documented storage types (`TreeMap`, `DynArray`, dataclasses with `allow_storage`, sized integers where applicable) as appropriate. Do not persist raw Python `dict` or `list` structures unless the official docs explicitly support them.

### Evidence record
Conceptual fields:
- Evidence ID.
- Submitter address.
- Evidence type.
- Label/title.
- Bounded description.
- Source URL or bounded text reference.
- Optional client-computed file hash.
- Submission timestamp if supported.

Do not store large file bytes on-chain. A hash is an integrity check, not proof of truth or provenance. Do not add external storage in the MVP.

### State model
Suggested conceptual states:
- `OPEN`
- `AWAITING_RESPONSE`
- `READY_FOR_ASSESSMENT`
- `ASSESSMENT_PENDING`
- `APPEAL_OR_FINALITY_PENDING` only if supported by the actual exposed protocol/API state
- `DECIDED`
- `CLOSED` only if closing is part of the chosen workflow

The frontend-only `DRAFT` state may exist locally before on-chain creation. Do not mix transaction state with case state.

### State transition invariants
- Only the permitted participant can submit their statement/evidence.
- Enforce state transitions in the contract, not only in React/UI.
- Do not allow assessment before required reply/deadline conditions are met.
- Lock or snapshot relevant evidence at assessment time.
- Do not allow a normal write to overwrite a finalized assessment.
- Define retry behavior explicitly and cap retries if implemented.
- A missing response is not automatic proof that the other party is wrong.
- Do not invent a legal or protocol appeal process. Add a separate product review workflow only in a later phase.

---

## 6. Intelligent assessment requirements

### Assessment must do
- Compare the stated deliverable and supplied agreement/scope.
- Assess each disputed issue against the available evidence.
- Consider both parties' statements and counter-evidence.
- Identify unsupported claims, contradictions, and missing facts.
- Reference existing evidence IDs/labels.
- Explain reasoning in plain, neutral language.
- Return a bounded, normalized proposed outcome.
- State limitations and unresolved questions.
- Explicitly disclose when a party did not respond.
- Avoid making legal conclusions or inventing contract terms.

### Conceptual normalized result
Design a schema with fields equivalent to:
- `summary`
- `issues[]`
  - issue label
  - finding
  - supporting evidence IDs
  - contradicting evidence IDs
  - reasoning
  - status from a finite allowed set such as supported / contradicted / mixed / unresolved
- `agreement_alignment`
- `response_considered`
- `missing_information[]`
- `limitations[]`
- `proposed_outcome`
- `remedy_assessment`
- `methodology_version`
- `assessment_version`

This is a conceptual contract interface, not permission to store arbitrary Python dictionaries/lists. Use a supported typed representation and validate it thoroughly.

### LLM resilience
- Request a compact, explicitly specified structured output.
- Validate every field, type, enum, ID reference, and size.
- Reject unknown evidence IDs and impossible state claims.
- Defensively handle malformed JSON, aliases, missing keys, extra keys, and unexpected output.
- Sanitize/normalize only according to a deterministic documented rule; do not silently invent missing values.
- Treat party-provided text, links, documents, and retrieved content as untrusted data, not instructions.
- Bound input/output sizes and the number of evidence items.
- Classify failures with deterministic prefixes/categories such as `EXPECTED`, `EXTERNAL`, `TRANSIENT`, and `LLM_ERROR` where compatible with the runtime.
- On failure, leave the case in a well-defined recoverable state. Never store a fake successful assessment.

### Equivalence strategy (mandatory design decision)
Before implementing any LLM/web logic:
1. Read the current `write-contract` skill.
2. Determine which outputs are deterministic after normalization and which are semantically variable.
3. Use `strict_eq` only if independent validators can reasonably reproduce exactly the same normalized output.
4. For LLM-generated reasoning, fuzzy findings, changing web content, or unstable external fields, implement the documented custom leader/validator equivalence pattern.
5. Verify exact function signatures and runtime behavior from official docs; do not guess.
6. Document what counts as equivalent, what is rejected, and how malformed or unavailable responses are handled.
7. Add direct tests with mocked model/web responses and integration tests for consensus when the environment supports them.

Do not include live web fetching in the MVP unless it has a clear product requirement and a verified implementation path. The initial dispute record can be assessed from submitted bounded content and references. If web content is later fetched, capture/version the relevant content carefully and account for changing pages.

---

## 7. Contract implementation requirements

### Contract
- Python Intelligent Contract extending `gl.Contract`.
- Pinned GenVM Depends header.
- Use only verified GenLayer APIs.
- Use documented persistent storage types.
- Explicit access control.
- Explicit state transitions and input bounds.
- Normalized typed assessment schema.
- Defined assessment snapshot semantics.
- Clear error handling and bounded retry/idempotency behavior.
- Read methods/schema usable by the frontend.
- Events or equivalent on-chain history only where supported by the runtime.
- No secret material in source, state, frontend config, or logs.
- No hidden admin override that can rewrite a decided case.

### Contract test coverage
Direct tests must cover:
- Creating a case with valid inputs.
- Rejecting empty/oversized fields.
- Access-control enforcement.
- Unauthorized evidence/statement submissions.
- Correct case-state transitions.
- Rejecting assessment before reply conditions are met.
- Correct behavior when no response is received.
- Evidence count and size limits.
- Unknown evidence ID references in assessment.
- Malformed or incomplete assessment output.
- LLM/external error paths.
- Assessment snapshot lock.
- Duplicate assessment requests and retries.
- Preventing normal writes from overwriting a decided result.
- Custom equivalence/normalization behavior where testable.

Mock LLM/web calls in direct tests. Integration tests are required when real consensus/runtime/network behavior matters and the environment is available.

---

## 8. Frontend implementation requirements

### Verify SDK first
Use the installed GenLayerJS documentation for the exact version before wiring UI. Verify:
- Client creation.
- Built-in chain configuration.
- Injected wallet support.
- Read/view contract calls.
- Write/transaction calls.
- Transaction status, receipt, and event handling.
- Error types and network-switch behavior.
- Contract schema compatibility.

Do not invent or assume method names. Do not mix APIs from different SDK versions. Keep all contract addresses, chain configuration, schema-related types, and methodology version in typed centralized config.

### UI areas
- Landing / How it works.
- Wallet/network connection.
- Dashboard or honest limited discovery fallback.
- Create-case wizard.
- Case detail and timeline.
- Evidence register.
- Right-of-reply panel.
- Assessment request/transaction status.
- Assessment result.
- Protocol diagnostics.
- Browser-generated report preview/export.
- Privacy and limitation notices.

### Case discovery without backend
First inspect schema, read methods, and events. Do not introduce an indexer/backend. If safe enumeration of cases is not available, use:
- browser-local recent case IDs, explicitly labeled as local history;
- a manual “open case by ID” input;
- contract reads for each known case ID.
Do not imply local browser history is complete or authoritative.

### Transaction UX
- Distinguish read/view operations from writes.
- Show wallet confirmation/rejection.
- Show submitted, pending, finalized, and failed states where actually supported.
- Keep transaction status distinct from business case state.
- Never show success before the host/SDK reports success.
- Display receipt/transaction ID when available.
- On failure, explain whether submission may have occurred and the safe next step.
- Avoid retrying a write blindly if the previous transaction might still be pending.

### Frontend security and privacy
- No private keys or server-side signing.
- Do not render untrusted content as HTML.
- Validate input client-side for usability and again in the contract for security.
- Show a warning before on-chain submission.
- Never promise confidentiality for public-chain data.
- Hash user-selected files locally in the browser only if the implementation and dependency are verified; do not upload them.
- External links should be clearly marked and safely opened.

### Report export
Generate from data already available to the frontend. Include case ID, party addresses, case timeline, agreement summary, evidence metadata/references, assessment, limitations, and transaction IDs/status. Label it “VeriCourt case report — not a court judgment or legal opinion.” Do not add a PDF service or backend.

---

## 9. Design system: FORENSIC POP

Build a distinctive editorial evidence-lab aesthetic. Do not use generic Web3 gradients, glassmorphism, courthouse stock photos, gavels, scales, or glowing neon cards.

### Palette
- Paper: `#F4F0E7`
- White Paper: `#FFFEFA`
- Ink: `#171717`
- Acid Lime: `#D7FF3F`
- Verdict Coral: `#FF5B4D`
- Ultraviolet: `#6D35FF`
- Pool Blue: `#46D9FF`
- Soft Lavender: `#C9BEFF`
- Muted Ink: `#77766F`
- Rule Grey: `#D5D0C6`
- Deep Aubergine: `#21172F`

### Typography
- Display: Space Grotesk or verified fallback.
- Body: Inter or system sans.
- IDs/timestamps: IBM Plex Mono or system monospace.

### Visual rules
- Warm paper canvas, near-black type, crisp rules, squared/low-radius shapes.
- Large editorial headlines and oversized case numbers.
- Angular inward-facing evidence brackets as the brand mark.
- Lime for primary action; coral for warnings/contested state; ultraviolet for assessment/protocol; pool blue for evidence metadata/links.
- Do not use every accent in one viewport. Color is paired with text/icons.
- Minimal shadows; no glassmorphism.
- Asymmetrical editorial layouts on desktop; clean single-column mobile.
- Respect reduced motion and keyboard focus.
- Meet WCAG AA contrast where applicable.
- Ensure long IDs, wallet addresses, and evidence labels wrap without breaking layout.

---

## 10. Privacy and legal limitation copy

Use this copy before case creation and evidence submission:

> **Before you submit:** Information written to a public blockchain may be visible and permanent. Do not submit passwords, private keys, confidential information, or personal data you do not have permission to share. VeriCourt provides an AI-assisted assessment, not legal advice or a guarantee of a legally binding result.

Other required language:
- A file hash helps verify file integrity; it does not prove authenticity or truth.
- External links can change or become unavailable.
- Protocol consensus is not a guarantee of objective truth.
- Silence/non-response is not automatic proof against the non-responding party.
- An outcome is marked final only when supported by verified network status.

---

## 11. Testing, lint, and deployment workflow

Run quality gates in order and follow the current skill instructions.

### Contract lint after every contract edit
```bash
genvm-lint check contracts/<file>.py --json
```

Fix all errors before proceeding. Do not ignore warnings without documenting why they are safe.

### Direct tests
```bash
pytest tests/direct/ -v
```

### Integration tests
```bash
gltest tests/integration/ -v -s
```

Use integration tests when consensus, real web/LLM calls, Studio, GLSim, StudioNet, Bradbury, or other network behavior matters. Verify exact tool commands from the current installed skill before use.

### CLI/debug loop
Use current documented commands for:
- network selection;
- account inspection;
- deploy;
- schema;
- read calls;
- writes;
- receipts;
- traces/debugging.

For a failed transaction, follow the supplied debugging guidance and verify syntax first:
```bash
genlayer receipt <txHash> --stdout --stderr
genlayer schema <address>
genlayer code <address>
```

Do not manually override built-in RPC settings if `genlayer network set` is the documented path. StudioNet is gasless per supplied context; 0 GEN is expected. Bradbury/Asimov require funded accounts; if using them, faucet claiming is browser-based and cannot be fully automated.

### Frontend checks
Use the repo's actual scripts and package manager. Run available lint, type-check, unit tests, and production build. Do not invent script names. Check:
- wallet unavailable/rejected;
- wrong network;
- read/write errors;
- pending/finalized/failed transaction states;
- malformed assessment;
- no response;
- empty states;
- mobile widths and keyboard navigation;
- report export with missing optional fields.

---

## 12. Required implementation phases

### Phase 0 — Audit only
Inspect the repo and current official GenLayer docs/skills. Do not modify code. Return repo inventory, verified API/config details, blockers, and a minimal plan.

### Phase 1 — Contract foundation
Implement only case model, supported storage, access control, input bounds, evidence/response actions, and lifecycle. Add direct tests. Run lint after every contract change.

### Phase 2 — Assessment contract path
Choose equivalence strategy first. Implement normalized assessment output, defensive validation, bounded inputs, error handling, and retry/idempotency rules. Add mocked direct tests and integration tests where possible.

### Phase 3 — Frontend foundation
Set up verified GenLayerJS 1.1.8 client/network/wallet integration. Inspect contract schema and create typed config. Implement wallet/network diagnostics and base Forensic Pop tokens.

### Phase 4 — Core UI flows
Implement case creation, case detail, evidence, right of reply, assessment request/result, transaction lifecycle, timeline, and report export. Wire every write to the real contract; no fake data presented as on-chain truth.

### Phase 5 — Hardening
Run all tests and frontend checks. Review access control, storage limits, error paths, privacy copy, accessibility, responsive behavior, and schema alignment. Document anything blocked and exact manual steps.

Do not jump phases. At each phase, report files changed, commands run, test results, known limitations, and the next step. Ask for approval before moving to a materially new phase if the user's workflow expects phase-by-phase approval.

---

## 13. Required final handoff

At completion, provide:
1. What was implemented.
2. Architecture summary and confirmation that no backend/database was added.
3. Contract address and verified network details if deployed.
4. Contract schema and the frontend methods wired to it.
5. Files changed.
6. Exact lint/test/build commands and their actual outcomes.
7. Any integration tests not run and the precise reason.
8. Known limitations, especially discovery/indexing, privacy, external links, and legal status.
9. Manual steps the user must perform.
10. Next recommended phase.

Never claim a deployment, test, or consensus finality succeeded without evidence.

---

## 14. Phase 0 response template

The first response after receiving this brief should use this structure:

### Repository audit
- Framework and source layout:
- Package manager and SDK versions:
- Existing contract/tests:
- Existing wallet/network integration:
- Existing design system:
- Deployment/schema status:

### Documentation verified
- GenLayer skill versions/instructions:
- GenLayerJS 1.1.8 client and wallet APIs:
- StudioNet configuration:
- Storage and contract APIs:
- Equivalence strategy guidance:
- CLI/test commands:

### Blockers
- Exact missing tools, access, accounts, or documentation:
- Next command or manual action:

### Proposed phases
- Phase 1:
- Phase 2:
- Phase 3:
- Phase 4:
- Phase 5:

**Stop after the audit. Do not write application code in the first pass.**
