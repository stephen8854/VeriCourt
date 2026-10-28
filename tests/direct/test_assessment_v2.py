"""Phase 2.10 (assessment v2) behaviour through the real contract methods.

Direct mode: the leader path runs in-process with mocked LLM output. These tests
cover contract validation and derivation only; they say nothing about real
validator consensus.
"""

from conftest import default_payload, finding, payload, set_llm

# ready_case: issues I1, I2; evidence E1 (claimant, I1), E2 (respondent, I1), E3 (claimant TEXT, I2).


# -- outcome is derived by the contract ---------------------------------------


def test_not_supported_plus_unresolved_is_stored_as_inconclusive(contract, direct_vm, ready_case, claimant):
    set_llm(
        direct_vm,
        payload([finding("I1", "NOT_SUPPORTED", counter=["E2"]), finding("I2", "UNRESOLVED")], remedy="CANNOT_ASSESS"),
    )
    direct_vm.sender = claimant
    assert contract.request_assessment(ready_case) == "INCONCLUSIVE"
    assert contract.get_assessment(ready_case)["outcome"] == "INCONCLUSIVE"


def test_model_cannot_choose_claim_not_supported_with_unresolved_issue(contract, direct_vm, ready_case, claimant):
    raw = payload(
        [finding("I1", "NOT_SUPPORTED", counter=["E2"]), finding("I2", "UNRESOLVED")],
        remedy="CANNOT_ASSESS",
        outcome="CLAIM_NOT_SUPPORTED",
    )
    set_llm(direct_vm, raw)
    direct_vm.sender = claimant
    assert contract.request_assessment(ready_case) == "ATTEMPT_FAILED"
    assert contract.get_assessment(ready_case)["exists"] is False


def test_model_omitting_outcome_gets_the_derived_one(contract, direct_vm, ready_case, claimant):
    raw = payload([finding("I1", "SUPPORTED", supporting=["E1"]), finding("I2", "UNRESOLVED")])
    assert "outcome" not in raw
    set_llm(direct_vm, raw)
    direct_vm.sender = claimant
    assert contract.request_assessment(ready_case) == "CLAIM_PARTIALLY_SUPPORTED"


def test_all_not_supported_is_stored_as_claim_not_supported(contract, direct_vm, ready_case, claimant):
    set_llm(
        direct_vm,
        payload(
            [finding("I1", "NOT_SUPPORTED", counter=["E2"]), finding("I2", "NOT_SUPPORTED", counter=["E2"])],
            remedy="NOT_SUPPORTED",
        ),
    )
    direct_vm.sender = claimant
    assert contract.request_assessment(ready_case) == "CLAIM_NOT_SUPPORTED"


# -- remedy: advisory but consistent with the derived outcome -----------------


def test_inconsistent_remedy_for_inconclusive_is_replaced(contract, direct_vm, ready_case, claimant):
    # Phase 2.11 H1 counterexample. v2 derives INCONCLUSIVE for [N, U]; the "natural"
    # advisory view NOT_SUPPORTED contradicts it. Phase 2.12: replaced by CANNOT_ASSESS,
    # the assessment is stored, and no failed attempt is recorded.
    raw = payload([finding("I1", "NOT_SUPPORTED", counter=["E2"]), finding("I2", "UNRESOLVED")], remedy="NOT_SUPPORTED")
    set_llm(direct_vm, raw)
    direct_vm.sender = claimant
    assert contract.request_assessment(ready_case) == "INCONCLUSIVE"
    assert contract.get_assessment(ready_case)["remedy_assessment"] == "CANNOT_ASSESS"
    case = contract.get_case(ready_case)
    assert (case["status"], case["assessment_attempts"], case["last_assessment_error"]) == ("DECIDED", 1, "")


def test_remedy_only_inconsistency_cannot_reach_assessment_failed(contract, direct_vm, claimant, respondent):
    """The Phase 2.11 ADV-B5 path: two remedy-only problems used to end the case terminally."""
    from conftest import case_args, evidence_args

    for _ in range(2):
        direct_vm.sender = claimant
        cid = contract.create_case(**case_args(respondent))
        direct_vm.sender = respondent
        contract.submit_evidence(cid, **evidence_args(label="Change note", issue_ids=["I1"]))
        contract.submit_reply(cid, "Reply.")
        set_llm(
            direct_vm,
            payload([finding("I1", "NOT_SUPPORTED", counter=["E1"]), finding("I2", "UNRESOLVED")], remedy="SUPPORTED"),
        )
        direct_vm.sender = claimant
        assert contract.request_assessment(cid) == "INCONCLUSIVE"
        assert contract.get_case(cid)["status"] == "DECIDED"


def test_claim_supported_allows_any_remedy_view(contract, direct_vm, ready_case, claimant):
    # Issues can be established while the requested remedy is disproportionate.
    set_llm(
        direct_vm,
        payload(
            [finding("I1", "SUPPORTED", supporting=["E1"]), finding("I2", "SUPPORTED", supporting=["E3"])],
            remedy="NOT_SUPPORTED",
        ),
    )
    direct_vm.sender = claimant
    assert contract.request_assessment(ready_case) == "CLAIM_SUPPORTED"
    assert contract.get_assessment(ready_case)["remedy_assessment"] == "NOT_SUPPORTED"


# -- versions and prompt -------------------------------------------------------


def test_version_identifiers(contract, direct_vm, ready_case, claimant):
    info = contract.get_contract_info()
    assert info["schema_version"] == "vericourt-case-v1"  # case record unchanged
    assert info["assessment"]["schema_version"] == "vericourt-assessment-v2"
    assert info["assessment"]["methodology_version"] == "vericourt-method-v2"
    assert contract.get_assessment_status(ready_case)["schema_version"] == "vericourt-assessment-v2"
    set_llm(direct_vm, default_payload())
    direct_vm.sender = claimant
    contract.request_assessment(ready_case)
    stored = contract.get_assessment(ready_case)
    assert (stored["schema_version"], stored["methodology_version"]) == (
        "vericourt-assessment-v2",
        "vericourt-method-v2",
    )


def test_model_echoing_v1_schema_version_is_rejected(contract, direct_vm, ready_case, claimant):
    set_llm(direct_vm, payload(default_payload()["issue_findings"], schema_version="vericourt-assessment-v1"))
    direct_vm.sender = claimant
    assert contract.request_assessment(ready_case) == "ATTEMPT_FAILED"


def test_prompt_is_v2_with_rubric(contract, direct_vm, ready_case, claimant, captured_prompts):
    set_llm(direct_vm, default_payload())
    direct_vm.sender = claimant
    contract.request_assessment(ready_case)
    prompt = captured_prompts[0]
    assert prompt.startswith("VERICOURT_ASSESSMENT_V2\n")
    assert "VERICOURT_ASSESSMENT_V1" not in prompt
    for phrase in (
        "For EACH issue, follow these steps:",
        "They are context, not evidence",
        "An uncorroborated own assertion by either party does not establish a fact.",
        "This holds whether or not the other party replied",
        "A missing reply is NOT acceptance, admission or corroboration",
        "Silence must never itself support a finding in favour of either party.",
        "A party's own assertion never becomes established because the other party did not respond to it.",
        "When the evidence does not sufficiently support a finding, use UNRESOLVED.",
        "(including when the other party did not reply)",
        "Otherwise the contract replaces it with",
        "If you are unsure between a definite determination and UNRESOLVED, choose UNRESOLVED.",
        "A missing reply is not proof that the claim is true.",
        "A missing reply is a procedural fact only",
        "Overall outcome (computed by the contract from your determinations; do not choose it):",
        "Remedy (advisory, separate from the issue findings):",
        "It does not change any finding.",
        "Never put the same id in both lists.",
        "Respond with one JSON object and nothing else:",
    ):
        assert phrase in prompt, phrase
    # The remedy heuristic tied to the old 2U > n threshold is gone.
    assert "when most issues are UNRESOLVED" not in prompt


# -- documented limitations (these pass validation by design) ------------------


def test_valid_but_irrelevant_citation_passes_validation(contract, direct_vm, ready_case, claimant):
    """E3 (a chat log about mobile fixes, tagged I2) cited for I1: the contract cannot judge relevance."""
    set_llm(
        direct_vm,
        payload([finding("I1", "SUPPORTED", supporting=["E3"]), finding("I2", "UNRESOLVED")], remedy="PARTIALLY_SUPPORTED"),
    )
    direct_vm.sender = claimant
    assert contract.request_assessment(ready_case) == "CLAIM_PARTIALLY_SUPPORTED"
    a = contract.get_assessment(ready_case)
    assert a["issue_findings"][0]["supporting_evidence_ids"] == ["E3"]
    assert "relevant" in a["provenance"]["partially_checked"]["issue_findings[].supporting_evidence_ids"]


def test_semantically_inconsistent_prose_passes_validation(contract, direct_vm, ready_case, claimant):
    """Determination SUPPORTED with reasoning saying the opposite: prose is not checked."""
    raw = default_payload()
    raw["issue_findings"][0]["reasoning"] = "The evidence does not support the claimant on this issue."
    set_llm(direct_vm, raw)
    direct_vm.sender = claimant
    assert contract.request_assessment(ready_case) == "CLAIM_PARTIALLY_SUPPORTED"
    a = contract.get_assessment(ready_case)
    assert "issue_findings[].reasoning" in a["provenance"]["leader_generated_unverified"]
