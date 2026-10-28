# VeriCourt — Product, Protocol & Design Specification

**Document type:** Product requirements, protocol architecture, UX, and visual design specification  
**Project:** VeriCourt  
**Tagline:** *Evidence in. A reasoned outcome out.*  
**Target network:** GenLayer StudioNet  
**Frontend integration context:** GenLayerJS 1.1.8, injected wallet  
**Contract runtime:** Python Intelligent Contract on GenVM  
**Architecture boundary:** Frontend + Intelligent Contract only. No custom backend.

---

## 1. Executive summary

VeriCourt is a GenLayer-powered dispute-resolution dApp for disagreements about digital work. It helps a client and freelancer organize an agreement, submit statements and evidence, give both parties a fair opportunity to respond, request an AI-assisted assessment, and preserve the case lifecycle and outcome in an auditable on-chain record.

The central product idea is not “AI replaces a court.” VeriCourt is a structured, transparent process for examining a narrowly defined dispute. GenLayer is used where the application needs interpretation of natural language and evidence, with validators evaluating a proposed result through GenLayer's consensus process. The UI must explain the distinction between an AI-assisted assessment, protocol consensus/finality, and legal enforceability.

**Product principle:** make the reasoning inspectable, the process legible, and the limitations impossible to miss.

### Product promise

- A guided process for turning a vague disagreement into a structured case.
- A right of reply before assessment.
- Evidence references and integrity checks that help users track what was submitted.
- A reasoned, structured assessment rather than an unexplained verdict.
- An on-chain history of meaningful case events and final protocol outcomes.
- Clear network, transaction, and finality status.

### What VeriCourt is not

- Not a legal service, law firm, court, arbitration institution, or guarantee of enforceability.
- Not a promise that an LLM or validator consensus always identifies objective truth.
- Not an escrow or payment-custody system in the MVP.
- Not a generic AI chatbot with an on-chain badge.
- Not a backend-powered SaaS product. The initial architecture must not introduce a custom server, Supabase, Firebase, Fly.io, API routes, a separate database, or server-held private keys.

---

## 2. Product goals and success criteria

### Goals

1. Let a user create a well-scoped dispute with minimal ambiguity.
2. Ensure each party can provide a statement and relevant evidence.
3. Prevent unauthorized actions and invalid case-state transitions at the contract level.
4. Produce a normalized assessment with findings, evidence references, reasoning, limitations, and a proposed outcome.
5. Make the distinction between transaction submission, pending consensus, appeal/finality, and final outcome visible.
6. Preserve an auditable case history without storing unnecessary private information on-chain.
7. Create a polished and distinctive product experience that feels serious enough for disputes but visually unlike generic legal-tech dashboards.
8. Keep the implementation small, testable, and compatible with verified GenLayer APIs.

### MVP acceptance criteria

- A wallet can connect and the UI can identify the selected network.
- A user can create a case with required fields and see transaction feedback.
- Case participants can submit statements and bounded evidence metadata according to the contract's documented rules.
- Only authorized participants can perform participant-only actions.
- The responding party has a defined right-of-reply window.
- A case cannot be assessed before required conditions are met.
- Assessment output is normalized and validated before it becomes case state.
- Invalid or malformed AI output cannot silently become a valid ruling.
- The UI differentiates submitted, pending, finalized, and failed transactions where the SDK/network exposes those states.
- Users can inspect the case timeline and relevant transaction identifiers.
- Direct tests and lint pass; integration tests are run where the required environment is available.
- No custom backend or off-chain database is added.

---

## 3. Users and jobs to be done

### Primary users

**Freelancer**
- Wants to show what was agreed, what was delivered, and what feedback or payment remains unresolved.
- Needs to submit evidence without guessing which information matters.
- Wants an understandable result and a record of the process.

**Client**
- Wants to explain where a deliverable differs from the agreed scope.
- Needs a chance to provide references, requirements, and feedback.
- Wants the assessment to account for both sides rather than one party's narrative.

**Observer / reviewer**
- May inspect a case record or exported report if the participants choose to share it.
- Should not gain authority to alter the case merely by viewing it.

### Jobs to be done

- “Help me describe the agreement and the exact disagreement.”
- “Help me submit the information relevant to this case.”
- “Show me what the other party submitted and when I can respond.”
- “Explain the assessment and which evidence supports each finding.”
- “Let me verify the case history and transaction state.”
- “Let me export a readable record without implying that it is a legally binding judgment.”

---

## 4. Scope and non-goals

### MVP scope

- Wallet connection and StudioNet diagnostics.
- Dashboard of cases associated with the connected wallet, using documented contract reads and whatever discovery/indexing can be achieved without a backend.
- Guided case creation.
- Case categories and reusable on-screen templates.
- Agreement summary and requested remedy.
- Party statements and response workflow.
- Evidence register with text, links, and bounded metadata.
- Optional browser-side file hashing where supported; record hashes rather than large file contents.
- Case lifecycle and deadline display.
- Intelligent Contract assessment request and structured outcome.
- On-chain event/history references, where supported by the contract and SDK.
- Downloadable/printable case report generated in the browser.
- Privacy warnings, limitations, error states, and protocol diagnostics.

### Explicit non-goals for the first release

- No escrow custody or transfer of user funds.
- No automated payment enforcement.
- No off-chain account system or email/password login.
- No backend service, custom API, hosted database, Supabase, Firebase, Fly.io, serverless function, worker, or backend framework.
- No guarantee that a result is enforceable in any jurisdiction.
- No unlimited evidence uploads or on-chain storage of large files.
- No hidden administrator who can rewrite finalized results.
- No “AI confidence score” presented as a calibrated probability unless there is a defensible, tested method for calibration.
- No claim that a cryptographic hash proves evidence authenticity or truth.
- No assumption that all GenLayer validators produce identical text or that `strict_eq` is suitable for fuzzy semantic judgments.

---

## 5. Core user journeys

### Journey A — Create a dispute

1. User connects an injected wallet.
2. UI checks whether the active network is the intended StudioNet configuration.
3. User chooses a dispute template, such as software development, design, writing/content, or other digital work.
4. User enters:
   - short title;
   - agreement/scope summary;
   - expected deliverable;
   - deadline or milestone, if applicable;
   - description of the disagreement;
   - requested remedy;
   - opposing party wallet/address if known and supported by the product model.
5. UI shows a pre-submission review, character limits, privacy warnings, and the fact that on-chain data may be public and permanent.
6. User submits the transaction.
7. UI shows submission and network/transaction status.
8. When confirmed by the relevant contract/SDK response, the case detail view shows its identifier and timeline.

### Journey B — Add evidence

1. Participant opens the case.
2. UI explains which evidence formats are supported.
3. Participant adds a label, evidence type, short description, source/link or bounded text, and optional browser-computed file hash.
4. UI checks input bounds and validates URL formats where applicable.
5. UI warns before submission that links can change or disappear and on-chain metadata may be permanent.
6. Contract enforces the participant role, case state, and size/count limits.
7. UI appends the successful submission to the timeline.

### Journey C — Right of reply

1. The responding party sees a clear notice and deadline.
2. They can submit a statement, counter-evidence, and response to the key claims.
3. The UI distinguishes “no response yet” from “declined to respond” if the contract supports the distinction; do not infer intent from silence.
4. The contract prevents assessment before the response window is complete or a valid completion condition is met.
5. If no response is received, the assessment must explicitly note that fact and must not treat silence alone as proof that the initiating party is correct.

### Journey D — Request an assessment

1. UI checks that the case is in an eligible state and the reply conditions are satisfied.
2. UI presents the exact evidence and agreement summary that will be evaluated.
3. User confirms the assessment request and sees the relevant transaction disclaimer.
4. Contract executes the documented GenLayer intelligent assessment path.
5. The leader's proposed assessment is evaluated under an equivalence strategy chosen for the non-deterministic result.
6. UI shows pending/appeal/finality states based on actual network/SDK information; it must not mark a result final just because a transaction was submitted.
7. Finalized case outcome becomes read-only except for explicitly modeled follow-up actions.

### Journey E — Read the assessment

The result page should show:
- concise outcome summary;
- findings grouped by issue;
- relevant evidence references;
- what is supported, contradicted, or unresolved;
- reasoning in plain language;
- missing evidence and assumptions;
- whether the other party responded;
- limitations and uncertainty;
- protocol transaction references and finality state;
- explicit notice that this is an AI-assisted protocol outcome, not automatically a legally binding judgment.

### Journey F — Export a case report

- Generate a report in the browser from data already available to the frontend.
- Include case ID, parties as represented by wallet addresses, timestamps, agreement summary, evidence metadata/references, assessment, limitations, and transaction identifiers.
- Clearly label it “VeriCourt case report — not a court judgment or legal opinion.”
- Do not imply that a locally generated report is independently signed unless it actually is.

---

## 6. Case lifecycle and state machine

Use a deliberately small, explicit state machine. Exact enum/storage syntax must be verified against the installed GenLayer skills and current docs before implementation.

Suggested conceptual states:

1. `DRAFT` — frontend-only draft; not yet created on-chain.
2. `OPEN` — case created and initial details recorded.
3. `AWAITING_RESPONSE` — response is due from the other participant.
4. `READY_FOR_ASSESSMENT` — required response/deadline conditions are satisfied.
5. `ASSESSMENT_PENDING` — assessment transaction is in progress.
6. `APPEAL_OR_FINALITY_PENDING` — only if the relevant network/contract API exposes a meaningful state that can be represented accurately.
7. `DECIDED` — outcome is finalized according to the verified protocol status available to the app.
8. `CLOSED` — participants close/acknowledge the case, if this action is included and clearly distinguished from a protocol-final decision.

Do not create a frontend-only status that contradicts contract state. Keep network transaction status separate from business case status.

### Transition requirements

- Only a participant with the relevant role can submit their statement or evidence.
- No evidence or statement mutation after the assessment snapshot is locked, unless the protocol explicitly supports a new round/review.
- Assessment can only begin when all preconditions are met.
- A finalized outcome cannot be overwritten through a normal write call.
- Retrying a failed assessment must be a distinct, explicit action with bounded retry rules and a reason recorded where appropriate.
- A review/appeal is a later-phase feature and must not be simulated as if it were native protocol appeal/finality.
- Every transition validates the current state on-chain; frontend checks improve UX but are not security controls.

---

## 7. Evidence model and integrity

### Supported evidence for the MVP

- Short text passages within strict limits.
- URLs to external documents/pages.
- Evidence title/label and type.
- Description of relevance.
- Optional file hash calculated in the browser from a user-selected file, if browser support and dependency choice are verified.
- Submission timestamp/participant identity as recorded by the contract.

### Integrity semantics

A hash can help answer “Does this file match the bytes represented by this hash?” It cannot answer:
- whether the file was truthful;
- who originally authored it;
- whether the file was altered before the hash was calculated;
- whether an external URL will remain available;
- whether a document is legally admissible.

Do not store full file bytes or large attachments in contract storage. Do not add a third-party upload backend in the MVP. If external file storage is considered later, treat it as a separate architectural decision and explicitly assess availability, privacy, permanence, and trust assumptions.

### Evidence constraints

- Per-field character limits.
- Maximum evidence count per party/case.
- URL length limit.
- Reject empty, malformed, or overlong values.
- Do not execute user-provided markup or scripts.
- Render user content as text, not trusted HTML.
- Make external links visibly external and open safely.
- Avoid submitting unnecessary personal data, passwords, private keys, or confidential business information.

---

## 8. Intelligent assessment design

### Assessment input

The contract should construct a bounded, normalized assessment input from:
- agreement and deliverable summary;
- stated deadline/milestone;
- initial party's claim;
- responding party's statement, if any;
- evidence register and labels;
- requested remedy;
- explicit criteria relevant to the selected template.

The assessment should not invent missing terms. Missing facts should be labeled as unknown or unresolved.

### Suggested output schema

Use a typed, documented schema appropriate to GenVM and validated defensively. Conceptual fields:

- `summary`: concise neutral description of the result.
- `issues`: bounded array of issue-level findings.
  - `issue`
  - `finding`
  - `supporting_evidence_ids`
  - `contradicting_evidence_ids`
  - `reasoning`
  - `status`: supported / contradicted / mixed / unresolved
- `agreement_alignment`: analysis of the supplied deliverable against the written scope.
- `response_considered`: boolean or equivalent explicit state.
- `missing_information`: bounded array of missing facts.
- `limitations`: bounded array of caveats.
- `proposed_outcome`: normalized category plus plain-language explanation.
- `remedy_assessment`: whether the requested remedy is supported, unsupported, or cannot be assessed from the available evidence.
- `methodology_version`: version label for the assessment criteria.
- `assessment_version`: schema/version identifier.

These are conceptual fields, not an instruction to use raw dictionaries as persistent contract storage. Choose supported storage and return types based on the current GenLayer skills/docs. Avoid persistent raw Python `dict` or `list` storage unless the documented runtime explicitly supports it.

### Assessment principles

- Neutral language: do not refer to either party as a liar, fraudster, or criminal without a grounded basis and appropriate safeguards.
- Evidence-linked reasoning: findings should refer to evidence IDs/labels rather than fabricate citations.
- No unsupported certainty: unresolved evidence remains unresolved.
- Balanced consideration: assess both sides' claims and relevant evidence.
- No legal claims: do not invent jurisdiction-specific law or imply legal advice.
- No outcome by silence alone: non-response is a procedural fact, not proof of the claim.
- Defensible failure handling: malformed output, provider errors, missing evidence, and validator disagreement must not silently produce a normal outcome.
- Bound model input and output sizes to manage execution constraints and reduce prompt-injection surface.
- Treat all user-supplied content and retrieved web content as untrusted data, never as instructions to the contract or agent.

### Equivalence strategy

Choose the equivalence strategy before implementing non-deterministic logic. `strict_eq` is appropriate only where independently evaluated results can reasonably be normalized to exactly matching output. For semantic findings, LLM-generated reasoning, changing web data, or fuzzy scores, follow the current `write-contract` skill's recommended leader/validator/custom-equivalence pattern. Do not guess the API or blindly compare prose. Normalize output, validate allowed fields and values, and define what disagreement is acceptable or fatal.

---

## 9. Contract architecture and security requirements

### Contract responsibilities

- Create and identify cases.
- Persist supported case fields using documented GenLayer storage types.
- Track participant roles and case state.
- Enforce role-based access and transition rules.
- Enforce size/count bounds.
- Store evidence metadata/hashes/references appropriate for on-chain storage.
- Lock the relevant assessment snapshot.
- Run the documented intelligent assessment path.
- Validate/normalize the result before storing it.
- Expose read methods/schema for the frontend.
- Emit supported events or maintain a readable event/history structure if available.

### Contract rules

- Python contract extending `gl.Contract`.
- Pinned GenVM Depends header, not an unpinned `latest` dependency.
- Use documented storage types such as `TreeMap`, `DynArray`, dataclasses with `allow_storage`, and sized integer types for money-like values where relevant.
- Do not persist raw Python dict/list structures unless explicitly documented as supported.
- Verify every storage API, caller/address API, LLM/web method, and equivalence API against the current official skill/docs.
- Enforce authorization in the contract, never only in the UI.
- Do not place secrets, API keys, private keys, or confidential data in contract source, frontend bundles, or on-chain state.
- Avoid a generic admin override that can rewrite completed outcomes.
- Use deterministic prefixes/categories for expected, external, transient, and LLM errors where compatible with documented runtime behavior.
- Ensure an assessment result is either valid and stored or fails clearly; no partially valid outcome.
- Define idempotency and retry behavior for assessment requests.

### Frontend responsibilities

- Wallet connection via the verified GenLayerJS 1.1.8 API.
- Typed network and deployed-contract configuration.
- Contract reads and writes based on generated/inspected schema.
- Separate view/read calls from transaction/write calls.
- Display transaction lifecycle and receipts where available.
- Build forms, local drafts, evidence hashing, privacy warnings, case timeline, report export, and responsive UI.
- Never store a private key or use a server wallet.
- Never claim that a transaction is final without evidence from the verified status/receipt.

### Network configuration

User-provided target context:
- StudioNet
- Chain ID `61999`
- API/RPC context: `https://studio.genlayer.com/api`
- GenLayerJS context: `1.1.8`
- Injected wallet through GenLayerJS

Before implementation, verify each value and its correct usage against current official GenLayer documentation and the installed SDK version. Do not assume that an endpoint can be used interchangeably as an RPC URL, REST API, or SDK base URL. Prefer the documented built-in network configuration and network commands rather than manually overriding RPC settings.

StudioNet is gasless according to the supplied project context; a 0 GEN balance can be expected. Still verify the current network instructions.

---

## 10. Frontend information architecture

### Main routes / views

1. **Landing / How it works**
   - One-sentence explanation.
   - Three-step process: define the dispute, exchange evidence, inspect the assessment.
   - Clear limitations and privacy warning.
   - Connect wallet CTA.
2. **Dashboard**
   - Cases associated with the connected wallet, to the extent discoverable through verified contract reads/events.
   - Filters by role and case state.
   - Empty state with a strong “Start a case” action.
   - If discovery is impossible without a backend, implement a transparent local recent-case list and/or a manual case-ID lookup; do not quietly add an indexer/backend.
3. **Create case wizard**
   - Step 1: category and title.
   - Step 2: agreement and deliverable.
   - Step 3: dispute and requested remedy.
   - Step 4: participant and deadline details where supported.
   - Step 5: review, privacy warning, and submit.
4. **Case detail**
   - Case status, case ID, parties, created date.
   - Timeline.
   - Agreement and claims.
   - Evidence register.
   - Response section.
   - Actions permitted in the current state.
5. **Assessment**
   - Assessment status.
   - Structured findings.
   - Evidence links/references.
   - Limitations and missing information.
   - Transaction/finality details.
6. **Protocol diagnostics**
   - Connected wallet.
   - Active chain ID.
   - Expected network.
   - Contract address and schema status.
   - Recent transaction identifier/status.
   - Helpful recovery instructions.
7. **Report preview/export**
   - Printable, browser-generated report.
8. **Settings / About**
   - Network and contract configuration (read-only or build-config sourced).
   - Methodology version.
   - Privacy and limitation notices.

### Dashboard discovery constraint

Do not invent a backend to query all cases. First inspect contract schema, events, and supported reads. If the contract does not offer safe and feasible enumeration, use a clear MVP alternative such as recent case IDs stored locally by the browser plus a “look up by case ID” input. Make it clear that local recent history is browser-specific and not the authoritative source of truth.

---

## 11. Visual design system — “FORENSIC POP”

The design should feel like an experimental editorial publication crossed with a precise evidence lab: bold, high contrast, playful color used with discipline, and a serious information hierarchy. Avoid generic SaaS gradients, blue-purple Web3 glow, glassmorphism, stock courthouse imagery, gavels, scales, and cookie-cutter cards.

### Brand concept

**Name:** VeriCourt  
**Tagline:** Evidence in. A reasoned outcome out.  
**Visual idea:** two angular evidence brackets frame a single “VC” mark; the gap between the brackets symbolizes the space where evidence is examined. Use sharp rules, oversized case numbers, stamped status labels, and tightly controlled highlighter colors.

### Color palette

| Token | Hex | Role |
|---|---|---|
| Paper | `#F4F0E7` | Main canvas / warm editorial background |
| White Paper | `#FFFEFA` | Main reading surfaces |
| Ink | `#171717` | Primary text and dark panels |
| Acid Lime | `#D7FF3F` | Primary action accent, selected highlights |
| Verdict Coral | `#FF5B4D` | High-priority warnings, contested status, critical emphasis |
| Ultraviolet | `#6D35FF` | Protocol/assessment accent and selected data visualization |
| Pool Blue | `#46D9FF` | Evidence metadata, links, diagnostic highlights |
| Soft Lavender | `#C9BEFF` | Secondary highlight, quiet selected state |
| Muted Ink | `#77766F` | Secondary text (check contrast for each use) |
| Rule Grey | `#D5D0C6` | Dividers, outlines, table rules |
| Deep Aubergine | `#21172F` | Optional dark assessment/protocol panel |

**Usage rules**
- Paper and White Paper are the foundation.
- Ink is the default text color.
- Acid Lime should be reserved for the primary action and selected “active” emphasis.
- Coral means attention or contested information, not generic decoration.
- Ultraviolet is for assessment/protocol concepts, not every button.
- Pool Blue is for links, evidence metadata, and technical details.
- Do not use all accents at full strength in the same viewport. One primary accent plus one supporting accent is the default.
- Ensure text and control contrast meets WCAG AA where applicable; never place small Ink text on a saturated color without checking contrast.
- Use icons alongside color for state identification.

### Typography

Preferred stack:
- **Display:** Space Grotesk or another verified, locally available geometric grotesk.
- **Body:** Inter or a highly legible system sans.
- **Metadata / IDs / timestamps:** IBM Plex Mono or a system monospace.

Typography hierarchy:
- Large editorial headline, short line lengths.
- Case identifiers in mono with generous tracking.
- Body text calm and readable.
- Avoid all-caps for long passages.
- Use numerals and status stamps as visual anchors, not decoration.

If external font loading is not reliable, use robust system fallbacks. Do not let a remote font dependency break the app.

### Shape and layout

- 12-column desktop grid; single-column mobile.
- Thin black rules, square or minimally rounded corners.
- Mostly flat surfaces; no heavy drop shadows.
- Evidence entries can look like labeled archival slips.
- Case states can use compact stamps or tab-like labels.
- Assessment can use a distinct deep-aubergine panel with high-contrast text, but long reasoning must remain comfortable to read.
- Use whitespace as a structural tool.
- Prefer crisp alignment, asymmetrical editorial composition, and intentional oversized case numbers.
- Animations should be short and functional; respect reduced-motion preferences.

### Brand mark

Create a simple angular bracket symbol, not a gavel, courthouse, scales, or shield cliché. The mark may be built with two open corner shapes facing inward, with a small central dot or “VC” monogram. The logo must remain legible in monochrome and at favicon size.

### UI component direction

- Buttons: strong rectangular silhouettes; primary button uses Ink text on Acid Lime only if contrast is verified; clear hover/focus/disabled states.
- Inputs: paper-white surfaces, visible labels, dark outlines, helpful inline errors.
- Evidence rows: label, type, submitter, time, source/hash, and relevance.
- Timeline: thin vertical rule and clear timestamp/status markers.
- Status badges: text plus shape/icon, not color alone.
- Result panels: “Finding”, “Evidence”, “Reasoning”, and “Limitations” sections separated clearly.
- Empty states: editorial illustration built from shapes/typography, not generic stock art.
- Warnings: explicit language with Coral accent and clear user action.
- Tables: readable row separators and responsive alternatives on mobile.

### Motion

- Minimal reveal of wizard steps and timeline entries.
- No animated background or constant movement.
- Use motion to communicate loading, completion, and focus.
- Respect `prefers-reduced-motion` if the implementation framework supports it.

---

## 12. Accessibility and responsive behavior

- Every field has a persistent label.
- All actions are keyboard accessible.
- Focus indicator is obvious against paper and dark surfaces.
- Errors are connected to the relevant field and described in text.
- Color never communicates state alone.
- Long evidence and addresses wrap safely.
- Case IDs and hashes have copy affordances with accessible labels.
- Loading and transaction changes are announced appropriately.
- Modals/dialogs trap focus correctly if used.
- Mobile wizard works at narrow widths; no critical action requires hover.
- Avoid excessive animation and support reduced motion.
- Text zoom and browser zoom must not hide essential actions.

---

## 13. Privacy, safety, and trust copy

Display this warning before case creation and before submitting evidence:

> **Before you submit:** Information written to a public blockchain may be visible and permanent. Do not submit passwords, private keys, confidential information, or personal data you do not have permission to share. VeriCourt provides an AI-assisted assessment, not legal advice or a guarantee of a legally binding result.

Additional trust language:
- “A file hash helps verify file integrity; it does not prove that the file is authentic or true.”
- “External links can change or become unavailable.”
- “Protocol consensus is not a guarantee of objective truth.”
- “A missing response is recorded as a procedural fact, not automatic proof against the non-responding party.”
- “Only show final when the relevant network status confirms finality.”

Do not promise privacy, confidentiality, legal enforceability, objective truth, or guaranteed fairness beyond what the system can demonstrate.

---

## 14. Failure and edge cases

The UI and contract should handle:

- Wallet unavailable or user rejects connection.
- Wrong network or network switch failure.
- Missing contract address or invalid configuration.
- Contract schema mismatch.
- Read call failure.
- Write rejected by the wallet.
- Transaction submitted but pending.
- Transaction failed, reverted, or rejected by consensus.
- Receipt unavailable or not yet indexed.
- LLM output malformed, incomplete, or outside the schema.
- External source unavailable or changed.
- Empty evidence, oversized input, invalid URL, unsupported file.
- Unauthorized action.
- Case already advanced beyond the action's allowed state.
- Duplicate assessment request.
- Assessment retry limit reached.
- A party never responds.
- The same evidence ID is referenced twice.
- Report export attempted with incomplete data.

Every error should say what happened, whether the action may have been submitted, and what the user can safely do next. Do not advise a retry if it could duplicate an irreversible write without checking transaction state.

---

## 15. Testing and quality gates

Use the installed GenLayer development skills and verify their current instructions before use.

Required order:
1. Contract lint after every contract change:
   `genvm-lint check contracts/<file>.py --json`
2. Direct tests:
   `pytest tests/direct/ -v`
3. Integration tests when consensus, real web/LLM calls, Studio, GLSim, StudioNet, or network behavior matters:
   `gltest tests/integration/ -v -s`
4. Deployment/debug loop with the current documented GenLayer CLI commands.

Test categories:
- State transitions.
- Access control and participant roles.
- Input bounds and validation.
- Evidence count/size limits.
- Right-of-reply rules.
- No assessment before eligibility.
- No mutation after assessment snapshot lock.
- Malformed output and LLM/external errors.
- Equivalence behavior and normalization.
- Retry/idempotency.
- Report rendering with missing fields.
- Wrong network and wallet rejection.
- Pending/finalized/failed transaction states.
- Responsive and keyboard interaction.

Mock web/LLM behavior in direct tests. Use integration tests for consensus confidence; do not treat unit tests as proof of consensus correctness.

---

## 16. Phased implementation

### Phase 0 — Repository and docs audit
- Inspect the existing project before changing files.
- Read the `write-contract`, `genvm-lint`, `direct-tests`, `integration-tests`, and `genlayer-cli` skills.
- Verify GenLayerJS 1.1.8 methods, StudioNet configuration, contract schema access, transaction status, and receipts from official docs/MCP.
- Report the actual project state and the proposed minimal implementation plan.
- Do not write application code until the audit is complete.

### Phase 1 — Contract foundation
- Define storage types, case model, access control, lifecycle, bounds, and schema.
- Implement direct tests.
- Run lint after every change.
- Do not add LLM assessment until basic state rules pass.

### Phase 2 — Intelligent assessment
- Choose equivalence strategy first.
- Implement bounded normalized inputs and defensive output validation.
- Add mocked direct tests and appropriate integration tests.
- Document failure behavior.

### Phase 3 — Frontend foundation
- Configure verified GenLayerJS client and StudioNet.
- Implement wallet/network diagnostics and schema-driven reads/writes.
- Build the Forensic Pop design tokens and accessible components.
- Keep contract addresses/config typed and centralized.

### Phase 4 — Core workflows
- Create case, evidence register, right of reply, assessment request, result view, timeline, and report export.
- Wire every action to the real contract; no fake-success UI.
- Keep local drafts and recent case IDs browser-local only where necessary and label them as such.

### Phase 5 — Verification and release readiness
- Run lint, direct tests, integration tests where possible, and frontend checks.
- Validate the complete transaction lifecycle.
- Review privacy copy, error handling, keyboard accessibility, responsive layout, and contract schema alignment.
- Report anything blocked by missing tools, network, accounts, APIs, or provider access with the exact next manual step.

---

## 17. Definition of done

VeriCourt MVP is complete when:
- The product and contract use the same explicit case model and state transitions.
- Every contract write has authorization, bounds, and state validation.
- Non-deterministic assessment has a documented equivalence/validation strategy.
- The frontend uses verified GenLayerJS APIs and the deployed/inspected schema.
- The UI never invents transaction success or finality.
- Core flows work from wallet connection through report export.
- Lint and direct tests pass; integration testing is completed or its blocker is clearly documented.
- No custom backend, database, Supabase, Firebase, Fly.io, or server-held keys exist.
- The visual design consistently follows Forensic Pop, remains readable, and meets accessibility requirements.
- Privacy and legal limitations are visible before users submit sensitive information.

**Product north star:** every outcome should be traceable to the submitted record, every procedural state should be understandable, and every limitation should be stated honestly.
