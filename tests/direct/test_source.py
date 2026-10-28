"""Source-level checks that do not need the GenVM SDK."""

from conftest import CONTRACT_PATH


def test_contract_source_is_ascii():
    # genlayer-py 0.16.3 ASCII-encodes contract source for schema-by-code
    # lookups (eth_utils.encode_hex); a non-ASCII character breaks gltest's
    # contract client construction on StudioNet.
    source = open(CONTRACT_PATH, "rb").read()
    offenders = [(i, b) for i, b in enumerate(source) if b > 127]
    assert offenders == [], f"non-ASCII bytes at offsets {offenders[:5]}"
