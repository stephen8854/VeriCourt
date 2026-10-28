"""Exhaustive checks of the v2 overall-outcome mapping (contract `_derive_outcome`).

Every combination of issue determinations for one to five issues (4 + 16 + 64 +
256 + 1024 = 1364 cases) is checked against an independent statement of the
approved rules and against each required property separately.
"""

import itertools

import pytest

S, P, N, U = "SUPPORTED", "PARTIALLY_SUPPORTED", "NOT_SUPPORTED", "UNRESOLVED"
DETS = (S, P, N, U)
ALL = [combo for n in range(1, 6) for combo in itertools.product(DETS, repeat=n)]


def expected_outcome(dets):
    """The approved Phase 2.9/2.10 mapping, restated independently of the contract."""
    if not dets:
        return "INCONCLUSIVE"
    if all(d == S for d in dets):
        return "CLAIM_SUPPORTED"
    if all(d == N for d in dets):
        return "CLAIM_NOT_SUPPORTED"
    if any(d in (S, P) for d in dets):
        return "CLAIM_PARTIALLY_SUPPORTED"
    return "INCONCLUSIVE"


def test_enumeration_size():
    assert len(ALL) == 1364


def test_mapping_matches_specification_exhaustively(module):
    mismatches = [(d, module._derive_outcome(list(d))) for d in ALL if module._derive_outcome(list(d)) != expected_outcome(d)]
    assert mismatches == []


def test_empty_issue_list_is_inconclusive(module):
    # Unreachable in practice (cases have 1-5 issues), but must not be vacuously "all SUPPORTED".
    assert module._derive_outcome([]) == "INCONCLUSIVE"


def test_unresolved_never_counts_against_the_claimant(module):
    offenders = [d for d in ALL if U in d and module._derive_outcome(list(d)) == "CLAIM_NOT_SUPPORTED"]
    assert offenders == []


def test_all_not_supported_is_claim_not_supported(module):
    for n in range(1, 6):
        assert module._derive_outcome([N] * n) == "CLAIM_NOT_SUPPORTED"


def test_only_not_supported_and_unresolved_mixed_is_inconclusive(module):
    mixed = [d for d in ALL if set(d) == {N, U}]
    assert len(mixed) == sum(2 ** n - 2 for n in range(1, 6))
    assert {module._derive_outcome(list(d)) for d in mixed} == {"INCONCLUSIVE"}


def test_any_favourable_issue_is_partial_unless_all_supported(module):
    for d in ALL:
        if any(x in (S, P) for x in d):
            expected = "CLAIM_SUPPORTED" if all(x == S for x in d) else "CLAIM_PARTIALLY_SUPPORTED"
            assert module._derive_outcome(list(d)) == expected, d


def test_all_unresolved_is_inconclusive(module):
    for n in range(1, 6):
        assert module._derive_outcome([U] * n) == "INCONCLUSIVE"


def test_outcome_depends_only_on_the_multiset_of_determinations(module):
    for d in ALL:
        for perm in set(itertools.permutations(d)):
            assert module._derive_outcome(list(perm)) == module._derive_outcome(list(d))


# Monotonicity: a uniformly weaker set of findings (U <= anything, P <= S) never
# derives an outcome in a different direction. Not used by the Option A
# agreement rule, but it is what makes the mapping safe for any future
# conservative-endorsement design and rules out "inversions".
def _det_le(a, b):
    return a == b or a == U or (a, b) == (P, S)


def _out_le(a, b):
    return a == b or a == "INCONCLUSIVE" or (a, b) == ("CLAIM_PARTIALLY_SUPPORTED", "CLAIM_SUPPORTED")


@pytest.mark.parametrize("n", [1, 2, 3, 4])
def test_mapping_is_monotone(module, n):
    combos = list(itertools.product(DETS, repeat=n))
    for weaker in combos:
        for stronger in combos:
            if all(_det_le(a, b) for a, b in zip(weaker, stronger)):
                assert _out_le(module._derive_outcome(list(weaker)), module._derive_outcome(list(stronger))), (
                    weaker,
                    stronger,
                )
