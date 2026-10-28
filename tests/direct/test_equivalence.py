"""Validator equivalence, exercised through direct_vm.run_validator.

Direct mode runs only the leader during the contract call. run_validator then
invokes the captured validator_fn, which re-runs the assessment against the
*current* LLM mock, so swapping the mock simulates a validator's independent
model call. This tests the validator's logic only; it is not consensus.
"""

import copy

import pytest

from conftest import default_payload, finding, payload, set_llm


def _decide(contract, direct_vm, case_id, sender):
    set_llm(direct_vm, default_payload())
    direct_vm.sender = sender
    contract.request_assessment(case_id)
    return copy.deepcopy(direct_vm._captured_validators[-1][0])  # leader's normalised result


def test_validator_agrees_with_identical_answer(contract, direct_vm, ready_case, claimant):
    _decide(contract, direct_vm, ready_case, claimant)
    assert direct_vm.run_validator() is True


def test_validator_accepts_presentation_differences(contract, direct_vm, ready_case, claimant):
    _decide(contract, direct_vm, ready_case, claimant)
    variant = payload(
        [
            finding(
                "I2",
                "partially supported",
                supporting=["E3"],
                confidence="LOW",
                finding="Different wording.",
                reasoning="Entirely different prose.",
                open_questions=["When was the fix delivered?"],
            ),
            finding("I1", "SUPPORTED", supporting=["E1", "E3"], counter=[], confidence="HIGH"),
        ],
        summary="Another neutral summary.",
        limitations=[],
    )
    set_llm(direct_vm, variant)
    assert direct_vm.run_validator() is True


def test_validator_accepts_adjacent_determinations(contract, direct_vm, ready_case, claimant):
    # Leader: [SUPPORTED, PARTIALLY_SUPPORTED]; validator: [PARTIALLY_SUPPORTED, SUPPORTED].
    _decide(contract, direct_vm, ready_case, claimant)
    set_llm(
        direct_vm,
        payload([finding("I1", "PARTIALLY_SUPPORTED", supporting=["E1"]), finding("I2", "SUPPORTED", supporting=["E3"])]),
    )
    assert direct_vm.run_validator() is True


@pytest.mark.parametrize("remedy", ["SUPPORTED", "PARTIALLY_SUPPORTED", "NOT_SUPPORTED", "CANNOT_ASSESS"])
def test_validator_ignores_remedy_when_findings_identical(contract, direct_vm, ready_case, claimant, remedy):
    """v2: the remedy is advisory and never compared across validators."""
    leader = _decide(contract, direct_vm, ready_case, claimant)
    assert leader["remedy_assessment"] == "PARTIALLY_SUPPORTED"
    variant = default_payload()
    variant["remedy_assessment"] = remedy
    set_llm(direct_vm, variant)
    assert direct_vm.run_validator() is True
    # The stored remedy is the leader's, whatever the validators' view.
    assert contract.get_assessment(ready_case)["remedy_assessment"] == "PARTIALLY_SUPPORTED"


def test_validator_rejects_different_outcome(contract, direct_vm, ready_case, claimant):
    _decide(contract, direct_vm, ready_case, claimant)
    set_llm(
        direct_vm,
        payload([finding("I1", "SUPPORTED", supporting=["E1"]), finding("I2", "SUPPORTED", supporting=["E3"])], remedy="SUPPORTED"),
    )
    assert direct_vm.run_validator() is False


def test_validator_rejects_opposite_issue_with_same_outcome(contract, direct_vm, ready_case, claimant):
    # Both outcomes are CLAIM_PARTIALLY_SUPPORTED, but I1 flips SUPPORTED -> NOT_SUPPORTED.
    _decide(contract, direct_vm, ready_case, claimant)
    set_llm(
        direct_vm,
        payload([finding("I1", "NOT_SUPPORTED", counter=["E2"]), finding("I2", "SUPPORTED", supporting=["E3"])]),
    )
    assert direct_vm.run_validator() is False


def test_validator_rejects_supported_vs_unresolved(contract, direct_vm, ready_case, claimant):
    _decide(contract, direct_vm, ready_case, claimant)
    set_llm(
        direct_vm,
        payload([finding("I1", "UNRESOLVED"), finding("I2", "PARTIALLY_SUPPORTED", supporting=["E3"])]),
    )
    assert direct_vm.run_validator() is False


def test_remedy_difference_does_not_mask_finding_disagreement(contract, direct_vm, ready_case, claimant):
    """Ignoring the remedy must not let a material finding difference through."""
    _decide(contract, direct_vm, ready_case, claimant)
    variant = payload(
        [finding("I1", "SUPPORTED", supporting=["E1"]), finding("I2", "UNRESOLVED")],
        remedy="PARTIALLY_SUPPORTED",
    )
    set_llm(direct_vm, variant)
    assert direct_vm.run_validator() is False


def test_validator_rejects_tampered_leader_payload(contract, direct_vm, ready_case, claimant):
    leader = _decide(contract, direct_vm, ready_case, claimant)
    set_llm(direct_vm, default_payload())

    unknown_evidence = copy.deepcopy(leader)
    unknown_evidence["issue_findings"][0]["supporting_evidence_ids"] = ["E9"]
    assert direct_vm.run_validator(leader_result=unknown_evidence) is False

    forged_outcome = copy.deepcopy(leader)
    forged_outcome["outcome"] = "CLAIM_SUPPORTED"
    assert direct_vm.run_validator(leader_result=forged_outcome) is False

    non_canonical = copy.deepcopy(leader)
    non_canonical["summary"] = "  padded  "
    assert direct_vm.run_validator(leader_result=non_canonical) is False

    wrong_case = copy.deepcopy(leader)
    wrong_case["case_id"] = "VC-000002"
    assert direct_vm.run_validator(leader_result=wrong_case) is False

    assert direct_vm.run_validator(leader_result="not a dict") is False
    assert direct_vm.run_validator(leader_result=leader) is True


def test_validator_disagrees_when_its_own_model_output_is_invalid(contract, direct_vm, ready_case, claimant):
    _decide(contract, direct_vm, ready_case, claimant)
    set_llm(direct_vm, "garbage")
    assert direct_vm.run_validator() is False


def test_validator_disagrees_when_its_own_model_call_fails(contract, direct_vm, ready_case, claimant):
    _decide(contract, direct_vm, ready_case, claimant)
    direct_vm.clear_mocks()
    assert direct_vm.run_validator() is False


def test_validator_agrees_on_shared_invalid_output(contract, direct_vm, ready_case, claimant):
    """Leader and validator both independently get invalid output -> agree (attempt recorded)."""
    _decide(contract, direct_vm, ready_case, claimant)
    set_llm(direct_vm, "garbage")
    assert direct_vm.run_validator(leader_error=Exception("[LLM_ERROR] response is not a JSON object")) is True


def test_validator_rejects_leader_llm_error_when_it_succeeds(contract, direct_vm, ready_case, claimant):
    """Leader claims invalid output but this validator gets a valid answer -> rotate leader."""
    _decide(contract, direct_vm, ready_case, claimant)
    set_llm(direct_vm, default_payload())
    assert direct_vm.run_validator(leader_error=Exception("[LLM_ERROR] response is not a JSON object")) is False


def test_validator_never_agrees_on_transient_or_other_errors(contract, direct_vm, ready_case, claimant):
    _decide(contract, direct_vm, ready_case, claimant)
    for mock in ("garbage", None):
        if mock is None:
            direct_vm.clear_mocks()
        else:
            set_llm(direct_vm, mock)
        assert direct_vm.run_validator(leader_error=Exception("[TRANSIENT] model call failed")) is False
        assert direct_vm.run_validator(leader_error=Exception("[EXPECTED] something")) is False
        assert direct_vm.run_validator(leader_error=Exception("vm error: exit_code 1")) is False


def _f(issue_id, determination, supporting=(), counter=()):
    return {
        "issue_id": issue_id,
        "determination": determination,
        "supporting_evidence_ids": list(supporting),
        "counter_evidence_ids": list(counter),
    }


def test_equivalence_helper_is_symmetric(module):
    a = {
        "outcome": "CLAIM_PARTIALLY_SUPPORTED",
        "remedy_assessment": "PARTIALLY_SUPPORTED",
        "issue_findings": [_f("I1", "SUPPORTED", supporting=["E1"]), _f("I2", "UNRESOLVED", counter=["E2"])],
    }
    b = {
        "outcome": "CLAIM_PARTIALLY_SUPPORTED",
        "remedy_assessment": "CANNOT_ASSESS",  # remedy differences are not compared
        "issue_findings": [
            _f("I1", "PARTIALLY_SUPPORTED", supporting=["E1", "E2"]),
            _f("I2", "UNRESOLVED"),
        ],
    }
    assert module._assessments_equivalent(a, b) is True
    assert module._assessments_equivalent(b, a) is True
    c = copy.deepcopy(b)
    c["issue_findings"] = c["issue_findings"][:1]
    assert module._assessments_equivalent(a, c) is False
    assert module._assessments_equivalent(c, a) is False
    d = copy.deepcopy(b)
    d["outcome"] = "INCONCLUSIVE"
    assert module._assessments_equivalent(a, d) is False


# -- issue-level agreement table (Phase 2.9 Option A), pure helper ------------

S, P, N, U = "SUPPORTED", "PARTIALLY_SUPPORTED", "NOT_SUPPORTED", "UNRESOLVED"

# Independent statement of the approved table: (leader, validator) -> rule.
#   "always"     agree regardless of citations
#   "supporting" agree only if supporting_evidence_ids share an id
#   "counter"    agree only if counter_evidence_ids share an id
#   "never"      always disagree
TABLE = {
    (S, S): "supporting", (S, P): "supporting", (S, N): "never", (S, U): "never",
    (P, S): "supporting", (P, P): "supporting", (P, N): "never", (P, U): "never",
    (N, S): "never", (N, P): "never", (N, N): "counter", (N, U): "never",
    (U, S): "never", (U, P): "never", (U, N): "never", (U, U): "always",
}


def _finding_for(det, shared):
    """A validated-looking finding; `shared` controls whether its citations overlap the other side."""
    ev = "E1" if shared else "E9"
    if det in (S, P):
        return _f("I1", det, supporting=[ev], counter=["E5"])
    if det == N:
        return _f("I1", det, supporting=["E6"], counter=[ev])
    return _f("I1", det, supporting=[ev], counter=["E5"])  # UNRESOLVED may cite items


def test_table_covers_all_sixteen_pairs():
    assert set(TABLE) == {(a, b) for a in (S, P, N, U) for b in (S, P, N, U)}
    for (a, b), rule in TABLE.items():
        assert TABLE[(b, a)] == rule  # Option A is symmetric


@pytest.mark.parametrize("pair", sorted(TABLE))
@pytest.mark.parametrize("shared", [True, False])
def test_findings_agree_matches_table(module, pair, shared):
    leader_det, validator_det = pair
    rule = TABLE[pair]
    leader = _finding_for(leader_det, shared=True)
    validator = _finding_for(validator_det, shared=shared)
    expected = {"always": True, "never": False}.get(rule, shared)
    assert module._findings_agree(leader, validator) is expected
    assert module._findings_agree(validator, leader) is expected


def test_overlap_must_be_in_the_list_for_the_direction(module):
    # Same id shared only in the *other* list does not count.
    a = _f("I1", S, supporting=["E1"], counter=["E2"])
    b = _f("I1", P, supporting=["E3"], counter=["E2"])
    assert module._findings_agree(a, b) is False
    c = _f("I1", N, supporting=["E1"], counter=["E2"])
    d = _f("I1", N, supporting=["E1"], counter=["E3"])
    assert module._findings_agree(c, d) is False


def test_conflicting_evidence_both_unresolved_agrees(module):
    """Claimant and respondent evidence conflict; both validators decline to decide."""
    a = _f("I1", U, supporting=["E1"], counter=["E2"])
    b = _f("I1", U)
    assert module._findings_agree(a, b) is True


# -- evidence-citation agreement through the real validator -------------------


def test_validator_rejects_same_determinations_with_disjoint_support(contract, direct_vm, ready_case, claimant):
    # Leader: I1 SUPPORTED citing E1; validator: I1 SUPPORTED citing only E3.
    _decide(contract, direct_vm, ready_case, claimant)
    set_llm(
        direct_vm,
        payload([finding("I1", "SUPPORTED", supporting=["E3"]), finding("I2", "PARTIALLY_SUPPORTED", supporting=["E3"])]),
    )
    assert direct_vm.run_validator() is False


def test_validator_rejects_disjoint_support_on_second_issue(contract, direct_vm, ready_case, claimant):
    _decide(contract, direct_vm, ready_case, claimant)
    set_llm(
        direct_vm,
        payload([finding("I1", "SUPPORTED", supporting=["E1"]), finding("I2", "PARTIALLY_SUPPORTED", supporting=["E1"])]),
    )
    assert direct_vm.run_validator() is False


def test_validator_rejects_partial_vs_not_supported_even_with_shared_evidence(contract, direct_vm, ready_case, claimant):
    # v2: direction is material. Leader I2 PARTIALLY_SUPPORTED citing E3; validator I2
    # NOT_SUPPORTED citing E3 as counter. Same outcome, same evidence item - still disagree.
    _decide(contract, direct_vm, ready_case, claimant)
    set_llm(
        direct_vm,
        payload([finding("I1", "SUPPORTED", supporting=["E1"]), finding("I2", "NOT_SUPPORTED", counter=["E3"])]),
    )
    assert direct_vm.run_validator() is False


def test_validator_rejects_partial_vs_not_supported_without_shared_evidence(contract, direct_vm, ready_case, claimant):
    _decide(contract, direct_vm, ready_case, claimant)
    set_llm(
        direct_vm,
        payload([finding("I1", "SUPPORTED", supporting=["E1"]), finding("I2", "NOT_SUPPORTED", counter=["E2"])]),
    )
    assert direct_vm.run_validator() is False


def test_validator_rejects_partial_vs_unresolved(contract, direct_vm, ready_case, claimant):
    # v2: definiteness is material. Leader I2 PARTIALLY_SUPPORTED; validator I2 UNRESOLVED.
    _decide(contract, direct_vm, ready_case, claimant)
    set_llm(direct_vm, payload([finding("I1", "SUPPORTED", supporting=["E1"]), finding("I2", "UNRESOLVED")]))
    assert direct_vm.run_validator() is False


def test_validator_rejects_not_supported_vs_unresolved_both_ways(contract, direct_vm, module, claimant, respondent):
    """NOT_SUPPORTED (evidence against) and UNRESOLVED (no basis) stay materially different."""
    from conftest import case_args, evidence_args

    direct_vm.sender = claimant
    case_id = contract.create_case(**case_args(respondent, issues=["Only issue"]))
    direct_vm.sender = respondent
    contract.submit_evidence(case_id, **evidence_args(label="Delivery log", issue_ids=["I1"]))
    contract.submit_reply(case_id, "Delivered on time.")

    not_supported = payload([finding("I1", "NOT_SUPPORTED", counter=["E1"])], remedy="NOT_SUPPORTED")
    unresolved = payload([finding("I1", "UNRESOLVED", counter=["E1"])], remedy="CANNOT_ASSESS")

    set_llm(direct_vm, not_supported)
    direct_vm.sender = claimant
    assert contract.request_assessment(case_id) == "CLAIM_NOT_SUPPORTED"
    set_llm(direct_vm, unresolved)
    assert direct_vm.run_validator() is False
    leader_unresolved = copy.deepcopy(direct_vm._captured_validators[-1][0])
    leader_unresolved["outcome"] = "INCONCLUSIVE"
    leader_unresolved["remedy_assessment"] = "CANNOT_ASSESS"
    leader_unresolved["issue_findings"][0]["determination"] = "UNRESOLVED"
    # The hand-built leader must be canonical, so a rejection can only come from N vs U.
    ctx = {"case_id": case_id, "issue_ids": ["I1"], "evidence_ids": ["E1"]}
    assert module._normalize_assessment(leader_unresolved, ctx) == leader_unresolved
    set_llm(direct_vm, not_supported)
    assert direct_vm.run_validator(leader_result=leader_unresolved) is False


def test_validator_counter_overlap_for_not_supported(contract, direct_vm, ready_case, claimant):
    leader = payload(
        [finding("I1", "NOT_SUPPORTED", counter=["E2"]), finding("I2", "NOT_SUPPORTED", counter=["E2"])],
        remedy="NOT_SUPPORTED",
    )
    set_llm(direct_vm, leader)
    direct_vm.sender = claimant
    assert contract.request_assessment(ready_case) == "CLAIM_NOT_SUPPORTED"

    set_llm(
        direct_vm,
        payload(
            [finding("I1", "NOT_SUPPORTED", counter=["E2", "E3"]), finding("I2", "NOT_SUPPORTED", counter=["E2"])],
            remedy="NOT_SUPPORTED",
        ),
    )
    assert direct_vm.run_validator() is True
    set_llm(
        direct_vm,
        payload(
            [finding("I1", "NOT_SUPPORTED", counter=["E3"]), finding("I2", "NOT_SUPPORTED", counter=["E2"])],
            remedy="NOT_SUPPORTED",
        ),
    )
    assert direct_vm.run_validator() is False


def test_leader_citation_of_unknown_id_is_rejected_before_overlap(contract, direct_vm, ready_case, claimant):
    """Overlap is only computed on normalised findings: an unknown leader id fails first."""
    leader = _decide(contract, direct_vm, ready_case, claimant)
    forged = copy.deepcopy(leader)
    forged["issue_findings"][0]["supporting_evidence_ids"] = ["E1", "E99"]
    set_llm(direct_vm, default_payload())
    assert direct_vm.run_validator(leader_result=forged) is False


# -- validator failures never count as agreement ------------------------------


def test_leader_invalid_output_and_validator_call_fails(contract, direct_vm, ready_case, claimant):
    """Leader reports [LLM_ERROR]; this validator's own model call fails transiently.

    The validator must disagree. Agreement here is the only way a failed attempt
    is recorded on-chain, so disagreeing guarantees an infrastructure failure on
    the validator side cannot consume an attempt.
    """
    _decide(contract, direct_vm, ready_case, claimant)
    direct_vm.clear_mocks()  # validator's exec_prompt raises -> [TRANSIENT]
    before = (contract.get_case(ready_case), contract.get_assessment_status(ready_case))
    assert direct_vm.run_validator(leader_error=Exception("[LLM_ERROR] response is not a JSON object")) is False
    # The validator function has no side effects on contract state.
    assert (contract.get_case(ready_case), contract.get_assessment_status(ready_case)) == before
