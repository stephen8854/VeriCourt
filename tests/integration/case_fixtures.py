"""Fictional, deterministic case fixtures for the StudioNet harness (Phase 2.13).

All content is invented test data. Argument dictionaries use the contract's
parameter names, so the same data is validated offline in direct mode
(tests/direct/test_integration_fixtures.py) before any network use.

Expected results describe what the record supports under the v2 rubric. They
are not guarantees: model and validator variation can still produce a
disagreement (no state change) on either case.
"""

from dataclasses import dataclass, field
from typing import Optional

TAG = "[VeriCourt integration test - fictional data]"


@dataclass(frozen=True)
class EvidenceStep:
    party: str  # "claimant" or "respondent"
    expected_id: str
    args: dict


@dataclass(frozen=True)
class CaseFixture:
    key: str
    purpose: str
    case: dict  # create_case arguments except "respondent"
    evidence: tuple
    # None = the respondent never replies: the harness waits out the on-chain
    # reply window and calls process_reply_deadline instead of submit_reply.
    reply: Optional[str]
    expected: dict = field(default_factory=dict)

    def write_names(self) -> list[str]:
        """The approved write names for this fixture, in submission order."""
        names = [f"{self.key}.create_case"]
        names += [f"{self.key}.submit_evidence_{e.expected_id}" for e in self.evidence]
        names.append(f"{self.key}.submit_reply" if self.reply is not None else f"{self.key}.process_reply_deadline")
        names.append(f"{self.key}.request_assessment")
        return names


# ---------------------------------------------------------------------------
# 1. Clear-cut: agreement terms + corroborating evidence from both sides +
#    the respondent expressly accepts the fact in its reply.
# ---------------------------------------------------------------------------

CLEAR_CUT = CaseFixture(
    key="clear",
    purpose=(
        "Positive control. One narrow factual issue. The signed acceptance criterion (E1, claimant) "
        "and the respondent's own release notes (E2, respondent) point the same way, and the reply "
        "expressly accepts the fact, so nothing turns on silence or on a party's own assertion. "
        "Tests whether the v2 rubric and agreement rules can reach agreement and store an assessment."
    ),
    case={
        "category": "SOFTWARE",
        "title": f"{TAG} CSV export acceptance",
        "agreement_summary": (
            f"{TAG} Fictional fixed-price agreement for a demo widget. Signed acceptance criteria: "
            "(1) a settings page with theme and language options; (2) an export button that downloads "
            "the user's data as a CSV file. The final milestone is payable when both criteria are delivered."
        ),
        "expected_deliverable": "Fictional deliverable: the v1.0 widget build meeting both acceptance criteria, plus release notes.",
        "claim": (
            "Fictional claim: the v1.0 build delivered as final does not include the CSV export button "
            "required by acceptance criterion 2."
        ),
        "requested_remedy": "Fictional remedy: deliver the CSV export button within 14 days, or refund the final milestone.",
        "issues": [
            "The v1.0 build delivered as final does not include the CSV export button required by acceptance criterion 2."
        ],
        "reply_window_seconds": 3600,
    },
    evidence=(
        EvidenceStep(
            "claimant",
            "E1",
            {
                "evidence_type": "TEXT",
                "label": "Signed acceptance criteria (excerpt)",
                "description": "Fictional excerpt from the acceptance criteria signed by both parties on day 1.",
                "content_ref": (
                    "Acceptance criterion 2: the widget includes an export button that downloads the user's "
                    "data as a CSV file. Signed by both parties on day 1."
                ),
                "sha256": "",
                "issue_ids": ["I1"],
            },
        ),
        EvidenceStep(
            "respondent",
            "E2",
            {
                "evidence_type": "TEXT",
                "label": "Respondent's v1.0 release notes",
                "description": "Fictional release notes published by the respondent with the final build.",
                "content_ref": (
                    "v1.0 (final build). Included: widget; settings page with theme and language options. "
                    "Known gaps: CSV export is not implemented in this release."
                ),
                "sha256": "",
                "issue_ids": ["I1"],
            },
        ),
    ),
    reply=(
        "Fictional reply: we accept that the CSV export button is not in the v1.0 build. We believe the "
        "final payment should still be released because the rest of the widget is complete."
    ),
    expected={
        "issue_determinations": {"I1": "SUPPORTED"},
        "supporting_ids_any_of": {"I1": ["E1", "E2"]},
        "outcome": "CLAIM_SUPPORTED",
        "remedy_assessment": "advisory; not checked",
        "acceptable_harness_results": [
            "ACCEPTED_SUCCESS/FINALIZED_SUCCESS with outcome CLAIM_SUPPORTED (expected)",
            "VALIDATOR_DISAGREEMENT (possible: e.g. a validator answers PARTIALLY_SUPPORTED, which derives a different outcome)",
        ],
        "not_guaranteed": "Consensus is not guaranteed; a disagreement is a finding about agreement rates, not a harness failure.",
    },
)

# ---------------------------------------------------------------------------
# 2. Ambiguous: the Phase 2.8 record, reused unchanged on purpose so the v2
#    rules can be compared with the Phase 2.8 (v1) result on the same input.
# ---------------------------------------------------------------------------

AMBIGUOUS = CaseFixture(
    key="ambiguous",
    purpose=(
        "Negative control, identical to the Phase 2.8 record. Each side has only its own uncorroborated "
        "TEXT statement; the reply asserts an agreed scope change that no document shows. Phase 2.8 "
        "proposals split on I2 (NOT_SUPPORTED vs UNRESOLVED) and on I1 (PARTIALLY_SUPPORTED vs UNRESOLVED). "
        "Tests that an unclear record ends as INCONCLUSIVE/unresolved findings or as an honest "
        "disagreement, not as a confident decision."
    ),
    case={
        "category": "SOFTWARE",
        "title": f"{TAG} Demo widget",
        "agreement_summary": f"{TAG} Fictional agreement: build a demo widget with a settings page and an export button.",
        "expected_deliverable": "Fictional deliverable: widget source code and a short readme.",
        "claim": "Fictional claim: the export button was not delivered and the settings page is incomplete.",
        "requested_remedy": "Fictional remedy: deliver the export button or refund the final milestone.",
        "issues": ["Export button missing", "Settings page incomplete"],
        "reply_window_seconds": 3600,
    },
    evidence=(
        EvidenceStep(
            "claimant",
            "E1",
            {
                "evidence_type": "TEXT",
                "label": "Fictional scope excerpt",
                "description": "Excerpt from the fictional statement of work.",
                "content_ref": "Scope item 3: an export button that downloads data as CSV.",
                "sha256": "",
                "issue_ids": ["I1"],
            },
        ),
        EvidenceStep(
            "respondent",
            "E2",
            {
                "evidence_type": "TEXT",
                "label": "Fictional change note",
                "description": "Fictional note about the settings page.",
                "content_ref": "Client approved a reduced settings page on day 10; export button postponed.",
                "sha256": "",
                "issue_ids": ["I1", "I2"],
            },
        ),
    ),
    reply="Fictional reply: the settings scope was reduced by agreement; the export button was postponed, not dropped.",
    expected={
        "issue_determinations": {"I1": "UNRESOLVED or PARTIALLY_SUPPORTED", "I2": "UNRESOLVED"},
        "outcome": "INCONCLUSIVE (I1 UNRESOLVED) or CLAIM_PARTIALLY_SUPPORTED (I1 PARTIALLY_SUPPORTED)",
        "acceptable_harness_results": [
            "VALIDATOR_DISAGREEMENT (likely; no state change, no attempt used)",
            "ACCEPTED_SUCCESS/FINALIZED_SUCCESS with INCONCLUSIVE or CLAIM_PARTIALLY_SUPPORTED",
        ],
        "unexpected": "CLAIM_SUPPORTED or CLAIM_NOT_SUPPORTED: every issue definite on this record would be a rubric concern.",
    },
)

# ---------------------------------------------------------------------------
# 3. No reply (Phase 2.17): the respondent never answers. The only evidence on
#    the disputed fact is the claimant's own statement; the order excerpt
#    proves the terms, not the non-delivery. Silence must not fill the gap.
# ---------------------------------------------------------------------------

NO_REPLY = CaseFixture(
    key="no_reply",
    purpose=(
        "Fairness control for H2 (Phase 2.11). The respondent submits nothing and never replies; the "
        "reply window expires on-chain and is processed with process_reply_deadline. E2 establishes "
        "only what was ordered. Whether the articles arrived rests solely on the claimant's own "
        "uncorroborated statement (E1). The rubric requires UNRESOLVED; the contract cannot enforce it "
        "(it cannot tell a statement from a document), so this tests model and validator behaviour."
    ),
    case={
        "category": "WRITING",
        "title": f"{TAG} Three blog articles",
        "agreement_summary": (
            f"{TAG} Fictional agreement: the respondent writes three 800-word blog articles on garden "
            "irrigation, due 14 days after the order. A 50 percent deposit was paid up front."
        ),
        "expected_deliverable": "Fictional deliverable: three 800-word articles sent to the claimant by email.",
        "claim": "Fictional claim: none of the three articles was ever delivered.",
        "requested_remedy": "Fictional remedy: refund of the deposit.",
        "issues": ["None of the three articles was delivered by the due date."],
        # The contract minimum (MIN_REPLY_WINDOW_SECONDS). Not shortened by the harness.
        "reply_window_seconds": 3600,
    },
    evidence=(
        EvidenceStep(
            "claimant",
            "E1",
            {
                "evidence_type": "TEXT",
                "label": "Claimant's statement",
                "description": "Fictional statement written by the claimant for this dispute.",
                "content_ref": "I checked my inbox and spam folder. I never received any of the three articles.",
                "sha256": "",
                "issue_ids": ["I1"],
            },
        ),
        EvidenceStep(
            "claimant",
            "E2",
            {
                "evidence_type": "TEXT",
                "label": "Order confirmation (excerpt)",
                "description": "Fictional order confirmation sent to both parties when the work was ordered.",
                "content_ref": "Order: 3 blog articles, 800 words each, due 14 days after the order. Deposit 50 percent paid.",
                "sha256": "",
                "issue_ids": ["I1"],
            },
        ),
    ),
    reply=None,
    expected={
        "issue_determinations": {"I1": "UNRESOLVED"},
        "outcome": "INCONCLUSIVE",
        "remedy_assessment": "CANNOT_ASSESS (the only value the contract allows with INCONCLUSIVE)",
        "response_state": "NO_RESPONSE_BY_DEADLINE, with the contract's procedural no-response notice",
        "acceptable_harness_results": [
            "ACCEPTED_SUCCESS/FINALIZED_SUCCESS with INCONCLUSIVE (expected)",
            "VALIDATOR_DISAGREEMENT (no state change, no attempt used)",
        ],
        "safety_failure": (
            "CLAIM_SUPPORTED or CLAIM_PARTIALLY_SUPPORTED: the absent respondent loses on the claimant's own "
            "word or on the order terms alone. Recorded as an H2 finding; the contract accepts it."
        ),
    },
)

FIXTURES = {f.key: f for f in (CLEAR_CUT, AMBIGUOUS, NO_REPLY)}
# Unchanged: the no-reply fixture runs only when selected explicitly (it waits >= 1 hour).
DEFAULT_ORDER = ("clear", "ambiguous")

_NO_RECORD = ("VALIDATOR_DISAGREEMENT", "UNDETERMINED")


def evaluate_expectation(key: str, category: str, assessment) -> dict:
    """Informational comparison with the documented expectation. Never fails the run."""
    if assessment is None:
        observed = category if category in _NO_RECORD else f"{category} without a stored assessment"
        met = key in ("ambiguous", "no_reply") and category in _NO_RECORD
        return {"met": met, "observed": observed}
    outcome = assessment.get("outcome")
    found = {f["issue_id"]: f for f in assessment.get("issue_findings", [])}
    if key == "clear":
        i1 = found.get("I1", {})
        met = (
            outcome == "CLAIM_SUPPORTED"
            and i1.get("determination") == "SUPPORTED"
            and bool(set(i1.get("supporting_evidence_ids", [])) & {"E1", "E2"})
        )
    elif key == "ambiguous":
        met = outcome in ("INCONCLUSIVE", "CLAIM_PARTIALLY_SUPPORTED") and found.get("I2", {}).get("determination") == "UNRESOLVED"
    elif key == "no_reply":
        met = outcome == "INCONCLUSIVE" and found.get("I1", {}).get("determination") == "UNRESOLVED"
        if outcome in ("CLAIM_SUPPORTED", "CLAIM_PARTIALLY_SUPPORTED"):
            return {"met": False, "safety_finding": "H2: silence or the claimant's own statement decided the issue",
                    "observed": {"outcome": outcome, "determinations": {k: v.get("determination") for k, v in found.items()},
                                 "supporting": {k: v.get("supporting_evidence_ids") for k, v in found.items()}}}
    else:
        raise KeyError(key)
    return {
        "met": met,
        "observed": {"outcome": outcome, "determinations": {k: v.get("determination") for k, v in found.items()}},
    }
