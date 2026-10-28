"""Phase 2.12 hardening: H1 (advisory remedy), M2 (validator decision-only sample
validation) and H2 (silence is not proof).

Direct mode runs the leader in-process; validator logic is exercised through
direct_vm.run_validator with a swapped LLM mock. None of this proves real
validator consensus, and a prompt test does not prove a model obeys the rubric.
"""

import copy
import itertools

import pytest

from conftest import (
    DEFAULT_WINDOW,
    T0,
    case_args,
    default_payload,
    evidence_args,
    finding,
    payload,
    record_from_prompt,
    set_llm,
    warp_to,
)

S, P, N, U = "SUPPORTED", "PARTIALLY_SUPPORTED", "NOT_SUPPORTED", "UNRESOLVED"
REMEDIES = ("SUPPORTED", "PARTIALLY_SUPPORTED", "NOT_SUPPORTED", "CANNOT_ASSESS")
OUTCOMES = ("CLAIM_SUPPORTED", "CLAIM_PARTIALLY_SUPPORTED", "CLAIM_NOT_SUPPORTED", "INCONCLUSIVE")
CTX = {"case_id": "VC-000001", "issue_ids": ["I1", "I2"], "evidence_ids": ["E1", "E2", "E3"]}


def _n_u(remedy="CANNOT_ASSESS"):
    return payload([finding("I1", N, counter=["E2"]), finding("I2", U)], remedy=remedy)


def _decide_n_u(contract, direct_vm, case_id, sender):
    set_llm(direct_vm, _n_u())
    direct_vm.sender = sender
    assert contract.request_assessment(case_id) == "INCONCLUSIVE"


# -- pure helpers ----------------------------------------------------------------


@pytest.mark.parametrize("outcome, remedy", list(itertools.product(OUTCOMES, REMEDIES)))
def test_consistent_remedy_table(module, outcome, remedy):
    got = module._consistent_remedy(outcome, remedy)
    if outcome == "INCONCLUSIVE":
        assert got == "CANNOT_ASSESS"
    elif outcome == "CLAIM_NOT_SUPPORTED":
        assert got == (remedy if remedy in ("NOT_SUPPORTED", "CANNOT_ASSESS") else "CANNOT_ASSESS")
    else:
        assert got == remedy  # CLAIM_SUPPORTED / CLAIM_PARTIALLY_SUPPORTED allow any view


def test_decision_mode_returns_only_decision_fields(module):
    out = module._normalize_assessment(default_payload(), CTX, False)
    assert set(out) == {"schema_version", "case_id", "outcome", "issue_findings"}
    assert set(out["issue_findings"][0]) == {"issue_id", "determination", "supporting_evidence_ids", "counter_evidence_ids"}
    full = module._normalize_assessment(default_payload(), CTX)
    assert out["outcome"] == full["outcome"]
    assert [ (f["issue_id"], f["determination"], f["supporting_evidence_ids"], f["counter_evidence_ids"]) for f in out["issue_findings"]] == [
        (f["issue_id"], f["determination"], f["supporting_evidence_ids"], f["counter_evidence_ids"]) for f in full["issue_findings"]]


@pytest.mark.parametrize("full", [True, False])
def test_normalisation_is_idempotent_in_both_modes(module, full):
    once = module._normalize_assessment(_n_u(remedy="SUPPORTED"), CTX, full)
    assert module._normalize_assessment(once, CTX, full) == once
    if full:
        assert once["remedy_assessment"] == "CANNOT_ASSESS"


# -- H1: remedy-only inconsistency never creates disagreement or consumes attempts --


def test_validator_with_inconsistent_remedy_still_agrees(contract, direct_vm, ready_case, claimant):
    """Phase 2.11 ADV-B3 now agrees."""
    _decide_n_u(contract, direct_vm, ready_case, claimant)
    set_llm(direct_vm, _n_u(remedy="NOT_SUPPORTED"))
    assert direct_vm.run_validator() is True


def test_leader_remedy_error_is_not_agreed_on(contract, direct_vm, ready_case, claimant):
    """Phase 2.11 ADV-B4: a validator never reproduces a remedy-only error, so no attempt is recorded."""
    _decide_n_u(contract, direct_vm, ready_case, claimant)
    set_llm(direct_vm, _n_u(remedy="NOT_SUPPORTED"))
    vote = direct_vm.run_validator(
        leader_error=Exception("[LLM_ERROR] an inconclusive outcome requires remedy_assessment CANNOT_ASSESS")
    )
    assert vote is False  # disagree -> rotation; never an agreed failed attempt


def test_forged_leader_with_unreplaced_inconsistent_remedy_is_rejected(contract, direct_vm, ready_case, claimant):
    """Honest leaders emit the replaced value; a payload that skipped replacement is non-canonical."""
    _decide_n_u(contract, direct_vm, ready_case, claimant)
    leader = copy.deepcopy(direct_vm._captured_validators[-1][0])
    assert leader["remedy_assessment"] == "CANNOT_ASSESS"
    forged = copy.deepcopy(leader)
    forged["remedy_assessment"] = "NOT_SUPPORTED"
    set_llm(direct_vm, _n_u())
    assert direct_vm.run_validator(leader_result=forged) is False
    assert direct_vm.run_validator(leader_result=leader) is True


def test_invalid_remedy_value_from_leader_is_still_rejected(contract, direct_vm, ready_case, claimant):
    """Replacement covers consistency only; an unknown remedy value is still a schema error for the leader."""
    raw = default_payload()
    raw["remedy_assessment"] = "FULL_REFUND"
    set_llm(direct_vm, raw)
    direct_vm.sender = claimant
    assert contract.request_assessment(ready_case) == "ATTEMPT_FAILED"


# -- M2: validator's own sample is validated on decision fields only -----------------


@pytest.mark.parametrize(
    "mutate",
    [
        lambda d: d.__setitem__("summary", "x" * 1201),  # Phase 2.11 ADV-D1
        lambda d: d.pop("summary"),
        lambda d: d.pop("limitations"),
        lambda d: d.__setitem__("remedy_assessment", "FULL_REFUND"),
        lambda d: d.pop("remedy_assessment"),
        lambda d: d["issue_findings"][0].__setitem__("reasoning", ""),
        lambda d: d["issue_findings"][0].pop("confidence"),
        lambda d: d["issue_findings"][1].__setitem__("open_questions", ["q"] * 9),
    ],
    ids=["long_summary", "no_summary", "no_limitations", "bad_remedy_value", "no_remedy",
         "empty_reasoning", "no_confidence", "too_many_questions"],
)
def test_validator_explanatory_field_problems_do_not_block_agreement(contract, direct_vm, ready_case, claimant, mutate):
    set_llm(direct_vm, default_payload())
    direct_vm.sender = claimant
    contract.request_assessment(ready_case)
    sample = default_payload()
    mutate(sample)
    set_llm(direct_vm, sample)
    assert direct_vm.run_validator() is True


@pytest.mark.parametrize(
    "mutate",
    [
        lambda d: d["issue_findings"][0].__setitem__("supporting_evidence_ids", ["E99"]),
        lambda d: d["issue_findings"][0].pop("determination"),
        lambda d: d["issue_findings"][0].__setitem__("determination", "PROBABLY"),
        lambda d: d["issue_findings"][0].pop("counter_evidence_ids"),
        lambda d: d["issue_findings"][0].__setitem__("supporting_evidence_ids", []),  # S without support
        lambda d: d["issue_findings"].pop(),
        lambda d: d.__setitem__("outcome", "CLAIM_SUPPORTED"),
        lambda d: d.__setitem__("schema_version", "vericourt-assessment-v1"),
        lambda d: d.__setitem__("case_id", "VC-000099"),
    ],
    ids=["unknown_id", "no_determination", "bad_determination", "no_counter_list", "supported_no_citation",
         "missing_issue", "contradicting_outcome", "v1_schema_echo", "wrong_case_id"],
)
def test_validator_decision_field_problems_still_disagree(contract, direct_vm, ready_case, claimant, mutate):
    set_llm(direct_vm, default_payload())
    direct_vm.sender = claimant
    contract.request_assessment(ready_case)
    sample = default_payload()
    mutate(sample)
    set_llm(direct_vm, sample)
    assert direct_vm.run_validator() is False


def test_validator_not_supported_without_counter_citation_disagrees(contract, direct_vm, ready_case, claimant):
    """Citation rules are decision fields: enforced on the validator's own sample too."""
    _decide_n_u(contract, direct_vm, ready_case, claimant)
    sample = _n_u()
    sample["issue_findings"][0]["counter_evidence_ids"] = []
    set_llm(direct_vm, sample)
    assert direct_vm.run_validator() is False
    # Leader-error path: the same invalid sample reproduces a decision-field failure.
    assert direct_vm.run_validator(leader_error=Exception("[LLM_ERROR] I1 is NOT_SUPPORTED without counter evidence")) is True


def test_explanatory_only_leader_failure_is_not_agreed_on(contract, direct_vm, ready_case, claimant):
    """A leader that failed only on prose length: validators with valid decision fields disagree (rotate)."""
    set_llm(direct_vm, default_payload())
    direct_vm.sender = claimant
    contract.request_assessment(ready_case)
    long_summary = default_payload()
    long_summary["summary"] = "x" * 1201
    set_llm(direct_vm, long_summary)
    assert direct_vm.run_validator(leader_error=Exception("[LLM_ERROR] summary exceeds 1200 characters")) is False


def test_decision_invalid_output_is_still_agreed_as_failure(contract, direct_vm, ready_case, claimant):
    """Invalid decision fields reproduced by a validator still record a failed attempt (unchanged)."""
    set_llm(direct_vm, default_payload())
    direct_vm.sender = claimant
    contract.request_assessment(ready_case)
    bad = default_payload()
    bad["issue_findings"][0]["supporting_evidence_ids"] = ["E99"]
    set_llm(direct_vm, bad)
    assert direct_vm.run_validator(leader_error=Exception("[LLM_ERROR] unknown id")) is True


# -- H2: silence is not proof ----------------------------------------------------------


@pytest.fixture
def silent_case(contract, direct_vm, claimant, respondent):
    """No respondent reply; the claimant's only evidence is their own uncorroborated statement."""
    direct_vm.sender = claimant
    case_id = contract.create_case(**case_args(respondent, issues=["Articles never delivered"]))
    contract.submit_evidence(
        case_id,
        **evidence_args(
            evidence_type="TEXT",
            label="Claimant statement",
            description="The claimant's own account.",
            content_ref="I never received any of the articles.",
            issue_ids=["I1"],
        ),
    )
    warp_to(direct_vm, T0 + DEFAULT_WINDOW + 1)
    contract.process_reply_deadline(case_id)
    return case_id


def test_silent_case_prompt_states_silence_rules(contract, direct_vm, silent_case, claimant, captured_prompts):
    set_llm(direct_vm, payload([finding("I1", U, supporting=["E1"])], remedy="CANNOT_ASSESS"))
    direct_vm.sender = claimant
    contract.request_assessment(silent_case)
    prompt = captured_prompts[0]
    assert record_from_prompt(prompt)["response"] == {"status": "NO_RESPONSE_BY_DEADLINE", "reply": ""}
    for phrase in (
        "A missing reply is NOT acceptance, admission or corroboration, and is not evidence that the claimant's",
        "Silence must never itself support a finding in favour of either party.",
        "A party's own assertion never becomes established because the other party did not respond to it.",
        "treat every claimed fact as disputed unless the\n   other party expressly accepted it in the record.",
        "uncorroborated assertion (including when the other party did not reply)",
    ):
        assert phrase in prompt, phrase


def test_silent_case_rubric_following_output_is_inconclusive(contract, direct_vm, silent_case, claimant):
    # A model following the rubric marks the issue UNRESOLVED (citing the statement is allowed).
    set_llm(direct_vm, payload([finding("I1", U, supporting=["E1"])], remedy="SUPPORTED"))
    direct_vm.sender = claimant
    assert contract.request_assessment(silent_case) == "INCONCLUSIVE"
    a = contract.get_assessment(silent_case)
    assert a["remedy_assessment"] == "CANNOT_ASSESS"  # replaced: contradicts INCONCLUSIVE
    assert a["response_state"] == "NO_RESPONSE_BY_DEADLINE"
    assert "procedural fact only" in a["notices"][0]


def test_silent_case_outcome_derivation(module):
    assert module._derive_outcome([U]) == "INCONCLUSIVE"
    assert module._derive_outcome([U, U, U]) == "INCONCLUSIVE"


def test_silent_case_disobeying_model_is_not_blocked_by_contract(contract, direct_vm, silent_case, claimant):
    """DOCUMENTED LIMITATION, not a safeguard: the contract cannot tell a party's own statement
    from a document. A model that ignores the rubric and cites the claimant's statement as
    support is still accepted. Only validator disagreement can catch this on the network."""
    set_llm(direct_vm, payload([finding("I1", S, supporting=["E1"])], remedy="SUPPORTED"))
    direct_vm.sender = claimant
    assert contract.request_assessment(silent_case) == "CLAIM_SUPPORTED"
