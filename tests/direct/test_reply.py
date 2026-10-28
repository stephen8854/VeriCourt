from conftest import DEFAULT_WINDOW, T0, evidence_args, warp_to


def test_respondent_reply_success(contract, direct_vm, open_case, claimant, respondent):
    direct_vm.sender = claimant
    contract.submit_evidence(open_case, **evidence_args())

    warp_to(direct_vm, T0 + 100)
    direct_vm.sender = respondent
    contract.submit_reply(open_case, "The form was removed from scope by email.")

    case = contract.get_case(open_case)
    assert case["status"] == "READY_FOR_ASSESSMENT"
    assert case["response_state"] == "SUBMITTED"
    assert case["reply"] == "The form was removed from scope by email."
    assert case["replied_at"] == T0 + 100
    assert case["snapshot_locked"] is True
    assert case["locked_at"] == T0 + 100
    assert case["lock_reason"] == "REPLY_SUBMITTED"
    assert case["locked_evidence_count"] == 1


def test_claimant_cannot_reply(contract, direct_vm, open_case, claimant):
    direct_vm.sender = claimant
    with direct_vm.expect_revert("only the respondent can reply"):
        contract.submit_reply(open_case, "Replying to myself")
    assert contract.get_case(open_case)["response_state"] == "PENDING"


def test_outsider_cannot_reply(contract, direct_vm, open_case, outsider):
    direct_vm.sender = outsider
    with direct_vm.expect_revert("only the respondent can reply"):
        contract.submit_reply(open_case, "Not my case")
    assert contract.get_case(open_case)["status"] == "AWAITING_RESPONSE"


def test_reply_on_unknown_case(contract, direct_vm, respondent):
    direct_vm.sender = respondent
    with direct_vm.expect_revert("case not found"):
        contract.submit_reply("VC-000042", "Hello")


def test_reply_validation(contract, direct_vm, open_case, respondent):
    direct_vm.sender = respondent
    with direct_vm.expect_revert("reply is required"):
        contract.submit_reply(open_case, "  \n ")
    with direct_vm.expect_revert("reply exceeds 4000"):
        contract.submit_reply(open_case, "x" * 4001)
    with direct_vm.expect_revert("control characters"):
        contract.submit_reply(open_case, "bad\x07bell")
    assert contract.get_case(open_case)["response_state"] == "PENDING"

    contract.submit_reply(open_case, "x" * 4000)
    assert contract.get_case(open_case)["response_state"] == "SUBMITTED"


def test_reply_allowed_exactly_at_deadline(contract, direct_vm, open_case, respondent):
    warp_to(direct_vm, T0 + DEFAULT_WINDOW)
    direct_vm.sender = respondent
    contract.submit_reply(open_case, "Just in time")
    assert contract.get_case(open_case)["response_state"] == "SUBMITTED"


def test_reply_rejected_after_deadline(contract, direct_vm, open_case, respondent):
    warp_to(direct_vm, T0 + DEFAULT_WINDOW + 1)
    direct_vm.sender = respondent
    with direct_vm.expect_revert("reply deadline has passed"):
        contract.submit_reply(open_case, "Too late")
    case = contract.get_case(open_case)
    assert case["response_state"] == "PENDING"
    assert case["reply"] == ""
    assert case["snapshot_locked"] is False


def test_second_reply_rejected(contract, direct_vm, open_case, respondent):
    direct_vm.sender = respondent
    contract.submit_reply(open_case, "First")
    history_len = len(contract.get_case_history(open_case))
    with direct_vm.expect_revert("case is not awaiting a response"):
        contract.submit_reply(open_case, "Second")
    case = contract.get_case(open_case)
    assert case["reply"] == "First"
    assert len(contract.get_case_history(open_case)) == history_len
