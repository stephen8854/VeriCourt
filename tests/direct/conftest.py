"""Shared fixtures for VeriCourt direct-mode tests.

Direct mode runs the contract in-process against the GenVM Python SDK
extracted from the GenVM release bundle. We pin that bundle to v0.2.16, the
version StudioNet reports, instead of letting gltest pick "newest cached".

Note: direct mode does not roll back storage when a call reverts (GenVM does).
The contract validates before mutating, and tests assert state is unchanged
after rejected calls.
"""

from datetime import datetime, timezone
from pathlib import Path

import pytest

from gltest.direct.loader import create_address

CONTRACT_PATH = str(Path(__file__).resolve().parents[2] / "contracts" / "vericourt.py")
GENVM_VERSION = "v0.2.16"

# Fixed clock origin so deadline arithmetic is exact.
T0 = int(datetime(2026, 1, 1, tzinfo=timezone.utc).timestamp())
HOUR = 60 * 60
DAY = 24 * HOUR
DEFAULT_WINDOW = 3 * DAY

SHA_A = "a" * 64
SHA_MIXED = "ABCDEF0123456789" * 4


def iso(ts: int) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat().replace("+00:00", "Z")


def warp_to(vm, ts: int) -> None:
    vm.warp(iso(ts))


@pytest.fixture
def contract(direct_vm, direct_deploy):
    warp_to(direct_vm, T0)
    return direct_deploy(CONTRACT_PATH, sdk_version=GENVM_VERSION)


# Addresses are built after deployment so the SDK's Address type is loaded.
@pytest.fixture
def claimant(contract):
    return create_address("vericourt-claimant")


@pytest.fixture
def respondent(contract):
    return create_address("vericourt-respondent")


@pytest.fixture
def outsider(contract):
    return create_address("vericourt-outsider")


def case_args(respondent, **overrides) -> dict:
    args = {
        "respondent": respondent.as_hex,
        "category": "SOFTWARE",
        "title": "Landing page build",
        "agreement_summary": "Build a responsive landing page with a contact form.",
        "expected_deliverable": "Deployed page plus source repository.",
        "claim": "The contact form was never delivered.",
        "requested_remedy": "Deliver the form or refund the final milestone.",
        "issues": ["Contact form missing", "Mobile layout broken"],
        "reply_window_seconds": DEFAULT_WINDOW,
    }
    args.update(overrides)
    return args


def evidence_args(**overrides) -> dict:
    args = {
        "evidence_type": "LINK",
        "label": "Statement of work",
        "description": "Signed scope listing the contact form.",
        "content_ref": "https://example.com/sow.pdf",
        "sha256": "",
        "issue_ids": ["I1"],
    }
    args.update(overrides)
    return args


@pytest.fixture
def open_case(contract, direct_vm, claimant, respondent):
    """A freshly created case at T0 with the default reply window."""
    direct_vm.sender = claimant
    return contract.create_case(**case_args(respondent))


# ---------------------------------------------------------------------------
# Phase 2: assessment helpers (LLM calls are mocked; direct mode runs the
# leader function only, validators are exercised via direct_vm.run_validator)
# ---------------------------------------------------------------------------

import json
import sys

PROMPT_PATTERN = r"VERICOURT_ASSESSMENT_V2"


def finding(issue_id, determination, supporting=(), counter=(), confidence="MEDIUM", **overrides):
    item = {
        "issue_id": issue_id,
        "determination": determination,
        "confidence": confidence,
        "finding": f"Finding for {issue_id}.",
        "reasoning": f"Reasoning for {issue_id} based on the cited record.",
        "supporting_evidence_ids": list(supporting),
        "counter_evidence_ids": list(counter),
        "open_questions": [],
    }
    item.update(overrides)
    return item


def payload(findings, remedy="PARTIALLY_SUPPORTED", **overrides) -> dict:
    data = {
        "summary": "Neutral summary of the dispute.",
        "issue_findings": findings,
        "remedy_assessment": remedy,
        "limitations": ["Only the submitted record was assessed."],
    }
    data.update(overrides)
    return data


def default_payload() -> dict:
    """Valid output for ready_case: I1 SUPPORTED, I2 PARTIALLY_SUPPORTED."""
    return payload(
        [
            finding("I1", "SUPPORTED", supporting=["E1"], counter=["E2"]),
            finding("I2", "PARTIALLY_SUPPORTED", supporting=["E3"]),
        ]
    )


def set_llm(vm, response, pattern: str = PROMPT_PATTERN) -> None:
    """Replace all LLM mocks with one response (dict -> JSON, str sent as-is)."""
    vm.clear_mocks()
    vm.mock_llm(pattern, response if isinstance(response, str) else json.dumps(response))


RECORD_HEADER = "CASE RECORD (JSON data):\n"


@pytest.fixture
def captured_prompts(direct_vm, monkeypatch):
    """Every prompt the contract sends to the (mocked) model, in order."""
    prompts = []
    original = direct_vm._match_llm_mock

    def spy(prompt):
        prompts.append(prompt)
        return original(prompt)

    monkeypatch.setattr(direct_vm, "_match_llm_mock", spy)
    return prompts


def record_from_prompt(prompt: str) -> dict:
    """Parse the case record JSON that the contract embeds at the end of the prompt."""
    assert prompt.count(RECORD_HEADER) == 1
    return json.loads(prompt.split(RECORD_HEADER, 1)[1])


@pytest.fixture
def module(contract):
    """The loaded contract module, for unit-testing its pure helpers."""
    return sys.modules[type(contract._instance).__module__]


@pytest.fixture
def ready_case(contract, direct_vm, claimant, respondent):
    """Locked by reply. E1 (claimant, I1), E2 (respondent, I1), E3 (claimant TEXT, I2)."""
    direct_vm.sender = claimant
    case_id = contract.create_case(**case_args(respondent))
    contract.submit_evidence(case_id, **evidence_args(issue_ids=["I1"]))
    direct_vm.sender = respondent
    contract.submit_evidence(
        case_id,
        **evidence_args(label="Change request", content_ref="https://example.com/cr.pdf", issue_ids=["I1"]),
    )
    direct_vm.sender = claimant
    contract.submit_evidence(
        case_id,
        **evidence_args(evidence_type="TEXT", label="Chat log", content_ref="Mobile fixes promised by Friday.", issue_ids=["I2"]),
    )
    direct_vm.sender = respondent
    contract.submit_reply(case_id, "The form was descoped by email; mobile fixes were delivered late.")
    return case_id


@pytest.fixture
def expired_case(contract, direct_vm, claimant, respondent):
    """No evidence, no reply; locked by deadline expiry."""
    direct_vm.sender = claimant
    case_id = contract.create_case(**case_args(respondent))
    warp_to(direct_vm, T0 + DEFAULT_WINDOW + 1)
    contract.process_reply_deadline(case_id)
    return case_id
