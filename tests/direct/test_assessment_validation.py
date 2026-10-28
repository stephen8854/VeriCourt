"""Model-output validation. Every rejected response must record a failed
attempt (direct mode = leader path) and never store an assessment."""

import copy

import pytest

from conftest import default_payload, finding, payload, set_llm


def _mutate(fn):
    data = default_payload()
    fn(data)
    return data


def _drop(key):
    return lambda d: d.pop(key)


def _drop_finding_key(key):
    return lambda d: d["issue_findings"][0].pop(key)


def _set(key, value):
    return lambda d: d.__setitem__(key, value)


def _set_finding(key, value, index=0):
    return lambda d: d["issue_findings"][index].__setitem__(key, value)


MALFORMED = {
    # response type / JSON
    "not_json": "this is not json",
    "json_list": "[1, 2, 3]",
    "json_number": "42",
    "empty_object": "{}",
    # missing top-level fields
    "missing_summary": _mutate(_drop("summary")),
    "missing_findings": _mutate(_drop("issue_findings")),
    "missing_remedy": _mutate(_drop("remedy_assessment")),
    "missing_limitations": _mutate(_drop("limitations")),
    # missing per-issue fields
    "missing_issue_id": _mutate(_drop_finding_key("issue_id")),
    "missing_determination": _mutate(_drop_finding_key("determination")),
    "missing_confidence": _mutate(_drop_finding_key("confidence")),
    "missing_finding_text": _mutate(_drop_finding_key("finding")),
    "missing_reasoning": _mutate(_drop_finding_key("reasoning")),
    "missing_supporting": _mutate(_drop_finding_key("supporting_evidence_ids")),
    "missing_counter": _mutate(_drop_finding_key("counter_evidence_ids")),
    "missing_open_questions": _mutate(_drop_finding_key("open_questions")),
    # invalid enumerations
    "invalid_determination": _mutate(_set_finding("determination", "PROBABLY")),
    "invalid_confidence": _mutate(_set_finding("confidence", "0.9")),
    "invalid_remedy": _mutate(_set("remedy_assessment", "REFUND")),
    "determination_not_string": _mutate(_set_finding("determination", 1)),
    # wrong types / nested structures
    "findings_not_list": _mutate(_set("issue_findings", {"I1": "SUPPORTED"})),
    "finding_not_object": _mutate(_set("issue_findings", ["I1", "I2"])),
    "summary_nested": _mutate(_set("summary", {"text": "nested"})),
    "reasoning_list": _mutate(_set_finding("reasoning", ["a", "b"])),
    "limitations_string": _mutate(_set("limitations", "none")),
    "limitation_nested": _mutate(_set("limitations", [["nested"]])),
    "evidence_ids_string": _mutate(_set_finding("supporting_evidence_ids", "E1")),
    "evidence_id_number": _mutate(_set_finding("supporting_evidence_ids", [1])),
    "open_question_object": _mutate(_set_finding("open_questions", [{"q": "?"}])),
    # identifiers
    "unknown_issue": _mutate(_set_finding("issue_id", "I9")),
    "unknown_evidence": _mutate(_set_finding("supporting_evidence_ids", ["E99"])),
    "unknown_counter_evidence": _mutate(_set_finding("counter_evidence_ids", ["E4"])),
    "duplicate_evidence": _mutate(_set_finding("supporting_evidence_ids", ["E1", "E1"])),
    "evidence_both_sides": _mutate(_set_finding("counter_evidence_ids", ["E1"])),
    "wrong_case_id": _mutate(_set("case_id", "VC-000999")),
    "wrong_schema_version": _mutate(_set("schema_version", "v0")),
    "duplicate_finding": _mutate(lambda d: d["issue_findings"].append(copy.deepcopy(d["issue_findings"][0]))),
    "missing_issue_finding": _mutate(lambda d: d["issue_findings"].pop()),
    "extra_issue_finding": _mutate(lambda d: d["issue_findings"].append(finding("I3", "UNRESOLVED"))),
    # text bounds
    "empty_summary": _mutate(_set("summary", "   ")),
    "long_summary": _mutate(_set("summary", "x" * 1201)),
    "empty_reasoning": _mutate(_set_finding("reasoning", "")),
    "long_reasoning": _mutate(_set_finding("reasoning", "x" * 1501)),
    "long_finding": _mutate(_set_finding("finding", "x" * 601)),
    "control_chars": _mutate(_set_finding("finding", "bad\x00text")),
    "too_many_open_questions": _mutate(_set_finding("open_questions", ["q?"] * 6)),
    "long_open_question": _mutate(_set_finding("open_questions", ["x" * 301])),
    "too_many_limitations": _mutate(_set("limitations", ["l"] * 6)),
    "empty_limitation": _mutate(_set("limitations", [""])),
    # fairness / consistency rules
    "supported_without_evidence": _mutate(_set_finding("supporting_evidence_ids", [])),
    "partial_without_evidence": _mutate(_set_finding("supporting_evidence_ids", [], index=1)),
    "not_supported_without_counter": payload(
        [finding("I1", "NOT_SUPPORTED", supporting=["E1"]), finding("I2", "NOT_SUPPORTED", counter=["E2"])],
        remedy="NOT_SUPPORTED",
    ),
    "outcome_contradicts_findings": _mutate(_set("outcome", "CLAIM_SUPPORTED")),
    # The remedy is advisory: an invalid VALUE or a missing field is still rejected
    # (see invalid_remedy / missing_remedy above), but an inconsistent one is replaced.
}


# Phase 2.12 (H1): a remedy that contradicts the derived outcome is replaced by
# CANNOT_ASSESS deterministically. It no longer fails the assessment.
REMEDY_REPLACED = {
    "inconclusive_with_supported_remedy": (
        payload([finding("I1", "UNRESOLVED"), finding("I2", "UNRESOLVED")], remedy="SUPPORTED"),
        "INCONCLUSIVE",
    ),
    "not_supported_with_partial_remedy": (
        payload(
            [finding("I1", "NOT_SUPPORTED", counter=["E2"]), finding("I2", "NOT_SUPPORTED", counter=["E2"])],
            remedy="PARTIALLY_SUPPORTED",
        ),
        "CLAIM_NOT_SUPPORTED",
    ),
}


@pytest.mark.parametrize("name", sorted(REMEDY_REPLACED))
def test_inconsistent_remedy_is_replaced_not_rejected(contract, direct_vm, ready_case, claimant, name):
    raw, outcome = REMEDY_REPLACED[name]
    set_llm(direct_vm, raw)
    direct_vm.sender = claimant
    assert contract.request_assessment(ready_case) == outcome
    a = contract.get_assessment(ready_case)
    assert a["remedy_assessment"] == "CANNOT_ASSESS"
    case = contract.get_case(ready_case)
    assert (case["status"], case["assessment_attempts"], case["last_assessment_error"]) == ("DECIDED", 1, "")


@pytest.mark.parametrize("name", sorted(MALFORMED))
def test_malformed_output_is_rejected(contract, direct_vm, ready_case, claimant, name):
    set_llm(direct_vm, MALFORMED[name])
    direct_vm.sender = claimant
    assert contract.request_assessment(ready_case) == "ATTEMPT_FAILED"
    assert contract.get_assessment(ready_case)["exists"] is False
    case = contract.get_case(ready_case)
    assert case["status"] == "READY_FOR_ASSESSMENT"
    assert case["assessment_attempts"] == 1
    assert case["last_assessment_error"] == "INVALID_MODEL_OUTPUT"


ACCEPTED = {
    "lowercase_tokens": _mutate(lambda d: [f.__setitem__("confidence", "high") for f in d["issue_findings"]]),
    "lowercase_ids": _mutate(_set_finding("supporting_evidence_ids", ["e1"])),
    "hyphenated_token": _mutate(_set_finding("determination", "partially-supported", index=1)),
    "matching_outcome": _mutate(_set("outcome", "CLAIM_PARTIALLY_SUPPORTED")),
    "matching_case_id": _mutate(_set("case_id", "VC-000001")),
    "boundary_lengths": _mutate(
        lambda d: (
            d.__setitem__("summary", "s" * 1200),
            d["issue_findings"][0].__setitem__("reasoning", "r" * 1500),
            d["issue_findings"][0].__setitem__("finding", "f" * 600),
            d["issue_findings"][0].__setitem__("open_questions", ["q" * 300] * 5),
            d.__setitem__("limitations", ["l" * 300] * 5),
        )
    ),
    "no_limitations": _mutate(_set("limitations", [])),
}


@pytest.mark.parametrize("name", sorted(ACCEPTED))
def test_permissible_variations_are_accepted(contract, direct_vm, ready_case, claimant, name):
    set_llm(direct_vm, ACCEPTED[name])
    direct_vm.sender = claimant
    assert contract.request_assessment(ready_case) == "CLAIM_PARTIALLY_SUPPORTED"
    assert contract.get_assessment(ready_case)["exists"] is True


def test_evidence_ids_are_canonically_ordered(contract, direct_vm, ready_case, claimant):
    set_llm(
        direct_vm,
        payload(
            [
                finding("I1", "SUPPORTED", supporting=["E3", "E1"], counter=["E2"]),
                finding("I2", "PARTIALLY_SUPPORTED", supporting=["E3"]),
            ]
        ),
    )
    direct_vm.sender = claimant
    contract.request_assessment(ready_case)
    assert contract.get_assessment(ready_case)["issue_findings"][0]["supporting_evidence_ids"] == ["E1", "E3"]


# -- outcome derivation (pure helper) ----------------------------------------

S, P, N, U = "SUPPORTED", "PARTIALLY_SUPPORTED", "NOT_SUPPORTED", "UNRESOLVED"


@pytest.mark.parametrize(
    "dets, expected",
    [
        ([S], "CLAIM_SUPPORTED"),
        ([S, S, S], "CLAIM_SUPPORTED"),
        ([P], "CLAIM_PARTIALLY_SUPPORTED"),
        ([S, P], "CLAIM_PARTIALLY_SUPPORTED"),
        ([S, N], "CLAIM_PARTIALLY_SUPPORTED"),
        ([S, U], "CLAIM_PARTIALLY_SUPPORTED"),
        ([N], "CLAIM_NOT_SUPPORTED"),
        ([N, N], "CLAIM_NOT_SUPPORTED"),
        # v2: UNRESOLVED never counts against the claimant (v1 gave CLAIM_NOT_SUPPORTED).
        ([N, N, U], "INCONCLUSIVE"),
        ([N, U], "INCONCLUSIVE"),
        ([U], "INCONCLUSIVE"),
        # v2: no 2U > n threshold; one established issue is partial support (v1 gave INCONCLUSIVE).
        ([S, U, U], "CLAIM_PARTIALLY_SUPPORTED"),
        ([U, U, N, N, S], "CLAIM_PARTIALLY_SUPPORTED"),
        ([U, U, U, S, S], "CLAIM_PARTIALLY_SUPPORTED"),
        ([], "INCONCLUSIVE"),
    ],
)
def test_outcome_derivation(module, dets, expected):
    assert module._derive_outcome(dets) == expected
