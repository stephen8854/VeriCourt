import pytest

from conftest import DEFAULT_WINDOW, T0, evidence_args, warp_to


def _snapshot(contract, case_id):
    return (
        contract.get_case(case_id),
        contract.get_case_evidence(case_id),
        contract.get_case_history(case_id),
    )


@pytest.mark.parametrize("who", ["claimant", "respondent"])
def test_deadline_expiry_by_either_party(contract, direct_vm, open_case, request, who):
    warp_to(direct_vm, T0 + DEFAULT_WINDOW + 1)
    direct_vm.sender = request.getfixturevalue(who)
    contract.process_reply_deadline(open_case)

    case = contract.get_case(open_case)
    assert case["status"] == "READY_FOR_ASSESSMENT"
    assert case["response_state"] == "NO_RESPONSE_BY_DEADLINE"
    assert case["snapshot_locked"] is True
    assert case["lock_reason"] == "REPLY_WINDOW_EXPIRED"
    assert case["locked_at"] == T0 + DEFAULT_WINDOW + 1
    assert case["reply"] == ""

    actions = [h["action"] for h in contract.get_case_history(open_case)]
    assert actions[-2:] == ["REPLY_WINDOW_EXPIRED", "SNAPSHOT_LOCKED"]
    expiry = contract.get_case_history(open_case)[-2]
    assert "not proof against the respondent" in expiry["detail"]


def test_outsider_cannot_process_deadline(contract, direct_vm, open_case, outsider):
    warp_to(direct_vm, T0 + DEFAULT_WINDOW + 1)
    direct_vm.sender = outsider
    with direct_vm.expect_revert("caller is not a party"):
        contract.process_reply_deadline(open_case)
    assert contract.get_case(open_case)["status"] == "AWAITING_RESPONSE"


@pytest.mark.parametrize("offset", [0, DEFAULT_WINDOW - 1, DEFAULT_WINDOW])
def test_early_deadline_processing_rejected(contract, direct_vm, open_case, claimant, offset):
    warp_to(direct_vm, T0 + offset)
    direct_vm.sender = claimant
    with direct_vm.expect_revert("reply deadline has not passed"):
        contract.process_reply_deadline(open_case)
    case = contract.get_case(open_case)
    assert case["status"] == "AWAITING_RESPONSE"
    assert case["snapshot_locked"] is False
    assert len(contract.get_case_history(open_case)) == 1


def test_repeated_deadline_processing_is_rejected_without_side_effects(
    contract, direct_vm, open_case, claimant, respondent
):
    warp_to(direct_vm, T0 + DEFAULT_WINDOW + 1)
    direct_vm.sender = claimant
    contract.process_reply_deadline(open_case)
    before = _snapshot(contract, open_case)

    for sender in (claimant, respondent):
        direct_vm.sender = sender
        with direct_vm.expect_revert("case is not awaiting a response"):
            contract.process_reply_deadline(open_case)
    assert _snapshot(contract, open_case) == before


def test_deadline_processing_after_reply_rejected(contract, direct_vm, open_case, claimant, respondent):
    direct_vm.sender = respondent
    contract.submit_reply(open_case, "Here is my side")
    before = _snapshot(contract, open_case)

    warp_to(direct_vm, T0 + DEFAULT_WINDOW + 1)
    direct_vm.sender = claimant
    with direct_vm.expect_revert("case is not awaiting a response"):
        contract.process_reply_deadline(open_case)
    assert _snapshot(contract, open_case) == before


def test_deadline_on_unknown_case(contract, direct_vm, claimant):
    direct_vm.sender = claimant
    with direct_vm.expect_revert("case not found"):
        contract.process_reply_deadline("VC-000002")


@pytest.mark.parametrize("lock_via", ["reply", "expiry"])
def test_no_changes_after_lock(contract, direct_vm, open_case, claimant, respondent, lock_via):
    direct_vm.sender = claimant
    contract.submit_evidence(open_case, **evidence_args())
    if lock_via == "reply":
        direct_vm.sender = respondent
        contract.submit_reply(open_case, "Reply")
    else:
        warp_to(direct_vm, T0 + DEFAULT_WINDOW + 1)
        contract.process_reply_deadline(open_case)
    before = _snapshot(contract, open_case)
    assert before[0]["snapshot_locked"] is True
    assert all(e["in_locked_snapshot"] for e in before[1])

    for sender in (claimant, respondent):
        direct_vm.sender = sender
        with direct_vm.expect_revert("case evidence is locked"):
            contract.submit_evidence(open_case, **evidence_args())
        with direct_vm.expect_revert():
            contract.submit_reply(open_case, "Edited reply")
        with direct_vm.expect_revert("case is not awaiting a response"):
            contract.process_reply_deadline(open_case)

    assert _snapshot(contract, open_case) == before


def test_write_surface_has_no_override_methods(contract):
    """Only the documented writes exist; no admin, edit, decide or status setter."""
    contract_cls = type(contract._instance)
    public = {name for name in dir(contract_cls) if not name.startswith("_")}
    assert {
        "create_case",
        "submit_evidence",
        "submit_reply",
        "process_reply_deadline",
        "request_assessment",
    } <= public
    for forbidden in ("assess", "decide", "set_status", "close_case", "update_case", "set_assessment", "reset_case"):
        assert forbidden not in public
    info = contract.get_contract_info()
    assert "ASSESSMENT_PENDING" in info["statuses"]
    assert "DECIDED" in info["statuses"]


def test_full_lifecycle_never_enters_reserved_states(contract, direct_vm, open_case, claimant, respondent):
    statuses = [contract.get_case(open_case)["status"]]
    direct_vm.sender = claimant
    contract.submit_evidence(open_case, **evidence_args())
    statuses.append(contract.get_case(open_case)["status"])
    direct_vm.sender = respondent
    contract.submit_evidence(open_case, **evidence_args())
    contract.submit_reply(open_case, "Reply")
    statuses.append(contract.get_case(open_case)["status"])
    assert statuses == ["AWAITING_RESPONSE", "AWAITING_RESPONSE", "READY_FOR_ASSESSMENT"]
    assert contract.get_case(open_case)["assessment_attempts"] == 0
