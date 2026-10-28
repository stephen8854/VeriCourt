"""Phase 2.13: timeout classification, polling deadlines, submission uncertainty
and duplicate-write prevention, all offline.

genlayer-py 0.16.3 code paths are exercised for real where it matters
(make_client, get_transaction, write_contract); only the HTTP layer is fake
(a ``post`` callable injected into BoundedProvider). Clocks and sleeps are
fakes, so deadlines are exercised without waiting. No test opens a socket:
the autouse ``no_network`` fixture fails any attempt.

(No conftest.py here: tests/direct/conftest.py is imported by name and a
second module called ``conftest`` would shadow it.)
"""

import base64
import copy
import json
import math
import socket
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "integration"))
import requests
from genlayer_py import create_account
from genlayer_py.chains import studionet
from genlayer_py.exceptions import GenLayerError
from genlayer_py.types import TransactionHashVariant
from gltest.assertions import tx_execution_succeeded
from web3 import Web3

import harness as h  # noqa: E402
from case_fixtures import AMBIGUOUS, CLEAR_CUT, FIXTURES, NO_REPLY, evaluate_expectation  # noqa: E402


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    """Fail loudly if anything under test tries to open a connection."""

    def refuse(*args, **kwargs):
        raise AssertionError("offline harness test attempted a network connection")

    monkeypatch.setattr(socket.socket, "connect", refuse)
    monkeypatch.setattr(socket.socket, "connect_ex", refuse)
    monkeypatch.setattr(socket, "create_connection", refuse)
    monkeypatch.setattr(socket, "getaddrinfo", refuse)


ROOT = Path(__file__).resolve().parents[2]
PHASE_2_8_ASSESSMENT_TX = ROOT / "integration-logs" / "assessment-tx-raw.json"
URL = "https://studio.example.invalid/api"
CONTRACT = Web3.to_checksum_address("0x" + "12" * 20)
TX_A = "0x" + "a1" * 32
TX_B = "0x" + "b2" * 32
ETH_HASH = "0x" + "e3" * 32


# -- fakes ---------------------------------------------------------------------


class FakeResponse:
    def __init__(self, body, status_code=200, is_json=True):
        self.body, self.status_code, self.is_json = body, status_code, is_json

    def json(self):
        if not self.is_json:
            raise ValueError("Expecting value")
        return self.body


class FakePost:
    """Stands in for requests.post. Handlers per JSON-RPC method: a value, an exception or a FakeResponse."""

    def __init__(self, handlers):
        self.handlers = handlers
        self.calls = []

    def __call__(self, url, json=None, headers=None, timeout=None):
        method = json["method"]
        self.calls.append({"method": method, "timeout": timeout, "url": url})
        if method not in self.handlers:
            raise AssertionError(f"unexpected RPC {method}")
        out = self.handlers[method]
        out = out(json["params"]) if callable(out) and not isinstance(out, BaseException) else out
        if isinstance(out, BaseException):
            raise out
        if isinstance(out, FakeResponse):
            return out
        return FakeResponse({"jsonrpc": "2.0", "id": json["id"], "result": out})

    def methods(self):
        return [c["method"] for c in self.calls]


class FakeClock:
    def __init__(self):
        self.t = 1000.0
        self.sleeps = []

    def clock(self):
        return self.t

    def sleep(self, seconds):
        assert seconds >= 0
        self.sleeps.append(seconds)
        self.t += seconds


def timeouts(**overrides):
    base = dict(http_connect_timeout_s=3.0, http_read_timeout_s=7.0, min_request_spacing_s=0.5,
                write_decision_timeout_s=60.0, assessment_decision_timeout_s=120.0, finality_timeout_s=60.0,
                poll_interval_s=6.0, max_consecutive_read_failures=3, run_budget_s=10_000.0)
    base.update(overrides)
    return h.Timeouts(**base)


def provider(handlers, fc=None, **t):
    fc = fc or FakeClock()
    post = FakePost(handlers)
    journal = h.RequestJournal()
    p = h.BoundedProvider(URL, timeouts(**t), journal, post=post, clock=fc.clock, sleep=fc.sleep)
    return p, post, journal


def consensus_contract():
    return copy.deepcopy(studionet.consensus_main_contract)


def client_with(handlers, fc=None):
    fc = fc or FakeClock()
    post = FakePost({"sim_getConsensusContract": consensus_contract(), **handlers})
    journal = h.RequestJournal()
    account = create_account()
    client = h.make_client(studionet, URL, account, timeouts(), journal, post=post, clock=fc.clock, sleep=fc.sleep)
    return client, post, journal, account


def tx(status, result="MAJORITY_AGREE", execution="SUCCESS", code="return", payload="null", receipts=None, **extra):
    leader = {"mode": "leader", "execution_result": execution,
              "result": {"status": code, "payload": {"readable": payload} if code == "return" else payload}}
    return {"status_name": status, "result_name": result,
            "consensus_data": {"leader_receipt": receipts if receipts is not None else [leader]}, **extra}


# -- 1. Bounded provider: every request has a timeout; failures are typed -------


def test_every_request_carries_connect_and_read_timeouts():
    p, post, journal = provider({"gen_call": "00"})
    assert p.make_request("gen_call", [{}])["result"] == "00"
    assert post.calls == [{"method": "gen_call", "timeout": (3.0, 7.0), "url": URL}]
    assert journal.records[0].method == "gen_call" and journal.records[0].outcome == "ok"


def test_read_timeout_is_a_typed_timeout_naming_the_operation():
    p, post, journal = provider({"gen_call": requests.exceptions.ReadTimeout("read timed out")})
    with pytest.raises(h.RpcError) as err:
        p.make_request("gen_call", [{}])
    assert err.value.kind == h.READ_TIMEOUT and err.value.is_timeout
    assert isinstance(err.value, GenLayerError)  # SDK code paths still see a GenLayerError
    assert "gen_call" in str(err.value) and URL in str(err.value)
    assert len(post.calls) == 1  # no retry
    assert journal.records[-1].outcome == h.READ_TIMEOUT


def test_connect_timeout_and_transport_errors_are_distinct():
    p, _, _ = provider({"a": requests.exceptions.ConnectTimeout("x"), "b": requests.exceptions.ConnectionError("reset")})
    with pytest.raises(h.RpcError) as a:
        p.make_request("a", [])
    with pytest.raises(h.RpcError) as b:
        p.make_request("b", [])
    assert (a.value.kind, a.value.is_timeout) == (h.CONNECT_TIMEOUT, True)
    assert (b.value.kind, b.value.is_timeout) == (h.TRANSPORT_ERROR, False)


def test_invalid_json_and_rpc_errors_are_failures_not_timeouts():
    p, _, _ = provider({
        "html": FakeResponse("<html>429</html>", status_code=429, is_json=False),
        "err": FakeResponse({"jsonrpc": "2.0", "id": 1, "error": {"code": -32000, "message": "boom"}}),
    })
    with pytest.raises(h.RpcError) as html:
        p.make_request("html", [])
    with pytest.raises(h.RpcError) as err:
        p.make_request("err", [])
    assert html.value.kind == h.INVALID_RESPONSE and "429" in str(html.value) and not html.value.is_timeout
    assert err.value.kind == h.RPC_ERROR and "boom" in str(err.value) and not err.value.is_timeout


def test_requests_are_spaced_for_the_rate_limit():
    fc = FakeClock()
    p, _, _ = provider({"m": 1}, fc=fc, min_request_spacing_s=1.1)
    p.make_request("m", [])
    p.make_request("m", [])
    fc.t += 5
    p.make_request("m", [])
    assert fc.sleeps == [pytest.approx(1.1)]


def test_journal_never_stores_params_and_keeps_only_the_send_hash():
    p, _, journal = provider({"eth_sendRawTransaction": ETH_HASH, "gen_call": "00"})
    p.make_request("eth_sendRawTransaction", ["0xSIGNED_RAW_TRANSACTION"])
    p.make_request("gen_call", [{"data": "secret-ish"}])
    dumped = json.dumps([r.__dict__ for r in journal.records])
    assert "SIGNED_RAW" not in dumped and "secret-ish" not in dumped
    assert journal.records[0].result_ref == ETH_HASH and journal.records[1].result_ref is None


# -- 2. make_client: genlayer-py and web3 both use the bounded provider --------


def test_make_client_routes_sdk_and_web3_requests_through_bounded_provider():
    before = copy.deepcopy(studionet.rpc_urls)
    client, post, journal, account = client_with({"eth_getTransactionCount": "0x0"})
    assert client.get_current_nonce(address=account.address) == 0  # web3 path
    assert post.methods() == ["sim_getConsensusContract", "eth_getTransactionCount"]
    assert all(c["timeout"] == (3.0, 7.0) for c in post.calls)
    assert studionet.rpc_urls == before  # shared chain object not mutated


def test_phase_2_8_hang_mode_now_ends_in_a_read_timeout():
    """The Phase 2.8 run blocked forever in an SSL read; the same stall is now a typed error."""
    client, post, _, _ = client_with({
        "gen_call": requests.exceptions.ReadTimeout("The read operation timed out"),
        "eth_getTransactionByHash": requests.exceptions.ReadTimeout("The read operation timed out"),
    })
    with pytest.raises(h.RpcError) as read:
        client.read_contract(address=CONTRACT, function_name="get_case", args=["VC-000001"],
                             transaction_hash_variant=TransactionHashVariant.LATEST_NONFINAL)
    with pytest.raises(h.RpcError) as status:
        client.get_transaction(TX_A)
    assert read.value.method == "gen_call" and read.value.is_timeout
    assert status.value.method == "eth_getTransactionByHash" and status.value.is_timeout


# -- 3. Classification: success needs status + consensus + execution ----------


def phase_2_8_tx():
    """The real Phase 2.8 assessment transaction, decoded by genlayer-py's own get_transaction."""
    raw = json.loads(PHASE_2_8_ASSESSMENT_TX.read_text())["result"]
    client, _, _, _ = client_with({"eth_getTransactionByHash": lambda params: copy.deepcopy(raw)})
    return client.get_transaction(raw["hash"])


def test_phase_2_8_assessment_is_classified_as_validator_disagreement():
    decoded = phase_2_8_tx()
    assert tx_execution_succeeded(decoded) is True  # the old harness signal: misleading on its own
    view = h.classify_transaction(decoded)
    assert view.category == h.VALIDATOR_DISAGREEMENT
    assert view.final is True and view.status_name == "FINALIZED" and view.result_name == "MAJORITY_DISAGREE"
    assert view.votes == ["IDLE", "DISAGREE", "DISAGREE", "DISAGREE", "IDLE"]


@pytest.mark.parametrize(
    "transaction, category, final",
    [
        (tx("ACCEPTED", payload='"E1"'), h.ACCEPTED_SUCCESS, False),
        (tx("FINALIZED"), h.FINALIZED_SUCCESS, True),
        (tx("ACCEPTED", code="rollback", payload="case evidence is locked", execution="ERROR"), h.ACCEPTED_EXECUTION_FAILED, False),
        (tx("FINALIZED", code="contract_error", payload="x"), h.FINALIZED_EXECUTION_FAILED, True),
        (tx("UNDETERMINED", result="MAJORITY_DISAGREE"), h.VALIDATOR_DISAGREEMENT, False),
        (tx("ACCEPTED", result="MAJORITY_DISAGREE"), h.VALIDATOR_DISAGREEMENT, False),
        (tx("UNDETERMINED", result="NO_MAJORITY"), h.UNDETERMINED, False),
        (tx("FINALIZED", result="NO_MAJORITY"), h.UNDETERMINED, True),
        (tx("LEADER_TIMEOUT", result="TIMEOUT"), h.UNDETERMINED, False),
        (tx("VALIDATORS_TIMEOUT"), h.UNDETERMINED, False),
        (tx("CANCELED"), h.UNDETERMINED, False),
        (tx("PENDING", result="IDLE"), h.PENDING, False),
        (tx("PROPOSING", result="IDLE"), h.PENDING, False),
        (tx("COMMITTING", result="IDLE"), h.PENDING, False),
        (tx("READY_TO_FINALIZE"), h.PENDING, False),
        (tx("SOMETHING_NEW"), h.UNRECOGNIZED, False),
        (tx(None), h.UNRECOGNIZED, False),
        (tx("ACCEPTED", result=None), h.UNRECOGNIZED, False),
        (tx("ACCEPTED", receipts=[]), h.UNRECOGNIZED, False),
        (tx("ACCEPTED", code="none"), h.UNRECOGNIZED, False),
        ("not a transaction", h.UNRECOGNIZED, False),
    ],
)
def test_classification_table(transaction, category, final):
    view = h.classify_transaction(transaction)
    assert (view.category, view.final) == (category, final)


def test_accepted_receipt_alone_is_not_success():
    """A returned receipt with a successful leader execution is not success if validators disagreed."""
    t = tx("ACCEPTED", result="MAJORITY_DISAGREE")
    assert tx_execution_succeeded(t) is True
    assert h.classify_transaction(t).category not in h.SUCCESS_CATEGORIES


def test_leader_receipt_is_selected_by_mode():
    validator_mode = {"mode": "validator", "execution_result": "ERROR", "result": {"status": "contract_error", "payload": "x"}}
    leader = {"mode": "leader", "execution_result": "SUCCESS", "result": {"status": "return", "payload": {"readable": '"E2"'}}}
    view = h.classify_transaction(tx("ACCEPTED", receipts=[validator_mode, leader]))
    assert view.category == h.ACCEPTED_SUCCESS and view.leader_result_payload == '"E2"'
    assert h.classify_transaction(tx("ACCEPTED", receipts=[validator_mode])).category == h.UNRECOGNIZED


def test_undecoded_base64_leader_result_is_decoded():
    rollback = base64.b64encode(b"\x01case evidence is locked").decode()  # result code 1 = rollback
    receipt = {"mode": "leader", "execution_result": "SUCCESS", "result": rollback}
    view = h.classify_transaction(tx("ACCEPTED", receipts=[receipt]))
    assert view.category == h.ACCEPTED_EXECUTION_FAILED
    assert (view.leader_result_status, view.leader_result_payload) == ("rollback", "case evidence is locked")


# -- 4. Polling: finite deadline, distinct terminal results, never writes ------


def poll(fetch, fc, until="decided", timeout_s=60.0, interval_s=6.0, failures=3):
    return h.poll_transaction(fetch, TX_A, operation="op", until=until, timeout_s=timeout_s,
                              interval_s=interval_s, max_consecutive_read_failures=failures,
                              clock=fc.clock, sleep=fc.sleep)


def test_poll_deadline_is_finite_and_reports_unknown_status():
    fc = FakeClock()
    out = poll(lambda _: tx("PROPOSING", result="IDLE"), fc, timeout_s=60.0, interval_s=6.0)
    assert out.category == h.TIMED_OUT_UNKNOWN
    assert out.polls == math.ceil(60.0 / 6.0) + 1
    assert sum(fc.sleeps) == pytest.approx(60.0)  # never sleeps past the deadline
    assert "actual status unknown" in out.detail and "PROPOSING" in out.detail
    assert out.view.category == h.PENDING  # last observation kept for the report


def test_poll_sleep_is_clipped_to_the_remaining_time():
    fc = FakeClock()
    poll(lambda _: tx("PENDING", result="IDLE"), fc, timeout_s=10.0, interval_s=6.0)
    assert fc.sleeps == [6.0, pytest.approx(4.0)]


def test_timeout_is_never_reported_as_execution_failure():
    fc = FakeClock()
    out = poll(lambda _: (_ for _ in ()).throw(h.RpcError("eth_getTransactionByHash", h.READ_TIMEOUT, "stall")), fc, failures=99)
    assert out.category == h.TIMED_OUT_UNKNOWN
    assert out.category not in (h.ACCEPTED_EXECUTION_FAILED, h.FINALIZED_EXECUTION_FAILED)
    assert all("read_timeout" in e for e in out.errors)


def test_consecutive_read_failures_end_in_read_failure():
    fc = FakeClock()

    def fetch(_):
        raise h.RpcError("eth_getTransactionByHash", h.TRANSPORT_ERROR, "reset")

    out = poll(fetch, fc, failures=3)
    assert (out.category, out.polls, len(out.errors)) == (h.READ_FAILURE, 3, 3)


def test_transient_read_failure_then_decision():
    fc = FakeClock()
    script = [h.RpcError("eth_getTransactionByHash", h.READ_TIMEOUT, "x"), tx("PENDING", result="IDLE"), tx("ACCEPTED")]

    def fetch(_):
        item = script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    out = poll(fetch, fc)
    assert out.category == h.ACCEPTED_SUCCESS and out.polls == 3 and len(out.errors) == 1


def test_sdk_shape_errors_in_get_transaction_are_read_failures():
    """genlayer-py raises KeyError/TypeError for unknown statuses or a null result; not a status."""
    fc = FakeClock()

    def fetch(_):
        raise KeyError("ACTIVATING")

    assert poll(fetch, fc, failures=1).category == h.READ_FAILURE


def test_finality_poll_waits_past_accepted_and_undetermined():
    fc = FakeClock()
    script = [tx("UNDETERMINED", result="MAJORITY_DISAGREE"), tx("UNDETERMINED", result="MAJORITY_DISAGREE"),
              tx("FINALIZED", result="MAJORITY_DISAGREE")]
    out = poll(lambda _: script.pop(0), fc, until="final")
    assert (out.category, out.view.final, out.polls) == (h.VALIDATOR_DISAGREEMENT, True, 3)
    script = [tx("ACCEPTED"), tx("FINALIZED")]
    assert poll(lambda _: script.pop(0), fc, until="final").category == h.FINALIZED_SUCCESS


def test_decided_poll_stops_at_first_decided_state():
    fc = FakeClock()
    script = [tx("PENDING", result="IDLE"), tx("UNDETERMINED", result="MAJORITY_DISAGREE"), tx("FINALIZED")]
    out = poll(lambda _: script.pop(0), fc)
    assert out.category == h.VALIDATOR_DISAGREEMENT and out.polls == 2


# -- 5. Writes: at most once, in order, never after uncertainty ---------------


def guard(plan=("w1", "w2")):
    journal = h.RequestJournal()
    return h.WriteGuard(list(plan), journal), journal


def test_duplicate_write_is_refused_without_sending():
    g, _ = guard()
    sends = []
    assert g.submit("w1", lambda: sends.append(1) or TX_A).category == h.SUBMITTED
    with pytest.raises(h.HarnessStop, match="already attempted"):
        g.submit("w1", lambda: sends.append(2) or TX_B)
    assert sends == [1]


def test_out_of_plan_write_is_refused():
    g, _ = guard()
    with pytest.raises(h.HarnessStop, match="expected w1"):
        g.submit("w2", lambda: TX_A)
    with pytest.raises(h.HarnessStop, match="not the next approved"):
        g.submit("unplanned", lambda: TX_A)
    assert g.attempted == []


def test_failure_before_send_is_definitely_not_submitted_and_halts():
    g, journal = guard()

    def send():
        journal.add("eth_estimateGas", h.READ_TIMEOUT, 7.0)
        raise h.RpcError("eth_estimateGas", h.READ_TIMEOUT, "stall")

    sub = g.submit("w1", send)
    assert sub.category == h.NOT_SUBMITTED and "eth_estimateGas" in sub.error
    with pytest.raises(h.HarnessStop, match="halted"):
        g.submit("w2", lambda: TX_B)


@pytest.mark.parametrize(
    "send_outcome, category",
    [(h.READ_TIMEOUT, h.SUBMISSION_UNCERTAIN), (h.TRANSPORT_ERROR, h.SUBMISSION_UNCERTAIN),
     (h.INVALID_RESPONSE, h.SUBMISSION_UNCERTAIN), (h.CONNECT_TIMEOUT, h.SUBMISSION_UNCERTAIN),
     (h.RPC_ERROR, h.SUBMISSION_REJECTED)],
)
def test_send_failure_categories(send_outcome, category):
    g, journal = guard()

    def send():
        journal.add("eth_sendRawTransaction", send_outcome, 1.0)
        raise h.RpcError("eth_sendRawTransaction", send_outcome, "x")

    assert g.submit("w1", send).category == category
    assert g.halted is not None


def test_sdk_write_with_send_timeout_is_uncertain_and_sent_once():
    """Real genlayer-py write_contract; the eth_sendRawTransaction response never arrives."""
    client, post, journal, account = client_with({
        "eth_getTransactionCount": "0x0",
        "eth_estimateGas": "0x5208",
        "eth_sendRawTransaction": requests.exceptions.ReadTimeout("The read operation timed out"),
    })
    g = h.WriteGuard(["assess"], journal)
    sub = g.submit("assess", lambda: client.write_contract(address=CONTRACT, function_name="request_assessment",
                                                           account=account, args=["VC-000001"], leader_only=False))
    assert sub.category == h.SUBMISSION_UNCERTAIN and "read_timeout" in sub.error
    assert post.methods().count("eth_sendRawTransaction") == 1
    with pytest.raises(h.HarnessStop):
        g.submit("assess", lambda: TX_A)


def test_sdk_write_accepted_by_node_but_receipt_unreadable_keeps_the_hash():
    client, post, journal, account = client_with({
        "eth_getTransactionCount": "0x0",
        "eth_estimateGas": "0x5208",
        "eth_sendRawTransaction": ETH_HASH,
        "eth_getTransactionReceipt": requests.exceptions.ReadTimeout("stall"),
    })
    g = h.WriteGuard(["assess"], journal)
    sub = g.submit("assess", lambda: client.write_contract(address=CONTRACT, function_name="request_assessment",
                                                           account=account, args=["VC-000001"], leader_only=False))
    assert (sub.category, sub.eth_tx_hash) == (h.SUBMITTED_UNCONFIRMED, ETH_HASH)
    assert post.methods().count("eth_sendRawTransaction") == 1


def test_malformed_tx_id_is_not_treated_as_submitted():
    g, _ = guard()
    assert g.submit("w1", lambda: None).category == h.SUBMITTED_UNCONFIRMED
    assert g.halted


# -- 6. Runner against a scripted fake client ---------------------------------


class FakeVeriCourt:
    """Scripted stand-in for the client: minimal case state, scripted assessment transactions."""

    def __init__(self, assessment_script, assessment_effect=None):
        self.assessment_script = assessment_script
        self.assessment_effect = assessment_effect
        self.scripts = {}
        self.sent = []
        self.case_count = 0
        self.cases = {}
        self.read_errors = {}
        self.reads = []
        self.now = lambda: 0  # chain clock (epoch s); runner_for ties it to the fake local clock
        self.calls = []  # (chain time, function) for every read and write, in order
        self.deadline_check_extra_s = 0  # > 0 simulates a chain clock the harness could not foresee
        self.write_errors = {}  # function -> callable(fake) raising during submission

    def _new_tx(self, script):
        tx_id = "0x" + f"{len(self.scripts) + 1:064x}"
        self.scripts[tx_id] = list(script)
        return tx_id

    def get_transaction(self, tx_id):
        script = self.scripts[tx_id]
        item = script.pop(0) if len(script) > 1 else script[0]
        if isinstance(item, Exception):
            raise item
        return copy.deepcopy(item)

    def deploy_contract(self, code, account, leader_only):
        assert leader_only is False and "class VeriCourt" in code
        self.sent.append("deploy")
        return self._new_tx([tx("PENDING", result="IDLE"), tx("ACCEPTED", data={"contract_address": CONTRACT})])

    def write_contract(self, address, function_name, account, args, leader_only):
        assert leader_only is False and address == CONTRACT
        self.sent.append(function_name)
        self.calls.append((self.now(), function_name))
        if function_name in self.write_errors:
            self.write_errors[function_name](self)
        if function_name == "create_case":
            self.case_count += 1
            cid = f"VC-{self.case_count:06d}"
            created = int(self.now())
            self.cases[cid] = {"claimant": account.address, "respondent": args[0], "title": args[2],
                               "status": "AWAITING_RESPONSE", "evidence": 0, "attempts": 0, "assessment": None,
                               "issues": [{"issue_id": f"I{i + 1}"} for i in range(len(args[7]))],
                               "created_at": created, "reply_deadline": created + args[8],
                               "response_state": "PENDING", "lock_reason": "", "locked_at": 0}
            return self._new_tx([tx("ACCEPTED", payload=json.dumps(cid))])
        case = self.cases[args[0]]
        if function_name == "submit_evidence":
            case["evidence"] += 1
            return self._new_tx([tx("ACCEPTED", payload=json.dumps(f"E{case['evidence']}"))])
        if function_name == "submit_reply":
            case.update(status="READY_FOR_ASSESSMENT", response_state="SUBMITTED", lock_reason="REPLY_SUBMITTED",
                        locked_at=int(self.now()))
            return self._new_tx([tx("ACCEPTED")])
        if function_name == "process_reply_deadline":
            now = int(self.now())
            if now <= case["reply_deadline"] + self.deadline_check_extra_s:  # mirrors the contract's strict check
                return self._new_tx([tx("ACCEPTED", code="rollback", payload="reply deadline has not passed", execution="ERROR")])
            case.update(status="READY_FOR_ASSESSMENT", response_state="NO_RESPONSE_BY_DEADLINE",
                        lock_reason="REPLY_WINDOW_EXPIRED", locked_at=now)
            return self._new_tx([tx("ACCEPTED")])
        if function_name == "request_assessment":
            if self.assessment_effect:
                self.assessment_effect(case)
            return self._new_tx(self.assessment_script)
        raise AssertionError(function_name)

    def read_contract(self, address, function_name, args, transaction_hash_variant):
        self.reads.append(function_name)
        self.calls.append((self.now(), function_name))
        if function_name in self.read_errors:
            raise self.read_errors[function_name]
        if function_name == "get_case_count":
            return self.case_count
        case = self.cases[args[0]]
        decided = case["assessment"] is not None
        return {
            "get_case": {"claimant": case["claimant"], "respondent": case["respondent"], "title": case["title"],
                         "status": case["status"], "issues": case["issues"], "snapshot_digest": "digest",
                         "created_at": case["created_at"], "reply_deadline": case["reply_deadline"]},
            "get_case_status": {"status": case["status"], "snapshot_locked": case["status"] != "AWAITING_RESPONSE",
                                "response_state": case["response_state"], "lock_reason": case["lock_reason"],
                                "locked_at": case["locked_at"], "reply_deadline": case["reply_deadline"]},
            "get_case_evidence": [],
            "get_case_history": [],
            "get_assessment_status": {"status": case["status"], "attempts": case["attempts"],
                                      "last_error": case.get("last_error", "")},
            "get_assessment": dict(case["assessment"], exists=True) if decided else {"exists": False},
        }[function_name]


EPOCH = 1_800_000_000  # local wall clock = EPOCH + fake monotonic time


def runner_for(fake, keys, tmp_path, chain_offset_s=0.0, **t):
    """``chain_offset_s``: how far the fake chain clock runs ahead of (or behind) the local clock."""
    fc = FakeClock()
    t = timeouts(**t)
    plan = ["deploy"] + [n for k in keys for n in FIXTURES[k].write_names()]
    g = h.WriteGuard(plan, h.RequestJournal())
    echoed = []
    log = h.StepLog(tmp_path / "run.json", echo=echoed.append)

    def wall():
        return EPOCH + fc.t

    fake.now = lambda: wall() + chain_offset_s
    fake.fc = fc
    fake.journal = g._journal
    r = h.Runner(fake, g, log, h.RunBudget(t.run_budget_s, clock=fc.clock), t, clock=fc.clock, sleep=fc.sleep, wall=wall)
    return r, g, plan, log


ALICE, BOB = create_account(), create_account()


def store_clear_supported(case):
    case["status"], case["attempts"] = "DECIDED", 1
    case["assessment"] = {"outcome": "CLAIM_SUPPORTED", "snapshot_digest": "digest",
                          "issue_findings": [{"issue_id": "I1", "determination": "SUPPORTED",
                                              "supporting_evidence_ids": ["E1", "E2"], "counter_evidence_ids": []}]}


def test_runner_full_plan_success_and_disagreement(tmp_path):
    fake = FakeVeriCourt(None)
    r, g, plan, log = runner_for(fake, ["clear", "ambiguous"], tmp_path)
    address = r.deploy("class VeriCourt: ...", ALICE)
    fake.assessment_script = [tx("PENDING", result="IDLE"), tx("ACCEPTED", payload='"CLAIM_SUPPORTED"'), tx("FINALIZED", payload='"CLAIM_SUPPORTED"')]
    fake.assessment_effect = store_clear_supported
    clear = r.run_fixture(CLEAR_CUT, address, ALICE, BOB, evaluate=lambda c, a: evaluate_expectation("clear", c, a))
    fake.assessment_script = [tx("UNDETERMINED", result="MAJORITY_DISAGREE"), tx("FINALIZED", result="MAJORITY_DISAGREE")]
    fake.assessment_effect = None
    amb = r.run_fixture(AMBIGUOUS, address, ALICE, BOB, evaluate=lambda c, a: evaluate_expectation("ambiguous", c, a))

    assert r.problems == [] and g.halted is None
    assert g.attempted == plan and len(plan) == 11
    assert fake.sent.count("request_assessment") == 2  # one per fixture, never repeated
    assert (clear["consensus_category"], clear["outcome"], clear["expectation"]["met"]) == (h.ACCEPTED_SUCCESS, "CLAIM_SUPPORTED", True)
    assert clear["finality"] == h.FINALIZED_SUCCESS
    assert (amb["consensus_category"], amb["outcome"], amb["expectation"]["met"]) == (h.VALIDATOR_DISAGREEMENT, None, True)
    assert amb["finality"] == h.VALIDATOR_DISAGREEMENT
    steps = [s["step"] for s in json.loads((tmp_path / "run.json").read_text())["steps"]]
    assert "clear.reads_latest_final" in steps and "ambiguous.reads_latest_final" in steps


def test_runner_assessment_timeout_halts_and_blocks_all_later_writes(tmp_path):
    fake = FakeVeriCourt([tx("PROPOSING", result="IDLE")])  # never decides
    r, g, _, _ = runner_for(fake, ["clear", "ambiguous"], tmp_path, assessment_decision_timeout_s=30.0)
    address = r.deploy("class VeriCourt: ...", ALICE)
    with pytest.raises(h.HarnessStop):
        r.run_fixture(CLEAR_CUT, address, ALICE, BOB)
    assert any(h.TIMED_OUT_UNKNOWN in p for p in r.problems)
    sent, reads = list(fake.sent), list(fake.reads)
    with pytest.raises(h.HarnessStop, match="not starting ambiguous"):
        r.run_fixture(AMBIGUOUS, address, ALICE, BOB)
    assert fake.sent == sent  # nothing further was submitted
    assert fake.reads == reads  # and nothing further was even read
    assert fake.sent.count("request_assessment") == 1


@pytest.mark.parametrize("script", [[tx("PROPOSING", result="IDLE")], [tx("SOMETHING_NEW")]])
def test_runner_write_itself_stops_on_unknown_status(tmp_path, script):
    """Runner.write stops on TIMED_OUT_UNKNOWN / UNRECOGNIZED, whatever the caller does next."""
    fake = FakeVeriCourt(None)
    r, g, _, _ = runner_for(fake, ["clear"], tmp_path, write_decision_timeout_s=30.0)
    tx_id = fake._new_tx(script)
    with pytest.raises(h.HarnessStop):
        r.write("deploy", lambda: tx_id, r.t.write_decision_timeout_s)
    assert g.halted and tx_id in r.problems[0]
    assert h.TIMED_OUT_UNKNOWN in r.problems[0] or h.UNRECOGNIZED in r.problems[0]


def test_runner_ordinary_write_disagreement_stops(tmp_path):
    fake = FakeVeriCourt([tx("ACCEPTED")])
    r, g, _, _ = runner_for(fake, ["clear"], tmp_path)
    address = r.deploy("class VeriCourt: ...", ALICE)
    original = fake.write_contract

    def flaky(address, function_name, account, args, leader_only):
        tx_id = original(address, function_name, account, args, leader_only)
        if function_name == "submit_evidence":
            fake.scripts[tx_id] = [tx("UNDETERMINED", result="MAJORITY_DISAGREE")]
        return tx_id

    fake.write_contract = flaky
    with pytest.raises(h.HarnessStop):
        r.run_fixture(CLEAR_CUT, address, ALICE, BOB)
    assert g.halted and "VALIDATOR_DISAGREEMENT" in r.problems[0]
    assert fake.sent == ["deploy", "create_case", "submit_evidence"]


def test_runner_disagreement_with_changed_state_is_a_problem(tmp_path):
    fake = FakeVeriCourt([tx("UNDETERMINED", result="MAJORITY_DISAGREE")], assessment_effect=store_clear_supported)
    r, _, _, _ = runner_for(fake, ["clear"], tmp_path)
    with pytest.raises(h.HarnessStop):
        r.run_fixture(CLEAR_CUT, r.deploy("class VeriCourt: ...", ALICE), ALICE, BOB)
    assert "case state changed" in r.problems[0]


def test_runner_read_timeout_is_reported_as_read_timeout(tmp_path):
    fake = FakeVeriCourt([tx("ACCEPTED")])
    fake.read_errors["get_case_count"] = h.RpcError("gen_call", h.READ_TIMEOUT, "stall")
    r, g, _, log = runner_for(fake, ["clear"], tmp_path)
    with pytest.raises(h.HarnessStop):
        r.run_fixture(CLEAR_CUT, r.deploy("class VeriCourt: ...", ALICE), ALICE, BOB)
    assert "READ_TIMEOUT" in r.problems[0] and "get_case_count" in r.problems[0]
    assert fake.sent == ["deploy"]  # no write after the failed read


def test_runner_evidence_id_mismatch_stops(tmp_path):
    fake = FakeVeriCourt([tx("ACCEPTED")])
    r, _, _, _ = runner_for(fake, ["clear"], tmp_path)
    address = r.deploy("class VeriCourt: ...", ALICE)
    original = fake.write_contract

    def wrong_id(address, function_name, account, args, leader_only):
        tx_id = original(address, function_name, account, args, leader_only)
        if function_name == "submit_evidence":
            fake.scripts[tx_id] = [tx("ACCEPTED", payload='"E9"')]
        return tx_id

    fake.write_contract = wrong_id
    with pytest.raises(h.HarnessStop):
        r.run_fixture(CLEAR_CUT, address, ALICE, BOB)
    assert "returned evidence id 'E9'" in r.problems[0]


def test_run_budget_stops_before_starting_an_operation(tmp_path):
    fake = FakeVeriCourt([tx("ACCEPTED")])
    r, _, _, _ = runner_for(fake, ["clear"], tmp_path, run_budget_s=0.001)
    r.budget.deadline = r._clock() - 1
    with pytest.raises(h.HarnessStop, match="run budget exhausted before deploy"):
        r.deploy("class VeriCourt: ...", ALICE)
    assert fake.sent == []


# -- 7. Log, config, plan -------------------------------------------------------


def test_step_log_is_written_after_every_step_and_scrubs_secrets(tmp_path):
    account = create_account()
    key = account.key.hex()
    echoed = []
    log = h.StepLog(tmp_path / "log.json", echo=echoed.append)
    log.register_secret(key)
    log.record("one", error=f"failure mentioning {key} and 0x{key.removeprefix('0x')}")
    on_disk = (tmp_path / "log.json").read_text()
    assert "one" in on_disk and key.removeprefix("0x") not in on_disk
    assert key.removeprefix("0x") not in "".join(echoed)
    assert "[REDACTED]" in on_disk
    log.record("two")
    assert [s["step"] for s in json.loads((tmp_path / "log.json").read_text())["steps"]] == ["one", "two"]


def test_timeouts_from_env_reads_only_its_own_variables():
    env = {"VERICOURT_HTTP_READ_TIMEOUT_S": "45", "VERICOURT_MAX_CONSECUTIVE_READ_FAILURES": "5",
           "PRIVATE_KEY": "0xdeadbeef", "VERICOURT_UNRELATED": "x"}
    t = h.Timeouts.from_env(env)
    assert (t.http_read_timeout_s, t.max_consecutive_read_failures) == (45.0, 5)
    assert "deadbeef" not in json.dumps(t.as_dict())
    with pytest.raises(ValueError):
        h.Timeouts.from_env({"VERICOURT_FINALITY_TIMEOUT_S": "soon"})
    with pytest.raises(ValueError):
        h.Timeouts.from_env({"VERICOURT_POLL_INTERVAL_S": "0"})
    with pytest.raises(ValueError):
        h.Timeouts.from_env({"VERICOURT_POLL_INTERVAL_S": "0.5"})  # below request spacing


def test_default_plan_and_fixture_selection():
    import test_studionet_smoke as smoke

    plan = smoke.planned_writes(smoke.selected_fixtures({}))
    assert plan[0] == "deploy" and len(plan) == 11 and len(set(plan)) == 11
    assert plan[1:6] == ["clear.create_case", "clear.submit_evidence_E1", "clear.submit_evidence_E2",
                         "clear.submit_reply", "clear.request_assessment"]
    assert smoke.planned_writes(smoke.selected_fixtures({"VERICOURT_FIXTURES": "ambiguous"}))[1] == "ambiguous.create_case"
    for bad in ("", "clear,clear", "clear,unknown"):
        with pytest.raises(ValueError):
            smoke.selected_fixtures({"VERICOURT_FIXTURES": bad})


# -- 8. No-reply path (Phase 2.17) ------------------------------------------------
#
# Fake chain and fake clock. These test the harness's sequencing, waiting and
# classification only; they say nothing about GenLayer consensus.


def store_inconclusive(case):
    case["status"], case["attempts"] = "DECIDED", 1
    case["assessment"] = {"outcome": "INCONCLUSIVE", "snapshot_digest": "digest",
                          "issue_findings": [{"issue_id": "I1", "determination": "UNRESOLVED",
                                              "supporting_evidence_ids": [], "counter_evidence_ids": []}]}


AGREED_INCONCLUSIVE = [tx("ACCEPTED", payload='"INCONCLUSIVE"'), tx("FINALIZED", payload='"INCONCLUSIVE"')]


def no_reply_run(tmp_path, script=None, effect=store_inconclusive, **kw):
    fake = FakeVeriCourt(AGREED_INCONCLUSIVE if script is None else script, effect)
    r, g, plan, log = runner_for(fake, ["no_reply"], tmp_path, **kw)
    return fake, r, g, plan, log, r.deploy("class VeriCourt: ...", ALICE)


def times_of(fake, function):
    return [t for t, f in fake.calls if f == function]


def evaluate_no_reply(category, assessment):
    return evaluate_expectation("no_reply", category, assessment)


def test_no_reply_path_skips_reply_and_expires_the_deadline_once_after_it(tmp_path):
    fake, r, g, plan, _, address = no_reply_run(tmp_path)
    result = r.run_fixture(NO_REPLY, address, ALICE, BOB, evaluate=evaluate_no_reply)
    assert r.problems == [] and g.attempted == plan
    assert fake.sent == ["deploy", "create_case", "submit_evidence", "submit_evidence",
                         "process_reply_deadline", "request_assessment"]
    case = fake.cases["VC-000001"]
    (processed_at,) = times_of(fake, "process_reply_deadline")
    assert processed_at > case["reply_deadline"] + r.t.deadline_margin_s - 1
    # Nothing is sent or read while waiting out the window.
    assert not [f for t, f in fake.calls if case["created_at"] + 60 < t < case["reply_deadline"]]
    assert (result["consensus_category"], result["outcome"], result["expectation"]["met"]) == (h.ACCEPTED_SUCCESS, "INCONCLUSIVE", True)
    steps = [s["step"] for s in json.loads((tmp_path / "run.json").read_text())["steps"]]
    assert steps.index("no_reply.wait_for_reply_deadline") < steps.index("no_reply.process_reply_deadline") \
        < steps.index("no_reply.status_after_deadline_processing") < steps.index("no_reply.request_assessment")
    # The guard refuses any second deadline-processing or assessment submission.
    for name in ("no_reply.process_reply_deadline", "no_reply.request_assessment"):
        with pytest.raises(h.HarnessStop):
            g.submit(name, lambda: TX_A)


def test_reply_fixtures_still_reply_and_never_wait(tmp_path):
    fake = FakeVeriCourt([tx("ACCEPTED", payload='"CLAIM_SUPPORTED"'), tx("FINALIZED", payload='"CLAIM_SUPPORTED"')],
                         store_clear_supported)
    r, _, _, _ = runner_for(fake, ["clear"], tmp_path)
    r.run_fixture(CLEAR_CUT, r.deploy("class VeriCourt: ...", ALICE), ALICE, BOB)
    assert "submit_reply" in fake.sent and "process_reply_deadline" not in fake.sent
    assert sum(fake.fc.sleeps) < 600  # only polling sleeps, no deadline wait
    steps = [s["step"] for s in json.loads((tmp_path / "run.json").read_text())["steps"]]
    assert "clear.wait_for_reply_deadline" not in steps


@pytest.mark.parametrize("offset", [-250.0, 0.0, 250.0])
def test_deadline_is_respected_whatever_the_clock_offset(tmp_path, offset):
    fake, r, _, _, _, address = no_reply_run(tmp_path, chain_offset_s=offset)
    r.run_fixture(NO_REPLY, address, ALICE, BOB)
    assert r.problems == []
    (processed_at,) = times_of(fake, "process_reply_deadline")
    assert processed_at > fake.cases["VC-000001"]["reply_deadline"]  # on the chain's own clock


def test_clock_offset_beyond_the_limit_stops_before_deadline_processing(tmp_path):
    fake, r, g, _, _, address = no_reply_run(tmp_path, chain_offset_s=1000.0)
    with pytest.raises(h.HarnessStop):
        r.run_fixture(NO_REPLY, address, ALICE, BOB)
    assert "max_clock_skew_s" in r.problems[0] and g.halted
    assert "process_reply_deadline" not in fake.sent and "request_assessment" not in fake.sent


def test_unexpected_early_rejection_is_an_execution_failure_and_is_not_retried(tmp_path):
    fake, r, _, _, _, address = no_reply_run(tmp_path)
    fake.deadline_check_extra_s = 100_000  # the chain disagrees with the harness's estimate
    with pytest.raises(h.HarnessStop):
        r.run_fixture(NO_REPLY, address, ALICE, BOB)
    assert h.ACCEPTED_EXECUTION_FAILED in r.problems[0]
    assert fake.sent.count("process_reply_deadline") == 1 and "request_assessment" not in fake.sent


def test_case_no_longer_awaiting_response_stops_before_processing(tmp_path):
    fake, r, _, _, _, address = no_reply_run(tmp_path)
    original = fake.read_contract

    def replied_meanwhile(address, function_name, args, transaction_hash_variant):
        if function_name == "get_case_status" and "process_reply_deadline" not in fake.sent:
            fake.cases[args[0]].update(status="READY_FOR_ASSESSMENT", response_state="SUBMITTED")
        return original(address, function_name, args, transaction_hash_variant)

    fake.read_contract = replied_meanwhile
    with pytest.raises(h.HarnessStop):
        r.run_fixture(NO_REPLY, address, ALICE, BOB)
    assert "no longer awaiting a response" in r.problems[0]
    assert "process_reply_deadline" not in fake.sent


def test_accepted_deadline_processing_with_wrong_resulting_state_stops(tmp_path):
    fake, r, _, _, _, address = no_reply_run(tmp_path)
    original = fake.write_contract

    def no_effect(address, function_name, account, args, leader_only):
        if function_name == "process_reply_deadline":
            fake.sent.append(function_name)
            return fake._new_tx([tx("ACCEPTED")])  # "succeeds" but the case is not expired or locked
        return original(address, function_name, account, args, leader_only)

    fake.write_contract = no_effect
    with pytest.raises(h.HarnessStop):
        r.run_fixture(NO_REPLY, address, ALICE, BOB)
    assert "not expired and locked as expected" in r.problems[0]
    assert "request_assessment" not in fake.sent


def test_run_budget_too_short_for_the_wait_stops_before_waiting(tmp_path):
    fake, r, _, _, _, address = no_reply_run(tmp_path, run_budget_s=2000.0)
    with pytest.raises(h.HarnessStop):
        r.run_fixture(NO_REPLY, address, ALICE, BOB)
    assert "cannot cover" in r.problems[0]
    assert "process_reply_deadline" not in fake.sent and sum(fake.fc.sleeps) < 100


def test_minimum_run_budget_and_margin_floor():
    t = h.Timeouts()
    need = h.minimum_run_budget_s([NO_REPLY], t)
    assert need >= 3600 + t.deadline_margin_s + t.max_clock_skew_s + t.assessment_decision_timeout_s + t.finality_timeout_s
    assert need > t.run_budget_s  # the default budget is refused: a no-reply run must raise it explicitly
    assert h.minimum_run_budget_s([CLEAR_CUT, AMBIGUOUS], t) == 0  # existing fixtures unchanged
    with pytest.raises(ValueError, match="deadline_margin_s"):
        h.Timeouts.from_env({"VERICOURT_DEADLINE_MARGIN_S": "5"})  # the wait past the deadline cannot be removed


def test_chain_clock_offset_bounds():
    assert h.chain_clock_offset(1000, 990.0, 1004.0) == (-4.0, 10.0)
    with pytest.raises(ValueError):
        h.chain_clock_offset(1000, 1004.0, 990.0)


def test_uncertain_deadline_processing_submission_stops_without_retry(tmp_path):
    fake, r, _, _, log, address = no_reply_run(tmp_path)

    def send_times_out(f):
        f.journal.add("eth_sendRawTransaction", h.READ_TIMEOUT, 60.0)
        raise h.RpcError("eth_sendRawTransaction", h.READ_TIMEOUT, "stall")

    fake.write_errors["process_reply_deadline"] = send_times_out
    with pytest.raises(h.HarnessStop):
        r.run_fixture(NO_REPLY, address, ALICE, BOB)
    assert h.SUBMISSION_UNCERTAIN in r.problems[0]
    assert fake.sent.count("process_reply_deadline") == 1 and "request_assessment" not in fake.sent
    entry = [s for s in log.steps if s["step"] == "no_reply.process_reply_deadline"][0]
    assert entry["result"] == h.SUBMISSION_UNCERTAIN


def _attempt_failed(case):
    case["attempts"], case["last_error"] = 1, "INVALID_MODEL_OUTPUT"


@pytest.mark.parametrize(
    "script, effect, timeout, logged, recorded, stored",
    [
        (AGREED_INCONCLUSIVE, store_inconclusive, 120.0, h.ACCEPTED_SUCCESS, True, "INCONCLUSIVE"),
        ([tx("ACCEPTED", payload='"ATTEMPT_FAILED"'), tx("FINALIZED", payload='"ATTEMPT_FAILED"')], _attempt_failed,
         120.0, h.ACCEPTED_SUCCESS, True, None),  # agreed failed attempt: decided, but nothing stored
        ([tx("UNDETERMINED", result="MAJORITY_DISAGREE"), tx("FINALIZED", result="MAJORITY_DISAGREE")], None,
         120.0, h.VALIDATOR_DISAGREEMENT, True, None),
        ([tx("UNDETERMINED", result="NO_MAJORITY"), tx("FINALIZED", result="NO_MAJORITY")], None,
         120.0, h.UNDETERMINED, True, None),
        ([tx("PROPOSING", result="IDLE")], None, 30.0, h.TIMED_OUT_UNKNOWN, False, None),
        ([h.RpcError("eth_getTransactionByHash", h.READ_TIMEOUT, "stall")], None, 120.0, h.READ_FAILURE, False, None),
    ],
)
def test_no_reply_assessment_results_are_logged_distinctly(tmp_path, script, effect, timeout, logged, recorded, stored):
    fake, r, _, _, log, address = no_reply_run(tmp_path, script=script, effect=effect, assessment_decision_timeout_s=timeout)
    if recorded:
        result = r.run_fixture(NO_REPLY, address, ALICE, BOB, evaluate=evaluate_no_reply)
        assert r.problems == []
        assert result["consensus_category"] == logged and result["outcome"] == stored
        if stored is None:  # never reported as a stored (successful) assessment
            assert result["case_status"] == "READY_FOR_ASSESSMENT"
    else:
        with pytest.raises(h.HarnessStop):
            r.run_fixture(NO_REPLY, address, ALICE, BOB)
        assert logged in r.problems[0] and "no_reply" not in r.results
    entry = [s for s in log.steps if s["step"] == "no_reply.request_assessment"][0]
    assert entry["result"] == logged
    assert fake.sent.count("request_assessment") == 1


def test_no_reply_expectation_flags_a_silence_based_finding():
    supported = {"outcome": "CLAIM_SUPPORTED", "issue_findings": [
        {"issue_id": "I1", "determination": "SUPPORTED", "supporting_evidence_ids": ["E1"], "counter_evidence_ids": []}]}
    verdict = evaluate_expectation("no_reply", h.ACCEPTED_SUCCESS, supported)
    assert verdict["met"] is False and "H2" in verdict["safety_finding"]
    assert evaluate_expectation("no_reply", h.VALIDATOR_DISAGREEMENT, None)["met"] is True
