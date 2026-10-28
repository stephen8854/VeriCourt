# VeriCourt - Assessment Agreement Design (Phase 2.9)

Status: **approved and implemented locally in Phase 2.10** (remedy advisory, threshold-free
outcome mapping, Option A issue rules, rubric prompt v2, v2 version identifiers). Option B
was not implemented. Not yet exercised on StudioNet. Sections 1-2 describe the v1 behaviour
that was analysed; line numbers there refer to the v1 file. Current rules:
`docs/ASSESSMENT_NOTES.md`.
Scope: `contracts/vericourt.py` assessment path on GenVM v0.2.16 (StudioNet, runner
`py-genlayer:1jb45aa8...`). Source of truth for "current behaviour" is the repository as of
this phase; line numbers refer to `contracts/vericourt.py` (md5 `4baec246...`).

Evidence used: `integration-logs/assessment-tx-raw.json` (raw StudioNet transaction
`0xf6c085c9...07a1`, including per-round leader receipts and validator votes),
`integration-logs/assessment-proposal-comparison.txt`, and
`integration-logs/studionet-rerun-readonly-verification.json`.

Every case example in this document is **invented fictional data** unless it is explicitly
marked as the Phase 2.8 test record (which is itself fictional test content written for the
smoke test).

---

## 1. Current behaviour

### 1.1 Flow

1. `request_assessment` (1069) checks party role, `READY_FOR_ASSESSMENT`, lock, attempt cap,
   and no existing assessment; rebuilds the frozen record and checks it against
   `snapshot_digest` (1088-1091).
2. One non-deterministic block: `gl.vm.run_nondet_unsafe(leader_fn, validator_fn)` (1108).
   - **Leader** (`_run_assessment`, 716): one `exec_prompt(prompt, response_format="json")`
     call, then `_normalize_assessment` (526).
   - **Validator** (`_validate_leader`, 725): re-normalises the leader payload (must be
     canonical), makes **one** independent model call, then `_assessments_equivalent` (651).
3. Agreed valid result -> stored, `DECIDED`. Agreed `[LLM_ERROR]` -> attempt counted,
   `ASSESSMENT_FAILED` at 2. No agreement -> transaction `UNDETERMINED`, **no state change**.

### 1.2 Validation layers that exist today

| Layer | Where | What it enforces |
|---|---|---|
| Syntactic | `_normalize_assessment` 533-592, `_out_text`/`_out_token`/`_out_text_list` | JSON object; required keys; enum tokens; string types and lengths; no control characters |
| Evidence reference | `_out_id_list` 488-503, 572-574 | every cited id exists in the locked record; no duplicates; an id cannot be both supporting and counter within one finding |
| Semantic (deterministic) | 575-580, 598-604 | SUPPORTED/PARTIALLY_SUPPORTED need >=1 supporting id; NOT_SUPPORTED needs >=1 counter id; model-supplied outcome must equal the derived one; INCONCLUSIVE requires remedy CANNOT_ASSESS; CLAIM_NOT_SUPPORTED requires remedy NOT_SUPPORTED or CANNOT_ASSESS |
| Derived outcome | `_derive_outcome` 511-523 | `2U > n` -> INCONCLUSIVE; all S -> CLAIM_SUPPORTED; S+P = 0 -> CLAIM_NOT_SUPPORTED; else CLAIM_PARTIALLY_SUPPORTED |
| Validator equivalence | `_assessments_equivalent` 651-671 | outcome **exact**; remedy exact or adjacent (S~P, P~N); each determination exact or adjacent (S~P, P~N, P~U); per-issue citation overlap `_citations_agree` 625-648 |

Not compared anywhere: summary, finding, reasoning, confidence, open questions, limitations.

### 1.3 Runtime facts that constrain the design (verified)

- `exec_prompt` in the pinned SDK accepts only `response_format` and `images`
  (`genlayer/gl/nondet/__init__.py`, `ExecPromptKwArgs`). There is **no temperature or
  seed control**; sampling variance cannot be reduced by parameters.
- A validator returning `False` and validator exceptions both produce `DISAGREE`
  (`gl/vm.py`). Disagreement is **not catchable** in contract code: the network rotates the
  leader and, when rotations run out, the transaction is `UNDETERMINED` and changes no
  state. Consequently the contract cannot count disagreements or fall back after them.
- StudioNet validators run **different model families** (observed in Phase 2.8: gemini,
  sonnet, mistral, gpt-5.4, qwen, minimax) through a routing policy; each node's primary
  model call has a 22 s timeout (`node_config.primary_model.config.timeout_ms`).

---

## 2. Root-cause analysis (Phase 2.8)

### 2.1 What the network did (from `assessment-tx-raw.json`)

| Round | Leader model | Leader proposal (I1 ; I2) | Validators (vote) |
|---|---|---|---|
| 0 | gemini | P (sup E1, ctr E2) ; N (ctr E2), remedy PARTIALLY_SUPPORTED | mistral DISAGREE, **qwen AGREE**, gpt-5.4 DISAGREE, 1 idle |
| 1 | sonnet | U (sup E1, ctr E2) ; U (ctr E2), remedy CANNOT_ASSESS | mistral, qwen, gemini: DISAGREE; 1 idle |
| 2 | mistral | P (sup E1, E2) ; U, remedy CANNOT_ASSESS | gpt-5.4, gemini, qwen: DISAGREE; 1 idle |
| 3 | gpt-5.4 | P (sup E1, ctr E2) ; U, remedy CANNOT_ASSESS | minimax, gemini, qwen: DISAGREE; 1 idle |

"Idle" = `Validator execution cancelled after quorum` (not a timeout). Every validator
executed successfully; `nondet_disagree: 0` means `validator_fn` returned `False`. All four
leader proposals passed full contract validation in GenVM.

**Limitation:** validators' own model outputs are not recorded, only their votes. The
analysis below uses the four leader proposals as samples of what different models produce.

### 2.2 The (fictional) record

- Issues: I1 "Export button missing", I2 "Settings page incomplete".
- E1 (claimant, TEXT): "Scope item 3: an export button that downloads data as CSV."
- E2 (respondent, TEXT): "Client approved a reduced settings page on day 10; export button postponed."
- Reply (respondent): settings scope reduced by agreement; export button postponed, not dropped.

### 2.3 Each disagreement and the exact rule responsible

| Pair (leader -> validator sample) | Differences | Blocking rule(s) |
|---|---|---|
| r0 -> r2, r0 -> r3 (and reverse) | remedy PARTIALLY_SUPPORTED vs CANNOT_ASSESS; I2 N vs U | `ADJACENT_REMEDIES` has no pair with CANNOT_ASSESS (168-171); `ADJACENT_DETERMINATIONS` has no N~U pair (163-167) |
| r0 -> r1 (and reverse) | outcome PARTIAL vs INCONCLUSIVE; remedy; I2 N vs U; I1 P vs U | outcome exact match (660); remedy; N~U |
| r1 -> r2, r1 -> r3 (and reverse) | outcome INCONCLUSIVE vs PARTIAL | outcome exact match (660). I1 P~U is *allowed* at issue level (166) but flips the derived outcome for n = 2 |
| r2 <-> r3 | none material | **agree** |
| any pair | evidence citations | **never the cause** (`_citations_agree` passed every pair whose determinations were adjacent) |

Underlying causes, in order of contribution:

1. **Remedy is consensus-critical**, but it is the most judgement-laden field (it asks
   whether a *requested remedy* is justified, which depends on proportionality the record
   rarely settles). `CANNOT_ASSESS` is non-adjacent to everything.
2. **Genuine evidential ambiguity on I2.** E2 is the respondent's own note asserting
   client approval. gemini read it as contradicting the claim (N); three others treated an
   uncorroborated party assertion as insufficient (U). The prompt's definition
   "NOT_SUPPORTED: cited evidence contradicts the claimant's position" (692) does not say
   how to weigh a party's own uncontested-but-uncorroborated statement. This difference is
   **material** and should remain a disagreement unless the rubric resolves it.
3. **Internal inconsistency of the current rules.** P~U is tolerated at issue level, but the
   exact outcome check rejects it whenever it changes the derived outcome, which for small n
   is almost always. The issue-level tolerance is therefore largely illusory.
4. **Intra-model variance.** gpt-5.4's own round-3 proposal would have agreed with mistral,
   yet the gpt-5.4 validator in round 2 disagreed with mistral. Without temperature control
   this cannot be engineered away.

### 2.4 Latent defects found while analysing (independent of Phase 2.8)

Verified by exhaustive enumeration of all finding combinations for 1 to 5 issues
(scratch script, not a project test):

- **Unresolved issues counted against the claimant.** `_derive_outcome` returns
  `CLAIM_NOT_SUPPORTED` whenever no issue is S/P and at most half are U, e.g. `[N, U]`,
  `[N, N, U]` (30 combinations for n <= 5). An issue the record cannot decide is thereby
  folded into "the claim is not supported". This conflicts with the fairness rule that
  missing or insufficient evidence must not count as proof against a party.
- **Non-monotone mapping.** In 220 cases a set of findings that is uniformly *weaker*
  (fewer definite findings) derives an outcome in a *different direction*, e.g.
  `[N, U] -> CLAIM_NOT_SUPPORTED` while `[N, S] -> CLAIM_PARTIALLY_SUPPORTED`. The `2U > n`
  majority threshold is also arbitrary (it has no evidential meaning).

---

## 3. Proposed agreement rules

### 3.1 Principles

1. **Direction** (does the evidence favour the claimant, contradict them, or neither) and
   **definiteness** (a determination vs. "the record cannot decide") are material. A
   validator must never endorse a stored finding that asserts a direction or definiteness
   it did not reach.
2. **Degree** within the same direction (SUPPORTED vs PARTIALLY_SUPPORTED) is tolerable when
   both rely on common evidence.
3. Fields that are judgement calls about *consequences* (remedy) are advisory, not consensus
   fields, until they can affect funds or rights.
4. The overall outcome is a pure, threshold-free function of the agreed issue findings.

### 3.2 Issue-level agreement table (recommended: Option A, symmetric)

Leader determination vs a validator's own determination for the same issue. Citation rules
apply to already-validated findings (all ids exist in the locked record).

| Leader \ Validator | SUPPORTED | PARTIALLY_SUPPORTED | NOT_SUPPORTED | UNRESOLVED |
|---|---|---|---|---|
| **SUPPORTED** | Agree if supporting ids overlap | Agree if supporting ids overlap (degree only) | **Disagree** (opposite direction) | **Disagree** (definite vs undecided) |
| **PARTIALLY_SUPPORTED** | Agree if supporting ids overlap | Agree if supporting ids overlap | **Disagree** (direction) - *tightened from today* | **Disagree** (definiteness) - *tightened from today* |
| **NOT_SUPPORTED** | Disagree | Disagree - *tightened* | Agree if counter ids overlap | **Disagree** (preserved) |
| **UNRESOLVED** | Disagree | Disagree - *tightened* | Disagree (preserved) | Agree (no citation requirement) |

Plus, unchanged: the derived outcome must be identical (needed because S~P can change it),
and every issue must be present in both.

**What changes vs today:** remedy is removed from the comparison (section 5); P~N and P~U
stop being adjacent; NOT_SUPPORTED vs UNRESOLVED stays a disagreement in both directions.

**Why tighten P~N and P~U?** Today they are tolerated, yet N~U is not. The only principled
reading of "N and U are materially different" is that *definite vs undecided* and
*direction* are material; P is definite and favourable, so the same reasoning applies.
Keeping P~U also leaves the inconsistency of section 2.3 item 3 in place. This makes the
rule set stricter, which costs liveness (section 7); it does not let any new pair agree.

### 3.3 Citation rules (evidence integrity)

Kept as today, re-stated precisely:

- Deterministic, per finding: S/P need >=1 supporting id; N needs >=1 counter id; all ids
  exist in the locked record; no id in both lists of one finding. U may cite ids
  (informational: shows conflicting or irrelevant evidence) and they are not compared.
- Cross-validator, per issue, only when both findings are definite: same-direction pairs
  must share >=1 id in the list for that direction.

Assessment of the overlap rule: **necessary** (without it two models could reach the same
label for unrelated reasons, e.g. one citing the scope document, the other an unrelated
chat message), **not sufficient** (a shared id does not show both read it the same way, or
that it supports the conclusion), and **not overly restrictive** on the observed data (it
never blocked a Phase 2.8 pair). Keep it unchanged.

Considered and rejected: blocking "polarity conflicts" (an id cited as supporting by one
side and as counter by the other). In Phase 2.8, mistral cited E2 as *supporting* I1
("confirms the button was not delivered") while gpt-5.4 cited it as *counter*
("postponed by agreement"). Both readings are defensible and both reached P; blocking
would have destroyed the only agreeing pair. Polarity conflicts are therefore tolerated.
They cannot be surfaced to users either, because validators' own samples are not stored
(see 3.5); this is a documented limitation.

### 3.4 Option B (asymmetric "conservative endorsement") - for decision, not recommended yet

A validator endorses the leader's finding if the leader asserts **no more** than the
validator found, in the same direction: `U <= {S, P, N}`, `P <= S`, each value <= itself.
With the mapping of section 4 this is provably safe at outcome level (zero monotonicity
violations for n <= 5): if every issue is endorsed, the derived outcome is no stronger than
the validator's own, so a stored outcome is never one an endorsing validator would contest
as overstated.

- Benefit: persistent genuine disagreement can converge on an honest, conservative result
  (e.g. INCONCLUSIVE) instead of repeated `UNDETERMINED`.
- Cost and risk: consensus would then mean "validators agree that *at least* this much is
  established", not "validators reached the same finding". A lazy or biased leader can
  downgrade any issue to U and be endorsed. It cannot invert a direction, but because
  `DECIDED` is terminal a claimant (or respondent) with strong evidence could be left with a
  permanent INCONCLUSIVE. Option B should only be adopted together with a lifecycle change
  (e.g. an INCONCLUSIVE result does not end the case and permits one further assessment
  within the existing attempt cap). It also stores U when a validator found N, which is
  the case you asked to keep distinct; the stored value stays truthful, but the
  information is lost.

### 3.5 Insufficient, conflicting and irrelevant evidence

| Situation | Rubric outcome | Contract enforcement |
|---|---|---|
| No evidence bears on the issue | UNRESOLVED | deterministic: S/P/N impossible without citations |
| Only a party's own uncorroborated assertion, disputed by the other side's claim or reply | UNRESOLVED (new rubric rule, section 6) | not enforceable deterministically; reduced by prompt, caught only if validators disagree |
| Evidence on both sides, cannot be weighed | UNRESOLVED, citing both | allowed; citations informational |
| Evidence supports a distinct part, other part undocumented/contradicted | PARTIALLY_SUPPORTED | S/P citation rule |
| Cited id is irrelevant to the issue | not detectable deterministically | only mitigated by cross-validator overlap; documented limitation |
| Polarity conflict between validators (same id, opposite roles) | allowed | proposed: surface in provenance/UI as "validators read this item differently" is **not possible** (validator samples are not stored); documented limitation |

Considered and rejected: requiring definite findings to cite an item the parties tagged to
that issue. Tags are party-controlled (a party can tag everything everywhere, or
under-tag by mistake), so the rule would be both gameable and unfair.

---

## 4. Outcome mapping (proposed, threshold-free)

Counts over the n issue determinations: S, P, N, U.

| Rule (first match) | Outcome | Meaning |
|---|---|---|
| S = n | CLAIM_SUPPORTED | every issue documented in the claimant's favour |
| N = n | CLAIM_NOT_SUPPORTED | every issue documented against the claimant |
| S + P >= 1 | CLAIM_PARTIALLY_SUPPORTED | at least one issue documented (fully or partly) in the claimant's favour; others may be against or unresolved |
| otherwise (S + P = 0 and not all N) | INCONCLUSIVE | nothing in the claimant's favour is established, and not every issue is established against them |

Properties (verified exhaustively for n <= 5): deterministic; no numeric thresholds;
UNRESOLVED never contributes to CLAIM_NOT_SUPPORTED; monotone, so a weaker set of findings
never derives an outcome in a different direction.

Edge cases:

| Findings | Current | Proposed | Note |
|---|---|---|---|
| `[U]`, `[U, U]` | INCONCLUSIVE | INCONCLUSIVE | |
| `[N, U]` | CLAIM_NOT_SUPPORTED | **INCONCLUSIVE** | fixes the fairness defect |
| `[N, N, U]` | CLAIM_NOT_SUPPORTED | **INCONCLUSIVE** | same |
| `[S, U, U]` | INCONCLUSIVE | **CLAIM_PARTIALLY_SUPPORTED** | one issue is established; the label is accurate, per-issue detail shows the rest |
| `[U, U, U, S, S]` | INCONCLUSIVE | **CLAIM_PARTIALLY_SUPPORTED** | same |
| `[S, N]`, `[P, N]` | CLAIM_PARTIALLY_SUPPORTED | CLAIM_PARTIALLY_SUPPORTED | mixed findings |
| `[S, P]` | CLAIM_PARTIALLY_SUPPORTED | CLAIM_PARTIALLY_SUPPORTED | |
| `[P]` vs `[U]` (n = 1) | differ | differ | material: definite vs undecided |

`CLAIM_PARTIALLY_SUPPORTED` covers a wide range; the UI must always show the per-issue
breakdown next to it (section 5.3).

*Example (fictional):* a logo commission with three issues - "vector files missing" (S,
citing the brief and the delivery email), "wrong colour palette" (U, only the client's own
screenshot description, disputed in the reply), "late delivery" (N, the designer's
timestamped delivery note matches the agreed date). Today: `2U > n` is false, S + P = 1 ->
PARTIALLY_SUPPORTED. Proposed: PARTIALLY_SUPPORTED. Remove the vector-file evidence and the
findings become `[U, U, N]`: today -> CLAIM_NOT_SUPPORTED (an undecided palette dispute is
counted against the client); proposed -> INCONCLUSIVE.

---

## 5. Remedy policy

### 5.1 Recommendation

Keep `remedy_assessment` in the schema and in user-facing results, but make it an
**advisory, leader-generated field**:

- Not compared across validators.
- Still validated deterministically against the *agreed* outcome so it can never contradict
  it: INCONCLUSIVE -> must be CANNOT_ASSESS; CLAIM_NOT_SUPPORTED -> NOT_SUPPORTED or
  CANNOT_ASSESS (as today). CLAIM_SUPPORTED with remedy NOT_SUPPORTED remains allowed (the
  issues can be established while the requested remedy is disproportionate).
- Provenance moves from `consensus_compared` to a new class `leader_generated_constrained`
  ("written by the leader's model, constrained to be consistent with the agreed outcome,
  not compared across validators").

Rationale: in the MVP the remedy is advisory and moves no funds and changes no rights; it
is the field models disagree on most; and making it consensus-critical blocked agreement
in Phase 2.8 even where the issue findings matched (r0 vs r2/r3 on remedy alone would
still have failed after any issue-level fix).

**Gate for the future:** if VeriCourt ever ties the remedy to escrow, payment or any
consequential action, the remedy must become consensus-critical again (with its own
explicit agreement rule), and this advisory classification must be revisited first.

### 5.2 Rejected alternatives

- Remove remedy: rejected (you asked to keep it visible).
- Derive remedy from the outcome: rejected; it would only restate the outcome while
  appearing to assess the remedy.
- Make CANNOT_ASSESS adjacent to everything: rejected; that is equivalence for liveness.

### 5.3 Presentation (for Phase 3)

Decision block (agreed): outcome + per-issue determinations. Advisory block (not
validator-verified): remedy view, summary, findings, reasoning, confidence, open questions,
limitations, each under the existing provenance notice, extended to name the remedy.

---

## 6. Prompt improvements

Proposed changes (methodology `vericourt-method-v2`, marker `VERICOURT_ASSESSMENT_V2`):

1. **Per-issue decision procedure** (replaces the bare definitions at 689-695):
   1. List the evidence items whose *content* bears on this issue (do not rely on party
      tags).
   2. For each, note whether it *documents* a fact or is a party's *own assertion*.
   3. Choose:
      - SUPPORTED - evidence documents the claimant's position on the whole issue, and no
        relevant item documents otherwise.
      - PARTIALLY_SUPPORTED - evidence documents a distinct part of the claimant's
        position; another part is undocumented or contradicted.
      - NOT_SUPPORTED - evidence documents facts inconsistent with the claimant's position,
        and nothing documents the claimant's position.
      - UNRESOLVED - no relevant evidence; **or** the only relevant evidence on a point is a
        party's own uncorroborated assertion that the other side's claim or reply disputes;
        **or** relevant evidence conflicts and the record gives no basis to prefer one item.
   4. **Tie-break:** if unsure between a definite determination and UNRESOLVED, choose
      UNRESOLVED.
   - Targets the Phase 2.8 I2 split (E2 is a respondent's own, disputed note) and the I1
     P-vs-U split.
2. **Citations:** "For a definite determination, cite every item that supports it in the
   list for that direction; cite items that cut the other way in the other list." Keeps
   overlap high (the overlap rule never blocked, so no change in strictness).
3. **Remedy:** "remedy_assessment is advisory: whether the record supports the specific
   remedy requested. Use CANNOT_ASSESS if the overall position is unresolved." Remove the
   current heuristic "when most issues are UNRESOLVED" (699), which embeds the old
   threshold.
4. **Neutrality reminder for silence:** keep 687 verbatim.
5. **Schema stays strict:** no new fields. The output template is unchanged apart from
   the marker.

Expected effect, stated honestly: the tie-break and the "own uncorroborated assertion"
rule push borderline readings towards UNRESOLVED in a consistent direction, which should
reduce N~U and P~U splits, at the price of more INCONCLUSIVE outcomes. It cannot remove
model-family or sampling variance, and its effect must be measured (section 8.4).

---

## 7. Safety and fairness analysis

| Risk | Today | Proposed (Option A) | Notes |
|---|---|---|---|
| **False agreement** (stored finding a validator would contest) | P stored when a validator found U or N is possible (P~U, P~N adjacency); remedy tolerance | Removed: only same-direction, same-definiteness pairs agree, plus S~P with common evidence | Leader prose/citations remain unverified (provenance) |
| **False disagreement** (harmless differences block) | remedy; outcome flip from P~U; N~U | remedy no longer blocks; P~U/P~N now block explicitly (more often) | Net liveness may fall on ambiguous records; rises where remedy was the only difference |
| **Absence of evidence as proof** | `[N, U]` -> CLAIM_NOT_SUPPORTED | fixed: U never contributes to CLAIM_NOT_SUPPORTED | |
| **Silence as proof** | prompt rule + citation rule + contract notice | unchanged | no-response case without evidence can only be INCONCLUSIVE |
| **Evidence manipulation: volume** (a party floods items so overlap is easy) | overlap needs only one shared id | unchanged; caps of 10 per party limit volume | overlap still requires both validators to cite the item for the same direction |
| **Evidence manipulation: self-serving notes** (E2-style) | model-dependent (gemini treated as decisive) | rubric marks disputed own-assertions UNRESOLVED | not deterministically enforceable |
| **Prompt injection via evidence** | record JSON-encoded, marked untrusted | unchanged | |
| **Leader bias** | leader picks prose; validators check labels | unchanged under A; under B a leader can downgrade issues | |
| **Repeated disagreement** | `UNDETERMINED`, no state, retryable indefinitely | unchanged (no on-chain counter is possible) | communicated as "no agreement", not as "validation failed" (8.5) |

Remaining unverified risk: validator samples are unobserved; agreement rates under the new
rules can only be estimated from leader samples until measured on StudioNet.

---

## 8. Testing plan (before and during implementation)

Test categories are kept separate. All direct tests run in WSL (`genlayer-test` direct
mode); "exhaustive" replaces property-based testing because the finding space is finite
and `hypothesis` is not installed (no new dependency).

### 8.1 Syntactic validation (`_normalize_assessment`, existing, keep)
- Valid JSON but wrong types, missing keys, bad enums, over-length text (existing 55 cases).

### 8.2 Evidence-reference validation (keep, plus)
- Valid findings citing an id not in the locked record -> `[LLM_ERROR]`.
- Valid id that is irrelevant to the issue -> **passes** validation (documented limitation;
  test asserts the limitation so it is visible).

### 8.3 Semantic validation (deterministic)
- S/P without supporting id, N without counter id -> rejected (existing).
- Model-supplied outcome different from the derived one -> rejected.
- Valid JSON, semantically inconsistent prose (determination S, reasoning says "not
  supported") -> **passes** (prose is not checked); provenance labels it unverified.
- Remedy inconsistent with agreed outcome (INCONCLUSIVE with SUPPORTED) -> rejected.

### 8.4 Contract-derived outcome
- Exhaustive: every combination for n = 1..5 matches the section 4 table.
- Exhaustive monotonicity: zero violations (protects Option B if adopted later).
- No combination containing U yields CLAIM_NOT_SUPPORTED.
- "Different outcomes from the same findings" is impossible: outcome is a pure function;
  test that model-supplied outcomes cannot override it.

### 8.5 Validator equivalence (pure helper and through `run_validator`)
For every scenario requested:

| Scenario | Expected (Option A) |
|---|---|
| Identical findings, identical citations | agree |
| S vs P with overlapping supporting ids | agree (if outcome equal) |
| Identical determinations, disjoint citations | disagree |
| NOT_SUPPORTED vs UNRESOLVED (both orders) | disagree |
| SUPPORTED vs NOT_SUPPORTED | disagree |
| PARTIALLY_SUPPORTED vs UNRESOLVED / NOT_SUPPORTED | disagree (new) |
| Different remedy, identical findings | agree; stored remedy is the leader's |
| Conflicting claimant and respondent evidence, both U citing both | agree |
| No respondent reply, no evidence | only all-U findings are valid -> INCONCLUSIVE; agree |
| Leader cites an unknown id | validator rejects (re-normalisation) |
| Validator's own model call fails / invalid output | disagree (existing) |
| Leader invalid output, validator invalid output | agree -> attempt recorded (existing) |

- **Replay fixture:** the four Phase 2.8 leader proposals (decoded from
  `integration-logs/assessment-tx-raw.json`) as a regression table under the new rules.
- **Full matrix test:** all 16 ordered determination pairs x citation overlap yes/no.
- Mutation run (as in 2.6) on the new helper branches.

### 8.6 Integration (StudioNet, each needs your approval)
- Same Phase 2.8 record (ambiguous): measure whether consensus is reached and the round
  count.
- A **clear-cut** fictional record (e.g. a translation job where the delivery receipt and
  the brief agree): expect agreement in round 0.
- A **no-reply** fictional record with claimant evidence only.
- Estimated cost: 6 transactions per record (deploy once, then 5 per case on the same
  instance: create, evidence x1-2, reply/deadline, assess); about 15-20 transactions for
  three records; gasless; public, permanent fictional data. Bounded reads with explicit
  timeouts (the Phase 2.8 harness hung on an untimed read).
- Communicating repeated disagreement to users (Phase 3 copy): "Validators could not agree
  on these findings. Nothing was recorded and no assessment attempt was used. This usually
  means the record is ambiguous." Never "validation failed".

---

## 9. Migration and compatibility

- **Versions:** `ASSESSMENT_SCHEMA_VERSION` -> `vericourt-assessment-v2` (remedy semantics,
  outcome mapping and provenance change meaning); `METHODOLOGY_VERSION` ->
  `vericourt-method-v2`; `PROMPT_MARKER` -> `VERICOURT_ASSESSMENT_V2` (test mocks match on
  the marker and must change with it).
- **Storage layout:** unchanged. No dataclass fields are added or removed, so the stored
  `Assessment` remains readable by the same view code.
- **Provenance object:** new class `leader_generated_constrained` (remedy); this is a
  breaking change for any consumer of `provenance`; frontend not yet built.
- **Deployed instances:** both StudioNet instances are test-only v1 deployments; there is no
  upgrade path and none is needed - redeploy. No production data exists.
- **Docs:** `docs/ASSESSMENT_NOTES.md` sections 1-2 must be updated with the new tables
  when implemented.
- **Existing tests that will change** (expected, not weakening): outcome-derivation rows
  `[N, U]`, `[N, N, U]`, `[S, U, U]`, `[U, U, U, S, S]`; equivalence tests that rely on
  P~U, P~N or remedy adjacency; the provenance classification test.

---

## 10. Decision log

| # | Alternative | Decision | Reason |
|---|---|---|---|
| 1 | Make N and U adjacent | Rejected | Conflates "evidence against" with "no basis"; explicitly ruled out |
| 2 | Keep remedy consensus-critical, add CANNOT_ASSESS adjacency | Rejected | Equivalence for liveness on the least decidable field |
| 3 | Remedy advisory, constrained by agreed outcome | **Recommended** | Keeps information, removes the main blocker, safe while advisory |
| 4 | Remove remedy / derive it from outcome | Rejected | Loses information / misleading |
| 5 | Keep `2U > n` threshold mapping | Rejected | Arbitrary, non-monotone, counts U against the claimant |
| 6 | Threshold-free monotone mapping (section 4) | **Recommended** | Deterministic, fair to U, enables Option B safely |
| 7 | Outcome adjacency (PARTIAL ~ INCONCLUSIVE) | Rejected | Materially different statements to a user |
| 8 | Tighten P~U and P~N (Option A) | **Recommended** | Consistent with keeping N vs U material; costs liveness |
| 9 | Asymmetric conservative endorsement (Option B) | **Your decision** | Turns persistent disagreement into honest conservative results; changes what consensus means; needs lifecycle change |
| 10 | Block citation polarity conflicts | Rejected | Legitimate ambiguity; would have blocked the only agreeing pair |
| 11 | Require party-tagged citations | Rejected | Party-controlled, gameable, unfair to under-taggers |
| 12 | `prompt_comparative` / LLM judge of the leader | Deferred | Opaque comparison; extra calls against a 22 s per-call budget |
| 13 | Validator self-consistency (k samples, accept if any matches) | Rejected for MVP | Raises false agreement and latency |
| 14 | Lower temperature | Not available | `exec_prompt` has no sampling parameters in v0.2.16 |
| 15 | Rubric with tie-break towards UNRESOLVED | **Recommended** | Reduces borderline splits in a consistent, conservative direction; more INCONCLUSIVE |

### Recommended approach

Implement, in one change set: advisory remedy (3), threshold-free mapping (6), Option A
issue rules (8), rubric prompt v2 (15), schema/methodology/prompt version bumps, provenance
update, and the tests of section 8.1-8.5. Then measure on StudioNet (8.6). Decide on
Option B (9) only with that data, and only together with a lifecycle safeguard for
INCONCLUSIVE.

### How the Phase 2.8 proposals fare

| Pair | Today | Option A | Option B (leader endorsed by validator?) |
|---|---|---|---|
| r2 <-> r3 | agree | agree | agree |
| r0 (P,N) -> r2/r3 (P,U) | disagree (remedy, I2 N vs U) | disagree (I2 N vs U - genuine) | disagree (leader N stronger than validator U) |
| r2/r3 (P,U) -> r0 (P,N) | disagree | disagree | **agree** (U <= N on I2; I1 P = P, E1 shared) |
| r1 (U,U) -> any | disagree (outcome) | disagree (I1 U vs P) | **agree** -> INCONCLUSIVE stored |
| r0/r2/r3 -> r1 (U,U) | disagree | disagree | disagree (leader P stronger than validator U) |

Option A alone would not have guaranteed consensus on this deliberately ambiguous record;
the rubric change is the main lever for the I2 split, and its effect is unknown until
measured.
