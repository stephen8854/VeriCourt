from conftest import DEFAULT_WINDOW, T0, case_args, evidence_args, warp_to


def test_history_records_actions_in_order(contract, direct_vm, open_case, claimant, respondent):
    direct_vm.sender = claimant
    contract.submit_evidence(open_case, **evidence_args())
    warp_to(direct_vm, T0 + 10)
    direct_vm.sender = respondent
    contract.submit_reply(open_case, "Reply")

    history = contract.get_case_history(open_case)
    assert [h["seq"] for h in history] == [1, 2, 3, 4]
    assert [h["action"] for h in history] == [
        "CASE_CREATED",
        "EVIDENCE_SUBMITTED",
        "REPLY_SUBMITTED",
        "SNAPSHOT_LOCKED",
    ]
    assert [h["actor"] for h in history] == [claimant.as_hex, claimant.as_hex, respondent.as_hex, respondent.as_hex]
    assert [h["at"] for h in history] == [T0, T0, T0 + 10, T0 + 10]
    assert history[1]["detail"] == "E1 by CLAIMANT"
    assert history[3]["detail"] == "REPLY_SUBMITTED; evidence_count=1"
    assert contract.get_case(open_case)["history_count"] == 4


def test_party_indexes(contract, direct_vm, claimant, respondent, outsider):
    direct_vm.sender = claimant
    first = contract.create_case(**case_args(respondent))
    direct_vm.sender = respondent
    second = contract.create_case(**case_args(outsider))

    assert contract.get_party_case_ids(claimant.as_hex, 0, 50) == {"total": 1, "case_ids": [first]}
    assert contract.get_party_case_ids(respondent.as_hex, 0, 50) == {"total": 2, "case_ids": [first, second]}
    assert contract.get_party_case_ids(outsider.as_hex, 0, 50) == {"total": 1, "case_ids": [second]}


def test_party_index_has_no_duplicates(contract, direct_vm, claimant, respondent):
    direct_vm.sender = claimant
    ids = [contract.create_case(**case_args(respondent)) for _ in range(3)]
    for party in (claimant, respondent):
        listed = contract.get_party_case_ids(party.as_hex, 0, 50)["case_ids"]
        assert listed == ids
        assert len(set(listed)) == len(listed)


def test_party_index_pagination(contract, direct_vm, claimant, respondent):
    direct_vm.sender = claimant
    ids = [contract.create_case(**case_args(respondent)) for _ in range(5)]
    assert contract.get_party_case_ids(claimant.as_hex, 0, 2) == {"total": 5, "case_ids": ids[0:2]}
    assert contract.get_party_case_ids(claimant.as_hex, 4, 2) == {"total": 5, "case_ids": ids[4:5]}
    assert contract.get_party_case_ids(claimant.as_hex, 9, 2) == {"total": 5, "case_ids": []}


def test_party_index_input_validation(contract, direct_vm, claimant):
    with direct_vm.expect_revert("limit must be between 1 and 50"):
        contract.get_party_case_ids(claimant.as_hex, 0, 51)
    with direct_vm.expect_revert("limit must be between 1 and 50"):
        contract.get_party_case_ids(claimant.as_hex, 0, 0)
    with direct_vm.expect_revert("offset must be a non-negative integer"):
        contract.get_party_case_ids(claimant.as_hex, -1, 10)
    with direct_vm.expect_revert("party"):
        contract.get_party_case_ids("nope", 0, 10)


def test_unknown_party_has_empty_index(contract, outsider):
    assert contract.get_party_case_ids(outsider.as_hex, 0, 10) == {"total": 0, "case_ids": []}


def test_case_status_view(contract, direct_vm, open_case, claimant):
    status = contract.get_case_status(open_case)
    assert status == {
        "case_id": open_case,
        "status": "AWAITING_RESPONSE",
        "response_state": "PENDING",
        "created_at": T0,
        "reply_deadline": T0 + DEFAULT_WINDOW,
        "snapshot_locked": False,
        "locked_at": 0,
        "lock_reason": "",
    }
    warp_to(direct_vm, T0 + DEFAULT_WINDOW + 5)
    direct_vm.sender = claimant
    contract.process_reply_deadline(open_case)
    status = contract.get_case_status(open_case)
    assert status["snapshot_locked"] is True
    assert status["locked_at"] == T0 + DEFAULT_WINDOW + 5


def test_case_evidence_view_fields(contract, direct_vm, open_case, claimant):
    direct_vm.sender = claimant
    contract.submit_evidence(open_case, **evidence_args())
    assert contract.get_case_evidence(open_case) == [
        {
            "evidence_id": "E1",
            "submitter": claimant.as_hex,
            "submitter_role": "CLAIMANT",
            "evidence_type": "LINK",
            "label": "Statement of work",
            "description": "Signed scope listing the contact form.",
            "content_ref": "https://example.com/sow.pdf",
            "sha256": "",
            "submitted_at": T0,
            "issue_ids": ["I1"],
            "in_locked_snapshot": False,
        }
    ]


def test_reads_on_unknown_case_fail(contract, direct_vm):
    for read in (
        contract.get_case,
        contract.get_case_status,
        contract.get_case_evidence,
        contract.get_case_history,
    ):
        with direct_vm.expect_revert("case not found"):
            read("VC-000123")


def test_contract_info(contract):
    info = contract.get_contract_info()
    assert info["schema_version"] == "vericourt-case-v1"
    assert info["case_count"] == 0
    assert info["statuses"] == [
        "AWAITING_RESPONSE",
        "READY_FOR_ASSESSMENT",
        "ASSESSMENT_PENDING",
        "DECIDED",
        "ASSESSMENT_FAILED",
    ]
    assert info["limits"]["max_evidence_per_case"] == 20
    assert info["limits"]["min_reply_window_seconds"] == 3600
    assert info["limits"]["max_reply_window_seconds"] == 30 * 24 * 3600
