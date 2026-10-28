"""Phase 2.13: the StudioNet fixtures, run through the real contract in direct mode.

Checks that each fixture is accepted by the contract exactly as the harness
will submit it (argument order, limits, evidence ids), that the documented
expected output is valid under the v2 rules, and how the agreement rules treat
the plausible alternative answers. Mocked model output: this says nothing
about what real models or validators will do.
"""

import sys
from pathlib import Path

import pytest

from conftest import T0, finding, payload, set_llm, warp_to

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "integration"))

from case_fixtures import AMBIGUOUS, CLEAR_CUT, FIXTURES  # noqa: E402
from harness import CASE_ARG_ORDER, EVIDENCE_ARG_ORDER  # noqa: E402


def build(fx, contract, direct_vm, claimant, respondent):
    """Submit the fixture in harness order, with harness argument order."""
    parties = {"claimant": claimant, "respondent": respondent}
    direct_vm.sender = claimant
    case_id = contract.create_case(respondent.as_hex, *[fx.case[k] for k in CASE_ARG_ORDER])
    for step in fx.evidence:
        direct_vm.sender = parties[step.party]
        assert contract.submit_evidence(case_id, *[step.args[k] for k in EVIDENCE_ARG_ORDER]) == step.expected_id
    if fx.reply is None:
        # Harness no-reply path: no reply; the window is expired after the real deadline.
        warp_to(direct_vm, T0 + fx.case["reply_window_seconds"] + 1)
        direct_vm.sender = claimant
        contract.process_reply_deadline(case_id)
    else:
        direct_vm.sender = respondent
        contract.submit_reply(case_id, fx.reply)
    direct_vm.sender = claimant
    return case_id


@pytest.mark.parametrize("key", sorted(FIXTURES))
def test_fixture_is_accepted_exactly_as_the_harness_submits_it(contract, direct_vm, claimant, respondent, key):
    fx = FIXTURES[key]
    case_id = build(fx, contract, direct_vm, claimant, respondent)
    case = contract.get_case(case_id)
    response = "SUBMITTED" if fx.reply is not None else "NO_RESPONSE_BY_DEADLINE"
    assert (case["status"], case["snapshot_locked"], case["response_state"]) == ("READY_FOR_ASSESSMENT", True, response)
    assert case["title"] == fx.case["title"] and fx.case["title"].startswith("[VeriCourt integration test - fictional data]")
    assert [e["evidence_id"] for e in contract.get_case_evidence(case_id)] == [e.expected_id for e in fx.evidence]
    assert fx.write_names()[0] == f"{key}.create_case" and len(fx.write_names()) == 1 + len(fx.evidence) + 2


def test_fixture_text_is_ascii():
    # genlayer-py 0.16.3 ASCII-encodes some payloads (Phase 2.8 failure).
    for fx in FIXTURES.values():
        blob = repr((fx.case, [e.args for e in fx.evidence], fx.reply or ""))
        assert blob.isascii(), fx.key


def test_ambiguous_fixture_is_the_phase_2_8_record():
    import ast

    source = (Path(__file__).resolve().parents[1] / "integration" / "test_studionet_smoke.py").read_text()
    assert "CASE = {" not in source  # the old inline record now lives only in case_fixtures
    assert AMBIGUOUS.case["issues"] == ["Export button missing", "Settings page incomplete"]
    assert AMBIGUOUS.evidence[1].args["content_ref"] == (
        "Client approved a reduced settings page on day 10; export button postponed."
    )
    assert AMBIGUOUS.reply.startswith("Fictional reply: the settings scope was reduced by agreement")
    ast.parse(source)


# -- clear-cut ---------------------------------------------------------------


def clear_expected(supporting=("E1", "E2"), determination="SUPPORTED", remedy="SUPPORTED"):
    return payload([finding("I1", determination, supporting=list(supporting))], remedy=remedy)


def test_clear_expected_output_stores_claim_supported(contract, direct_vm, claimant, respondent, captured_prompts):
    case_id = build(CLEAR_CUT, contract, direct_vm, claimant, respondent)
    set_llm(direct_vm, clear_expected())
    assert contract.request_assessment(case_id) == "CLAIM_SUPPORTED"
    stored = contract.get_assessment(case_id)
    assert [f["determination"] for f in stored["issue_findings"]] == ["SUPPORTED"]
    prompt = captured_prompts[0]
    assert "we accept that the CSV export button is not in the v1.0 build" in prompt
    assert "Known gaps: CSV export is not implemented in this release." in prompt


@pytest.mark.parametrize(
    "validator_sample, agrees",
    [
        (clear_expected(supporting=["E2"]), True),  # one shared supporting id is enough
        (clear_expected(supporting=["E1"], remedy="PARTIALLY_SUPPORTED"), True),  # remedy is not compared
        (clear_expected(supporting=["E1"], determination="PARTIALLY_SUPPORTED"), False),  # outcome differs
        (payload([finding("I1", "UNRESOLVED")], remedy="CANNOT_ASSESS"), False),
    ],
)
def test_clear_agreement_depends_on_supported_vs_partial(contract, direct_vm, claimant, respondent, validator_sample, agrees):
    """Main risk for the positive control: one PARTIALLY_SUPPORTED validator derives a different outcome."""
    case_id = build(CLEAR_CUT, contract, direct_vm, claimant, respondent)
    set_llm(direct_vm, clear_expected())
    contract.request_assessment(case_id)
    set_llm(direct_vm, validator_sample)
    assert direct_vm.run_validator() is agrees


# -- ambiguous ---------------------------------------------------------------


def test_ambiguous_rubric_output_is_inconclusive(contract, direct_vm, claimant, respondent):
    case_id = build(AMBIGUOUS, contract, direct_vm, claimant, respondent)
    set_llm(direct_vm, payload([finding("I1", "UNRESOLVED"), finding("I2", "UNRESOLVED")], remedy="CANNOT_ASSESS"))
    assert contract.request_assessment(case_id) == "INCONCLUSIVE"


@pytest.mark.parametrize(
    "leader, validator, agrees",
    [
        # Phase 2.8 proposals, re-scored under the v2 rules.
        ([("I1", "PARTIALLY_SUPPORTED", ["E1"], ["E2"]), ("I2", "UNRESOLVED", [], [])],
         [("I1", "PARTIALLY_SUPPORTED", ["E1", "E2"], []), ("I2", "UNRESOLVED", [], [])], True),
        ([("I1", "PARTIALLY_SUPPORTED", ["E1"], ["E2"]), ("I2", "UNRESOLVED", [], [])],
         [("I1", "UNRESOLVED", ["E1"], ["E2"]), ("I2", "UNRESOLVED", [], ["E2"])], False),
        ([("I1", "PARTIALLY_SUPPORTED", ["E1"], ["E2"]), ("I2", "NOT_SUPPORTED", [], ["E2"])],
         [("I1", "PARTIALLY_SUPPORTED", ["E1"], ["E2"]), ("I2", "UNRESOLVED", [], [])], False),
    ],
)
def test_ambiguous_phase_2_8_split_under_v2_rules(contract, direct_vm, claimant, respondent, leader, validator, agrees):
    def sample(rows):
        return payload([finding(i, d, supporting=s, counter=c) for i, d, s, c in rows], remedy="CANNOT_ASSESS")

    case_id = build(AMBIGUOUS, contract, direct_vm, claimant, respondent)
    set_llm(direct_vm, sample(leader))
    contract.request_assessment(case_id)
    set_llm(direct_vm, sample(validator))
    assert direct_vm.run_validator() is agrees
