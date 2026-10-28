"""Phase 2.17: the `no_reply` StudioNet fixture against the real contract, in direct mode.

Mocked model output. ``direct_vm.run_validator`` executes the contract's own
validator function on a mocked sample; it is a unit test of the agreement
rule, not a simulation of GenLayer consensus. Nothing here shows what real
models or validators will answer on this record.
"""

import sys
from pathlib import Path

import pytest

from conftest import T0, finding, payload, record_from_prompt, set_llm, warp_to

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "integration"))

from case_fixtures import FIXTURES, NO_REPLY  # noqa: E402
from harness import CASE_ARG_ORDER, EVIDENCE_ARG_ORDER  # noqa: E402

WINDOW = NO_REPLY.case["reply_window_seconds"]
DEADLINE = T0 + WINDOW  # the contract fixture deploys and creates at T0


def create_with_evidence(contract, direct_vm, claimant, respondent):
    direct_vm.sender = claimant
    case_id = contract.create_case(respondent.as_hex, *[NO_REPLY.case[k] for k in CASE_ARG_ORDER])
    for step in NO_REPLY.evidence:
        direct_vm.sender = claimant if step.party == "claimant" else respondent
        assert contract.submit_evidence(case_id, *[step.args[k] for k in EVIDENCE_ARG_ORDER]) == step.expected_id
    direct_vm.sender = claimant
    return case_id


@pytest.fixture
def expired(contract, direct_vm, claimant, respondent):
    case_id = create_with_evidence(contract, direct_vm, claimant, respondent)
    warp_to(direct_vm, DEADLINE + 1)
    contract.process_reply_deadline(case_id)
    return case_id


# -- fixture shape ---------------------------------------------------------------


def test_no_reply_fixture_has_no_reply_and_plans_deadline_processing():
    assert NO_REPLY.reply is None
    assert NO_REPLY.write_names() == [
        "no_reply.create_case", "no_reply.submit_evidence_E1", "no_reply.submit_evidence_E2",
        "no_reply.process_reply_deadline", "no_reply.request_assessment",
    ]
    assert all(e.party == "claimant" for e in NO_REPLY.evidence)  # nothing from the respondent at all
    assert WINDOW == 3600  # the contract minimum; never shortened


def test_existing_fixtures_still_plan_a_reply():
    for key in ("clear", "ambiguous"):
        names = FIXTURES[key].write_names()
        assert f"{key}.submit_reply" in names and not any("process_reply_deadline" in n for n in names)
        assert isinstance(FIXTURES[key].reply, str) and FIXTURES[key].reply


# -- deadline semantics (contract) -------------------------------------------------


@pytest.mark.parametrize("offset", [-WINDOW + 1, -1, 0])
def test_deadline_processing_before_or_at_the_deadline_is_rejected(contract, direct_vm, claimant, respondent, offset):
    case_id = create_with_evidence(contract, direct_vm, claimant, respondent)
    warp_to(direct_vm, DEADLINE + offset)
    with direct_vm.expect_revert("reply deadline has not passed"):
        contract.process_reply_deadline(case_id)
    status = contract.get_case_status(case_id)
    assert (status["status"], status["response_state"], status["snapshot_locked"]) == ("AWAITING_RESPONSE", "PENDING", False)


def test_deadline_processing_after_the_deadline_makes_the_case_assessable(contract, direct_vm, expired):
    status = contract.get_case_status(expired)
    assert status["status"] == "READY_FOR_ASSESSMENT"
    assert status["response_state"] == "NO_RESPONSE_BY_DEADLINE"
    assert (status["snapshot_locked"], status["lock_reason"]) == (True, "REPLY_WINDOW_EXPIRED")
    assert status["locked_at"] > status["reply_deadline"] == DEADLINE
    history = [h["action"] for h in contract.get_case_history(expired)]
    assert history[-2:] == ["REPLY_WINDOW_EXPIRED", "SNAPSHOT_LOCKED"]


def test_deadline_processing_is_not_repeatable(contract, direct_vm, expired):
    with direct_vm.expect_revert("case is not awaiting a response"):
        contract.process_reply_deadline(expired)


def test_no_late_reply_after_expiry(contract, direct_vm, expired, respondent):
    direct_vm.sender = respondent
    with direct_vm.expect_revert("case is not awaiting a response"):
        contract.submit_reply(expired, "Too late.")
    assert contract.get_case(expired)["reply"] == ""


# -- assessment of a no-reply case -----------------------------------------------


def test_prompt_marks_the_missing_reply_and_states_the_silence_rules(contract, direct_vm, expired, captured_prompts):
    set_llm(direct_vm, payload([finding("I1", "UNRESOLVED")], remedy="CANNOT_ASSESS"))
    contract.request_assessment(expired)
    prompt = captured_prompts[0]
    record = record_from_prompt(prompt)
    assert record["response"] == {"status": "NO_RESPONSE_BY_DEADLINE", "reply": ""}
    assert [e["submitted_by"] for e in record["evidence"]] == ["CLAIMANT", "CLAIMANT"]
    for phrase in (
        "A missing reply is NOT acceptance, admission or corroboration",
        "Silence must never itself support a finding in favour of either party.",
        "A party's own assertion never becomes established because the other party did not respond to it.",
    ):
        assert phrase in prompt, phrase


def test_unresolved_finding_gives_inconclusive_with_no_response_notice(contract, direct_vm, expired):
    # A rubric-following answer; the advisory remedy SUPPORTED contradicts INCONCLUSIVE and is replaced.
    set_llm(direct_vm, payload([finding("I1", "UNRESOLVED")], remedy="SUPPORTED"))
    assert contract.request_assessment(expired) == "INCONCLUSIVE"
    a = contract.get_assessment(expired)
    assert (a["outcome"], a["remedy_assessment"], a["response_state"]) == ("INCONCLUSIVE", "CANNOT_ASSESS", "NO_RESPONSE_BY_DEADLINE")
    assert any("procedural fact only" in n for n in a["notices"])
    assert contract.get_case(expired)["status"] == "DECIDED"


# -- the dangerous case: silence + the claimant's own word -----------------------


@pytest.mark.parametrize(
    "determination, cited, outcome",
    [
        ("SUPPORTED", ["E1"], "CLAIM_SUPPORTED"),  # the claimant's own statement only
        ("SUPPORTED", ["E2"], "CLAIM_SUPPORTED"),  # the order terms only (prove nothing about delivery)
        ("PARTIALLY_SUPPORTED", ["E1"], "CLAIM_PARTIALLY_SUPPORTED"),
    ],
)
def test_contract_accepts_a_finding_resting_on_silence_and_own_assertion(
    contract, direct_vm, expired, determination, cited, outcome
):
    """DOCUMENTED LIMITATION (Phase 2.11 H2), not a safeguard.

    The contract stores the finding, and a validator whose own sample is the same
    agrees under the agreement rule. Only validators that answer UNRESOLVED (a
    disagreement) would stop it on the network.
    """
    sample = payload([finding("I1", determination, supporting=cited)], remedy="SUPPORTED")
    set_llm(direct_vm, sample)
    assert contract.request_assessment(expired) == outcome
    stored = contract.get_assessment(expired)
    assert stored["issue_findings"][0]["supporting_evidence_ids"] == cited
    assert direct_vm.run_validator() is True  # same answer -> agreement rule satisfied
    set_llm(direct_vm, payload([finding("I1", "UNRESOLVED")], remedy="CANNOT_ASSESS"))
    assert direct_vm.run_validator() is False  # a rubric-following validator disagrees


def test_unresolved_leader_and_unresolved_validator_agree(contract, direct_vm, expired):
    set_llm(direct_vm, payload([finding("I1", "UNRESOLVED")], remedy="CANNOT_ASSESS"))
    contract.request_assessment(expired)
    set_llm(direct_vm, payload([finding("I1", "UNRESOLVED", supporting=["E1"])], remedy="SUPPORTED"))
    assert direct_vm.run_validator() is True  # citations and remedy are not compared for U/U
