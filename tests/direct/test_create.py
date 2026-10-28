import pytest

from conftest import DAY, DEFAULT_WINDOW, HOUR, T0, case_args


def test_create_case_success(contract, direct_vm, claimant, respondent):
    direct_vm.sender = claimant
    case_id = contract.create_case(**case_args(respondent))

    assert case_id == "VC-000001"
    case = contract.get_case(case_id)
    assert case["claimant"] == claimant.as_hex
    assert case["respondent"] == respondent.as_hex
    assert case["category"] == "SOFTWARE"
    assert case["status"] == "AWAITING_RESPONSE"
    assert case["response_state"] == "PENDING"
    assert case["created_at"] == T0
    assert case["reply_deadline"] == T0 + DEFAULT_WINDOW
    assert case["snapshot_locked"] is False
    assert case["assessment_attempts"] == 0
    assert case["issues"] == [
        {"issue_id": "I1", "description": "Contact form missing"},
        {"issue_id": "I2", "description": "Mobile layout broken"},
    ]
    assert contract.get_case_count() == 1


def test_case_ids_are_sequential_and_unique(contract, direct_vm, claimant, respondent):
    direct_vm.sender = claimant
    ids = [contract.create_case(**case_args(respondent)) for _ in range(3)]
    assert ids == ["VC-000001", "VC-000002", "VC-000003"]


def test_respondent_may_be_passed_as_address(contract, direct_vm, claimant, respondent):
    direct_vm.sender = claimant
    args = case_args(respondent)
    args["respondent"] = respondent  # Address object instead of hex string
    case_id = contract.create_case(**args)
    assert contract.get_case(case_id)["respondent"] == respondent.as_hex


def test_claimant_cannot_be_respondent(contract, direct_vm, claimant):
    direct_vm.sender = claimant
    with direct_vm.expect_revert("claimant and respondent must be different"):
        contract.create_case(**case_args(claimant))
    assert contract.get_case_count() == 0


@pytest.mark.parametrize(
    "bad",
    ["", "not-an-address", "0x1234", "0x" + "00" * 20, "0x" + "zz" * 20],
)
def test_invalid_respondent_rejected(contract, direct_vm, claimant, respondent, bad):
    direct_vm.sender = claimant
    with direct_vm.expect_revert("respondent"):
        contract.create_case(**case_args(respondent, respondent=bad))
    assert contract.get_case_count() == 0


@pytest.mark.parametrize("issues", [[], ["a", "b", "c", "d", "e", "f"]])
def test_issue_count_bounds(contract, direct_vm, claimant, respondent, issues):
    direct_vm.sender = claimant
    with direct_vm.expect_revert("issues must contain between 1 and 5"):
        contract.create_case(**case_args(respondent, issues=issues))


def test_five_issues_accepted(contract, direct_vm, claimant, respondent):
    direct_vm.sender = claimant
    case_id = contract.create_case(**case_args(respondent, issues=[f"Issue {n}" for n in range(5)]))
    assert [i["issue_id"] for i in contract.get_case(case_id)["issues"]] == ["I1", "I2", "I3", "I4", "I5"]


@pytest.mark.parametrize(
    "issues",
    [
        ["Late delivery", "Late delivery"],
        ["Late delivery", "  late   DELIVERY "],
    ],
)
def test_duplicate_issues_rejected(contract, direct_vm, claimant, respondent, issues):
    direct_vm.sender = claimant
    with direct_vm.expect_revert("duplicate issue description"):
        contract.create_case(**case_args(respondent, issues=issues))


@pytest.mark.parametrize(
    "issues, message",
    [
        (["   "], "issue is required"),
        (["x" * 301], "issue exceeds 300"),
        (["bad\x00byte"], "control characters"),
    ],
)
def test_malformed_issues_rejected(contract, direct_vm, claimant, respondent, issues, message):
    direct_vm.sender = claimant
    with direct_vm.expect_revert(message):
        contract.create_case(**case_args(respondent, issues=issues))


@pytest.mark.parametrize(
    "field, limit",
    [
        ("title", 120),
        ("agreement_summary", 2000),
        ("expected_deliverable", 1000),
        ("claim", 4000),
        ("requested_remedy", 1000),
    ],
)
def test_text_length_limits(contract, direct_vm, claimant, respondent, field, limit):
    direct_vm.sender = claimant
    contract.create_case(**case_args(respondent, **{field: "x" * limit}))
    with direct_vm.expect_revert(f"{field} exceeds {limit}"):
        contract.create_case(**case_args(respondent, **{field: "x" * (limit + 1)}))
    assert contract.get_case_count() == 1


@pytest.mark.parametrize(
    "field", ["title", "agreement_summary", "expected_deliverable", "claim", "requested_remedy"]
)
def test_required_text_fields(contract, direct_vm, claimant, respondent, field):
    direct_vm.sender = claimant
    with direct_vm.expect_revert(field):
        contract.create_case(**case_args(respondent, **{field: "   "}))


def test_title_minimum_length(contract, direct_vm, claimant, respondent):
    direct_vm.sender = claimant
    with direct_vm.expect_revert("title must be at least 5"):
        contract.create_case(**case_args(respondent, title="abcd"))


def test_invalid_category_rejected(contract, direct_vm, claimant, respondent):
    direct_vm.sender = claimant
    with direct_vm.expect_revert("category must be one of"):
        contract.create_case(**case_args(respondent, category="software"))


@pytest.mark.parametrize("window", [HOUR, 30 * DAY])
def test_reply_window_bounds_inclusive(contract, direct_vm, claimant, respondent, window):
    direct_vm.sender = claimant
    case_id = contract.create_case(**case_args(respondent, reply_window_seconds=window))
    assert contract.get_case(case_id)["reply_deadline"] == T0 + window


@pytest.mark.parametrize("window", [0, -1, HOUR - 1, 30 * DAY + 1])
def test_reply_window_out_of_bounds(contract, direct_vm, claimant, respondent, window):
    direct_vm.sender = claimant
    with direct_vm.expect_revert("reply_window_seconds must be between"):
        contract.create_case(**case_args(respondent, reply_window_seconds=window))
