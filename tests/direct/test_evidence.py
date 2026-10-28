import pytest

from conftest import DEFAULT_WINDOW, SHA_A, SHA_MIXED, T0, case_args, evidence_args, warp_to


def test_each_party_can_submit_evidence(contract, direct_vm, open_case, claimant, respondent):
    direct_vm.sender = claimant
    assert contract.submit_evidence(open_case, **evidence_args()) == "E1"

    warp_to(direct_vm, T0 + 60)
    direct_vm.sender = respondent
    eid = contract.submit_evidence(
        open_case,
        **evidence_args(
            evidence_type="TEXT",
            label="Client email",
            content_ref="Form was descoped on 3 March.",
            issue_ids=["I1", "I2"],
        ),
    )
    assert eid == "E2"

    evidence = contract.get_case_evidence(open_case)
    assert [e["evidence_id"] for e in evidence] == ["E1", "E2"]
    assert evidence[0]["submitter"] == claimant.as_hex
    assert evidence[0]["submitter_role"] == "CLAIMANT"
    assert evidence[0]["submitted_at"] == T0
    assert evidence[1]["submitter_role"] == "RESPONDENT"
    assert evidence[1]["issue_ids"] == ["I1", "I2"]
    assert evidence[1]["submitted_at"] == T0 + 60

    case = contract.get_case(open_case)
    assert case["claimant_evidence_count"] == 1
    assert case["respondent_evidence_count"] == 1


def test_file_digest_evidence_normalises_hex_case(contract, direct_vm, open_case, claimant):
    direct_vm.sender = claimant
    contract.submit_evidence(
        open_case,
        **evidence_args(evidence_type="FILE_DIGEST", content_ref="final.zip", sha256=SHA_MIXED),
    )
    assert contract.get_case_evidence(open_case)[0]["sha256"] == SHA_MIXED.lower()


def test_file_digest_name_is_optional(contract, direct_vm, open_case, claimant):
    direct_vm.sender = claimant
    contract.submit_evidence(open_case, **evidence_args(evidence_type="FILE_DIGEST", content_ref="", sha256=SHA_A))
    assert contract.get_case_evidence(open_case)[0]["content_ref"] == ""


def test_link_may_carry_digest(contract, direct_vm, open_case, claimant):
    direct_vm.sender = claimant
    contract.submit_evidence(open_case, **evidence_args(sha256=SHA_A))
    assert contract.get_case_evidence(open_case)[0]["sha256"] == SHA_A


def test_outsider_cannot_submit_evidence(contract, direct_vm, open_case, outsider):
    direct_vm.sender = outsider
    with direct_vm.expect_revert("caller is not a party"):
        contract.submit_evidence(open_case, **evidence_args())
    assert contract.get_case_evidence(open_case) == []


def test_unknown_case_rejected(contract, direct_vm, claimant):
    direct_vm.sender = claimant
    with direct_vm.expect_revert("case not found"):
        contract.submit_evidence("VC-999999", **evidence_args())


@pytest.mark.parametrize(
    "issue_ids, message",
    [
        (["I9"], "unknown issue id I9"),
        (["i1"], "unknown issue id i1"),
        (["I1", "I1"], "duplicate issue id I1"),
        ([], "issue_ids must contain between 1 and 5"),
    ],
)
def test_issue_references_validated(contract, direct_vm, open_case, claimant, issue_ids, message):
    direct_vm.sender = claimant
    with direct_vm.expect_revert(message):
        contract.submit_evidence(open_case, **evidence_args(issue_ids=issue_ids))
    assert contract.get_case_evidence(open_case) == []


@pytest.mark.parametrize(
    "overrides, message",
    [
        ({"evidence_type": "VIDEO"}, "evidence_type must be one of"),
        ({"label": ""}, "label is required"),
        ({"label": "x" * 121}, "label exceeds 120"),
        ({"description": "x" * 1001}, "description exceeds 1000"),
        ({"content_ref": "ftp://example.com/a"}, "must be an http(s) URL"),
        ({"content_ref": "https://exa mple.com"}, "must not contain whitespace"),
        ({"content_ref": "https://"}, "has no host"),
        ({"content_ref": "https://e.com/" + "a" * 500}, "content_ref exceeds 512"),
        ({"sha256": "abc"}, "sha256 must be 64 hexadecimal"),
        ({"sha256": "g" * 64}, "sha256 must be 64 hexadecimal"),
        ({"evidence_type": "TEXT", "content_ref": ""}, "content_ref is required"),
        ({"evidence_type": "TEXT", "content_ref": "x" * 2001}, "content_ref exceeds 2000"),
        ({"evidence_type": "TEXT", "content_ref": "quote", "sha256": SHA_A}, "not accepted for TEXT"),
        ({"evidence_type": "FILE_DIGEST", "sha256": ""}, "sha256 must be 64 hexadecimal"),
        ({"evidence_type": "FILE_DIGEST", "content_ref": "x" * 201, "sha256": SHA_A}, "content_ref exceeds 200"),
    ],
)
def test_evidence_field_validation(contract, direct_vm, open_case, claimant, overrides, message):
    direct_vm.sender = claimant
    with direct_vm.expect_revert(message):
        contract.submit_evidence(open_case, **evidence_args(**overrides))
    assert contract.get_case(open_case)["evidence_count"] == 0


def test_evidence_boundary_lengths_accepted(contract, direct_vm, open_case, claimant):
    direct_vm.sender = claimant
    contract.submit_evidence(
        open_case,
        **evidence_args(
            label="x" * 120,
            description="x" * 1000,
            content_ref="https://e.com/" + "a" * (512 - len("https://e.com/")),
        ),
    )
    contract.submit_evidence(open_case, **evidence_args(evidence_type="TEXT", content_ref="x" * 2000))
    assert contract.get_case(open_case)["evidence_count"] == 2


def test_per_party_limit(contract, direct_vm, open_case, claimant, respondent):
    direct_vm.sender = claimant
    for _ in range(10):
        contract.submit_evidence(open_case, **evidence_args())
    with direct_vm.expect_revert("party evidence limit of 10 reached"):
        contract.submit_evidence(open_case, **evidence_args())

    # The other party's quota is independent.
    direct_vm.sender = respondent
    assert contract.submit_evidence(open_case, **evidence_args()) == "E11"
    assert contract.get_case(open_case)["claimant_evidence_count"] == 10


def test_per_case_limit(contract, direct_vm, open_case, claimant, respondent):
    for sender in (claimant, respondent):
        direct_vm.sender = sender
        for _ in range(10):
            contract.submit_evidence(open_case, **evidence_args())
    for sender in (claimant, respondent):
        direct_vm.sender = sender
        with direct_vm.expect_revert("case evidence limit of 20 reached"):
            contract.submit_evidence(open_case, **evidence_args())
    assert contract.get_case(open_case)["evidence_count"] == 20


def test_evidence_window_boundary(contract, direct_vm, open_case, claimant):
    direct_vm.sender = claimant
    warp_to(direct_vm, T0 + DEFAULT_WINDOW)
    contract.submit_evidence(open_case, **evidence_args())

    warp_to(direct_vm, T0 + DEFAULT_WINDOW + 1)
    with direct_vm.expect_revert("evidence window has closed"):
        contract.submit_evidence(open_case, **evidence_args())
    assert contract.get_case(open_case)["evidence_count"] == 1


def test_evidence_is_scoped_to_its_case(contract, direct_vm, claimant, respondent):
    direct_vm.sender = claimant
    first = contract.create_case(**case_args(respondent))
    second = contract.create_case(**case_args(respondent, issues=["Only issue"]))
    contract.submit_evidence(first, **evidence_args())
    assert contract.get_case_evidence(second) == []
    assert contract.submit_evidence(second, **evidence_args()) == "E1"
