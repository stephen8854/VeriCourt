"""Bounded, non-retrying building blocks for the VeriCourt StudioNet harness (Phase 2.13).

Importing this module makes no network request. Everything here is plain
Python so it can be tested offline (tests/harness/).

Why this exists (verified in the installed SDK sources, genlayer-py 0.16.3):

- GenLayerProvider.make_request calls ``requests.post(url, json=..., headers=...)``
  with no ``timeout``. requests then waits on the socket forever. Every
  genlayer-py call (reads, writes, receipt polls) and every web3 call made
  through the client goes through that one method. The Phase 2.8 run hung in
  an SSL read inside it for ~29 minutes.
- ``wait_for_transaction_receipt(status=ACCEPTED)`` returns on any *decided*
  status (ACCEPTED, UNDETERMINED, LEADER_TIMEOUT, VALIDATORS_TIMEOUT, CANCELED,
  FINALIZED). Its retry exhaustion and RPC failures both raise GenLayerError.
- gltest's ``tx_execution_succeeded`` inspects only the leader receipt; it is
  True for a transaction that validators rejected (Phase 2.8: UNDETERMINED,
  MAJORITY_DISAGREE, leader execution SUCCESS).

This module therefore (1) swaps in a provider that passes requests' supported
``timeout=(connect, read)`` argument, (2) polls with its own finite deadline,
(3) classifies transactions from status, consensus result and the leader's
execution result together, and (4) refuses to submit any write twice.
"""

from __future__ import annotations

import base64
import copy
import json
import os
import re
import time
from dataclasses import dataclass, field, fields
from pathlib import Path
from typing import Any, Callable, Mapping, Optional

import requests
from genlayer_py.client import GenLayerClient
from genlayer_py.exceptions import GenLayerError
from genlayer_py.provider import GenLayerProvider

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

_ENV_PREFIX = "VERICOURT_"
# Floor for Timeouts.deadline_margin_s: configuration can lengthen the wait past
# the reply deadline but never remove it.
MIN_DEADLINE_MARGIN_S = 30.0


@dataclass(frozen=True)
class Timeouts:
    """Every potentially blocking operation and its bound, in seconds.

    Override any field with an environment variable named VERICOURT_ plus the
    upper-cased field name, e.g. VERICOURT_HTTP_READ_TIMEOUT_S=45.
    """

    # One HTTP request (requests' (connect, read) timeout). The read timeout is
    # the longest silence allowed between bytes, not a cap on the total time.
    http_connect_timeout_s: float = 10.0
    http_read_timeout_s: float = 60.0
    # Minimum spacing between requests, keeping the harness under StudioNet's
    # 60 requests/minute per-IP limit even inside SDK-internal polling loops.
    min_request_spacing_s: float = 1.1
    # Polling deadlines (each also capped by the run budget).
    write_decision_timeout_s: float = 300.0
    assessment_decision_timeout_s: float = 900.0
    finality_timeout_s: float = 900.0
    poll_interval_s: float = 6.0
    # Consecutive failed status reads that end a poll with READ_FAILURE.
    max_consecutive_read_failures: int = 3
    # Whole run; checked before every operation is started.
    run_budget_s: float = 5400.0
    # No-reply fixtures (Phase 2.17): extra time past the on-chain reply deadline,
    # judged on the pessimistic chain-clock estimate, before process_reply_deadline
    # is sent; and the largest local-vs-chain clock offset the harness accepts.
    deadline_margin_s: float = 120.0
    max_clock_skew_s: float = 300.0

    @classmethod
    def from_env(cls, env: Mapping[str, str]) -> "Timeouts":
        values: dict[str, Any] = {}
        for f in fields(cls):
            raw = env.get(_ENV_PREFIX + f.name.upper())
            if raw is None:
                continue
            try:
                value = int(raw) if f.type in (int, "int") else float(raw)
            except ValueError:
                raise ValueError(f"{_ENV_PREFIX}{f.name.upper()} must be a number") from None
            values[f.name] = value
        result = cls(**values)
        result.validate()
        return result

    def validate(self) -> None:
        for f in fields(self):
            if getattr(self, f.name) <= 0:
                raise ValueError(f"{f.name} must be positive")
        if self.poll_interval_s < self.min_request_spacing_s:
            raise ValueError("poll_interval_s must be at least min_request_spacing_s")
        if self.deadline_margin_s < MIN_DEADLINE_MARGIN_S:
            raise ValueError(f"deadline_margin_s must be at least {MIN_DEADLINE_MARGIN_S}")

    def as_dict(self) -> dict[str, Any]:
        return {f.name: getattr(self, f.name) for f in fields(self)}


# Not configurable through genlayer-py 0.16.3: _send_transaction calls
# web3's wait_for_transaction_receipt(tx_hash) with its defaults.
SDK_SEND_RECEIPT_TIMEOUT_S = 120.0

# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------

# RpcError.kind values. Only the two timeout kinds are timeouts.
CONNECT_TIMEOUT = "connect_timeout"
READ_TIMEOUT = "read_timeout"
TRANSPORT_ERROR = "transport_error"
INVALID_RESPONSE = "invalid_response"
RPC_ERROR = "rpc_error"
TIMEOUT_KINDS = (CONNECT_TIMEOUT, READ_TIMEOUT)


class RpcError(GenLayerError):
    """One JSON-RPC request failed. Subclasses GenLayerError so SDK code paths behave as before."""

    def __init__(self, method: str, kind: str, detail: str):
        self.method = method
        self.kind = kind
        self.detail = detail
        super().__init__(f"{method}: {kind}: {detail}")

    @property
    def is_timeout(self) -> bool:
        return self.kind in TIMEOUT_KINDS


class HarnessStop(Exception):
    """The harness refuses to continue (duplicate write, halted run, budget spent)."""


# ---------------------------------------------------------------------------
# Request journal and bounded provider
# ---------------------------------------------------------------------------


@dataclass
class RequestRecord:
    seq: int
    method: str
    outcome: str  # "ok" or an RpcError kind
    seconds: float
    # Only for eth_sendRawTransaction answered with a result: the Ethereum-level
    # hash the node returned. Request params are never stored.
    result_ref: Optional[str] = None


class RequestJournal:
    """Append-only record of every RPC request the bounded provider made."""

    def __init__(self) -> None:
        self.records: list[RequestRecord] = []

    def add(self, method: str, outcome: str, seconds: float, result_ref: Optional[str] = None) -> None:
        self.records.append(RequestRecord(len(self.records), method, outcome, round(seconds, 3), result_ref))

    def mark(self) -> int:
        return len(self.records)

    def since(self, mark: int, method: Optional[str] = None) -> list[RequestRecord]:
        return [r for r in self.records[mark:] if method is None or r.method == method]

    def counts(self) -> dict[str, int]:
        out: dict[str, int] = {}
        for r in self.records:
            out[r.method] = out.get(r.method, 0) + 1
        return out


class BoundedProvider(GenLayerProvider):
    """GenLayerProvider with timeouts, request spacing and a journal.

    Same payload, headers and error contract as GenLayerProvider.make_request
    in genlayer-py 0.16.3, plus requests' timeout. requests does not retry
    (HTTPAdapter default Retry(0, read=False)), and neither does this class.
    """

    def __init__(
        self,
        url: str,
        timeouts: Timeouts,
        journal: RequestJournal,
        post: Callable[..., Any] = requests.post,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        super().__init__(url)
        self._timeout = (timeouts.http_connect_timeout_s, timeouts.http_read_timeout_s)
        self._spacing = timeouts.min_request_spacing_s
        self._journal = journal
        self._post = post
        self._clock = clock
        self._sleep = sleep
        self._last_start: Optional[float] = None

    def make_request(self, method, params):  # type: ignore[override]
        method = str(method)
        if self._last_start is not None:
            wait = self._last_start + self._spacing - self._clock()
            if wait > 0:
                self._sleep(wait)
        started = self._clock()
        self._last_start = started
        payload = {"jsonrpc": "2.0", "id": int(time.time() * 1000), "method": method, "params": params}
        try:
            response = self._post(
                self.url,
                json=payload,
                headers={"Content-Type": "application/json", "User-Agent": "genlayer-py"},
                timeout=self._timeout,
            )
        except requests.exceptions.ConnectTimeout as err:
            raise self._fail(method, CONNECT_TIMEOUT, started, f"no connection within {self._timeout[0]}s ({err})")
        except requests.exceptions.Timeout as err:
            raise self._fail(method, READ_TIMEOUT, started, f"no response data for {self._timeout[1]}s ({err})")
        except requests.exceptions.RequestException as err:
            raise self._fail(method, TRANSPORT_ERROR, started, str(err))
        try:
            resp = response.json()
        except ValueError:
            status = getattr(response, "status_code", "?")
            raise self._fail(method, INVALID_RESPONSE, started, f"HTTP {status}, body is not JSON")
        if not isinstance(resp, dict):
            raise self._fail(method, INVALID_RESPONSE, started, "JSON-RPC response is not an object")
        if resp.get("error"):
            err = resp.get("error") or {}
            code = err.get("code", "unknown") if isinstance(err, dict) else "unknown"
            message = err.get("message", "unknown error") if isinstance(err, dict) else str(err)
            raise self._fail(method, RPC_ERROR, started, f"code={code}: {message}")
        result_ref = None
        if method == "eth_sendRawTransaction" and isinstance(resp.get("result"), str):
            result_ref = resp["result"]
        self._journal.add(method, "ok", self._clock() - started, result_ref)
        return resp

    def _fail(self, method: str, kind: str, started: float, detail: str) -> RpcError:
        self._journal.add(method, kind, self._clock() - started)
        return RpcError(method, kind, f"{detail} [endpoint {self.url}]")


def make_client(chain, rpc_url: str, account, timeouts: Timeouts, journal: RequestJournal, **provider_kwargs) -> GenLayerClient:
    """A GenLayerClient whose every request (genlayer-py and web3) uses BoundedProvider.

    GenLayerClient.__init__ makes no request; create_client() would call
    sim_getConsensusContract through the unbounded provider first, so it is
    not used. The chain object is copied because create_client and
    initialize_consensus_smart_contract mutate the shared module-level chain.
    """
    chain = copy.deepcopy(chain)
    chain.rpc_urls = {"default": {"http": [rpc_url]}}
    client = GenLayerClient(chain, account)
    provider = BoundedProvider(rpc_url, timeouts, journal, **provider_kwargs)
    client.provider = provider
    client.w3.provider = provider
    if client.provider is not provider or client.w3.provider is not provider:
        raise RuntimeError("could not install the bounded provider")
    client.initialize_consensus_smart_contract()  # sim_getConsensusContract, now bounded
    return client


# ---------------------------------------------------------------------------
# Transaction classification
# ---------------------------------------------------------------------------

# Outcome categories. Only *_SUCCESS means a write took effect.
SUBMITTED = "SUBMITTED"  # node returned a GenLayer tx id; nothing observed yet
PENDING = "PENDING"
ACCEPTED_SUCCESS = "ACCEPTED_SUCCESS"  # decided, executed, validators agreed; not final
FINALIZED_SUCCESS = "FINALIZED_SUCCESS"
ACCEPTED_EXECUTION_FAILED = "ACCEPTED_EXECUTION_FAILED"  # validators agreed on a failed execution
FINALIZED_EXECUTION_FAILED = "FINALIZED_EXECUTION_FAILED"
VALIDATOR_DISAGREEMENT = "VALIDATOR_DISAGREEMENT"  # MAJORITY_DISAGREE: no state change
UNDETERMINED = "UNDETERMINED"  # other inconclusive ends: no majority, timeouts, cancelled
UNRECOGNIZED = "UNRECOGNIZED"  # fields this harness cannot interpret; never success
TIMED_OUT_UNKNOWN = "TIMED_OUT_UNKNOWN"  # poll deadline passed; real status unknown
READ_FAILURE = "READ_FAILURE"  # status could not be read
NOT_SUBMITTED = "NOT_SUBMITTED"  # failed before eth_sendRawTransaction was attempted
SUBMISSION_REJECTED = "SUBMISSION_REJECTED"  # node answered eth_sendRawTransaction with an error
SUBMISSION_UNCERTAIN = "SUBMISSION_UNCERTAIN"  # eth_sendRawTransaction outcome unknown (timeout/transport)
SUBMITTED_UNCONFIRMED = "SUBMITTED_UNCONFIRMED"  # node took the raw tx; no GenLayer tx id obtained

SUCCESS_CATEGORIES = (ACCEPTED_SUCCESS, FINALIZED_SUCCESS)
# Assessment outcomes that are recorded results, not harness failures.
ASSESSMENT_RECORDABLE = SUCCESS_CATEGORIES + (VALIDATOR_DISAGREEMENT, UNDETERMINED)

_PENDING_STATUSES = (
    "UNINITIALIZED",
    "PENDING",
    "ACTIVATED",
    "PROPOSING",
    "COMMITTING",
    "REVEALING",
    "APPEAL_REVEALING",
    "APPEAL_COMMITTING",
    "READY_TO_FINALIZE",
)
_INCONCLUSIVE_STATUSES = ("LEADER_TIMEOUT", "VALIDATORS_TIMEOUT", "CANCELED")
_INCONCLUSIVE_RESULTS = ("NO_MAJORITY", "TIMEOUT", "DETERMINISTIC_VIOLATION")
_RESULT_CODES = {0: "return", 1: "rollback", 2: "contract_error", 3: "error", 4: "none", 5: "no_leaders"}


def _name(value: Any) -> Optional[str]:
    if value is None:
        return None
    return str(getattr(value, "value", value))


@dataclass
class TxView:
    category: str
    status_name: Optional[str]
    result_name: Optional[str]
    final: bool
    leader_execution_result: Optional[str] = None
    leader_result_status: Optional[str] = None
    leader_result_payload: Optional[str] = None
    votes: Optional[list] = None
    detail: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {k: v for k, v in self.__dict__.items() if v is not None and v != ""}


def _leader_receipt(tx: Mapping[str, Any]) -> Optional[Mapping[str, Any]]:
    receipts = (tx.get("consensus_data") or {}).get("leader_receipt")
    if isinstance(receipts, dict):
        receipts = [receipts]
    if not isinstance(receipts, list):
        return None
    # The list can also hold the leader's own validator-mode receipt
    # (Phase 2.8: mode "validator", execution_result ERROR); use mode "leader".
    for receipt in receipts:
        if isinstance(receipt, dict) and receipt.get("mode") == "leader":
            return receipt
    return None


def _decode_result(result: Any) -> tuple[Optional[str], Optional[str]]:
    """(status, payload) of a leader result, decoded by genlayer-py or still base64."""
    if isinstance(result, dict):
        payload = result.get("payload")
        if isinstance(payload, dict):
            payload = payload.get("readable")
        return _name(result.get("status")), None if payload is None else str(payload)[:500]
    if isinstance(result, str) and result:
        try:
            raw = base64.b64decode(result, validate=True)
        except ValueError:
            return None, None
        if not raw:
            return None, None
        status = _RESULT_CODES.get(raw[0])
        payload = raw[1:].decode("utf-8", "replace")[:500] if raw[0] in (1, 2) else None
        return status, payload
    return None, None


def classify_transaction(tx: Any) -> TxView:
    """Classify one genlayer-py transaction dict. Unknown shapes are UNRECOGNIZED, never success."""
    if not isinstance(tx, Mapping):
        return TxView(UNRECOGNIZED, None, None, False, detail="transaction is not an object")
    status = _name(tx.get("status_name"))
    result = _name(tx.get("result_name"))
    final = status == "FINALIZED"
    votes = (tx.get("last_round") or {}).get("validator_votes_name") if isinstance(tx.get("last_round"), dict) else None
    view = TxView(UNRECOGNIZED, status, result, final, votes=votes)

    if status in _PENDING_STATUSES:
        view.category = PENDING
        return view
    if status in _INCONCLUSIVE_STATUSES:
        view.category = UNDETERMINED
        view.detail = f"status {status}"
        return view
    if status not in ("ACCEPTED", "UNDETERMINED", "FINALIZED"):
        view.detail = f"unknown status {status!r}"
        return view
    if result == "MAJORITY_DISAGREE":
        view.category = VALIDATOR_DISAGREEMENT
        view.detail = "validators rejected the leader's result; no state change"
        return view
    if status == "UNDETERMINED" or result in _INCONCLUSIVE_RESULTS:
        view.category = UNDETERMINED
        view.detail = f"status {status}, result {result}"
        return view
    if result != "MAJORITY_AGREE":
        view.detail = f"unexpected consensus result {result!r} for status {status}"
        return view

    leader = _leader_receipt(tx)
    if leader is None:
        view.detail = "no leader receipt"
        return view
    view.leader_execution_result = _name(leader.get("execution_result"))
    view.leader_result_status, view.leader_result_payload = _decode_result(leader.get("result"))
    if view.leader_execution_result == "SUCCESS" and view.leader_result_status == "return":
        view.category = FINALIZED_SUCCESS if final else ACCEPTED_SUCCESS
    elif view.leader_execution_result in ("ERROR",) or view.leader_result_status in ("rollback", "contract_error", "error"):
        view.category = FINALIZED_EXECUTION_FAILED if final else ACCEPTED_EXECUTION_FAILED
        view.detail = "validators agreed on a failed execution"
    else:
        view.detail = f"leader execution {view.leader_execution_result!r}, result {view.leader_result_status!r}"
    return view


# ---------------------------------------------------------------------------
# Run budget and polling
# ---------------------------------------------------------------------------


class RunBudget:
    def __init__(self, seconds: float, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self.deadline = clock() + seconds

    def remaining(self) -> float:
        return self.deadline - self._clock()

    def check(self, operation: str) -> None:
        if self.remaining() <= 0:
            raise HarnessStop(f"run budget exhausted before {operation}")


@dataclass
class PollOutcome:
    operation: str
    tx_id: str
    category: str
    view: Optional[TxView]
    polls: int
    seconds: float
    errors: list[str] = field(default_factory=list)
    detail: str = ""
    raw: Any = field(default=None, repr=False)  # last transaction read; never logged

    def as_dict(self) -> dict[str, Any]:
        return {
            "operation": self.operation,
            "tx_id": self.tx_id,
            "category": self.category,
            "polls": self.polls,
            "seconds": round(self.seconds, 1),
            "last_view": None if self.view is None else self.view.as_dict(),
            "errors": self.errors,
            "detail": self.detail,
        }


def _is_terminal(view: TxView, until: str) -> bool:
    if until == "decided":
        return view.category != PENDING
    # Finality: FINALIZED (success, failure or disagreement alike), or a state
    # that will never finalize or that this harness cannot read.
    return view.final or view.category == UNRECOGNIZED or view.status_name == "CANCELED"


def poll_transaction(
    fetch: Callable[[str], Any],
    tx_id: str,
    *,
    operation: str,
    until: str,
    timeout_s: float,
    interval_s: float,
    max_consecutive_read_failures: int,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> PollOutcome:
    """Poll one transaction until it is decided ("decided") or final ("final"), or the deadline passes.

    Never submits anything. Terminal results: the classified category,
    TIMED_OUT_UNKNOWN (deadline passed; last observation kept for the report)
    or READ_FAILURE (status unreadable N times in a row).
    """
    if until not in ("decided", "final"):
        raise ValueError("until must be 'decided' or 'final'")
    started = clock()
    deadline = started + timeout_s
    polls = 0
    consecutive_failures = 0
    errors: list[str] = []
    last: Optional[TxView] = None
    raw: Any = None
    while True:
        polls += 1
        try:
            raw = fetch(tx_id)
            last = classify_transaction(raw)
            consecutive_failures = 0
        except Exception as exc:  # any failure to read is a read failure, never a status
            consecutive_failures += 1
            errors.append(f"poll {polls}: {type(exc).__name__}: {str(exc)[:300]}")
            if consecutive_failures >= max_consecutive_read_failures:
                return PollOutcome(operation, tx_id, READ_FAILURE, last, polls, clock() - started, errors,
                                   f"{consecutive_failures} consecutive status reads failed", raw)
        else:
            if _is_terminal(last, until):
                return PollOutcome(operation, tx_id, last.category, last, polls, clock() - started, errors, "", raw)
        remaining = deadline - clock()
        if remaining <= 0:
            seen = "never read" if last is None else f"last observed {last.status_name}/{last.result_name}"
            return PollOutcome(operation, tx_id, TIMED_OUT_UNKNOWN, last, polls, clock() - started, errors,
                               f"no terminal status within {timeout_s}s ({seen}); actual status unknown", raw)
        sleep(min(interval_s, remaining))


# ---------------------------------------------------------------------------
# Writes: at most once each, in plan order, and never after a halt
# ---------------------------------------------------------------------------


@dataclass
class Submission:
    name: str
    category: str  # SUBMITTED or one of the submission failure categories
    tx_id: Optional[str] = None
    eth_tx_hash: Optional[str] = None
    error: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {k: v for k, v in self.__dict__.items() if v not in (None, "")}


class WriteGuard:
    """Enforces the approved write plan. A write name is attempted at most once."""

    def __init__(self, planned: list[str], journal: RequestJournal) -> None:
        if len(set(planned)) != len(planned):
            raise ValueError("planned write names must be unique")
        self.planned = list(planned)
        self.attempted: list[str] = []
        self.halted: Optional[str] = None
        self._journal = journal

    def halt(self, reason: str) -> None:
        if self.halted is None:
            self.halted = reason

    def submit(self, name: str, send: Callable[[], Any]) -> Submission:
        if self.halted is not None:
            raise HarnessStop(f"refusing {name}: run halted ({self.halted})")
        if name in self.attempted:
            raise HarnessStop(f"refusing {name}: already attempted once in this run")
        position = len(self.attempted)
        if position >= len(self.planned) or self.planned[position] != name:
            expected = self.planned[position] if position < len(self.planned) else "nothing"
            raise HarnessStop(f"refusing {name}: not the next approved write (expected {expected})")
        self.attempted.append(name)  # recorded before sending: a failure never re-enables it
        mark = self._journal.mark()
        try:
            tx_id = send()
        except Exception as exc:
            sends = self._journal.since(mark, "eth_sendRawTransaction")
            if not sends:
                category, eth_hash = NOT_SUBMITTED, None
            elif sends[-1].outcome == "ok":
                category, eth_hash = SUBMITTED_UNCONFIRMED, sends[-1].result_ref
            elif sends[-1].outcome == RPC_ERROR:
                category, eth_hash = SUBMISSION_REJECTED, None
            else:
                category, eth_hash = SUBMISSION_UNCERTAIN, None
            self.halt(f"{name}: {category}")
            return Submission(name, category, eth_tx_hash=eth_hash, error=f"{type(exc).__name__}: {str(exc)[:500]}")
        if not isinstance(tx_id, str) or not re.fullmatch(r"0x[0-9a-fA-F]{64}", tx_id):
            self.halt(f"{name}: unexpected tx id")
            return Submission(name, SUBMITTED_UNCONFIRMED, error=f"unexpected tx id {tx_id!r}")
        return Submission(name, SUBMITTED, tx_id=tx_id)


# ---------------------------------------------------------------------------
# Runner: one deployment, then one fixture case after another
# ---------------------------------------------------------------------------

CASE_ARG_ORDER = (
    "category", "title", "agreement_summary", "expected_deliverable", "claim",
    "requested_remedy", "issues", "reply_window_seconds",
)
EVIDENCE_ARG_ORDER = ("evidence_type", "label", "description", "content_ref", "sha256", "issue_ids")
CASE_READS = ("get_case", "get_case_evidence", "get_case_history", "get_assessment_status", "get_assessment")
ASSESSMENT_OUTCOMES = ("CLAIM_SUPPORTED", "CLAIM_PARTIALLY_SUPPORTED", "CLAIM_NOT_SUPPORTED", "INCONCLUSIVE")


def contract_address_from(tx: Any) -> Optional[str]:
    if not isinstance(tx, Mapping):
        return None
    for key in ("tx_data_decoded", "data"):
        part = tx.get(key)
        if isinstance(part, Mapping) and isinstance(part.get("contract_address"), str):
            return part["contract_address"]
    return None


def chain_clock_offset(created_at: int, local_before: float, local_after: float) -> tuple[float, float]:
    """Bounds on (chain clock - local clock) in seconds.

    ``created_at`` is the on-chain timestamp of a transaction that was submitted
    after ``local_before`` and observed decided before ``local_after`` (local
    epoch seconds), so the true offset lies in [created_at - after, created_at - before].
    """
    if local_after < local_before:
        raise ValueError("local_after precedes local_before")
    return created_at - local_after, created_at - local_before


def minimum_run_budget_s(fixtures, timeouts: "Timeouts") -> float:
    """Run budget a plan needs up front. Only no-reply fixtures add a requirement.

    Each no-reply fixture needs its full reply window, the margin, the
    worst-case clock offset, and the assessment and finality windows.
    Fixtures with a reply keep their pre-Phase 2.17 behaviour (no check).
    """
    total = 0.0
    for fx in fixtures:
        if fx.reply is None:
            total += (fx.case["reply_window_seconds"] + timeouts.deadline_margin_s + timeouts.max_clock_skew_s
                      + timeouts.assessment_decision_timeout_s + timeouts.finality_timeout_s
                      + (len(fx.write_names()) + 1) * timeouts.write_decision_timeout_s / 2)
    return total


def _unquote(payload: Optional[str]) -> Optional[str]:
    """genlayer-py renders a returned string as its JSON form, e.g. '"E1"'."""
    if payload is None:
        return None
    try:
        value = json.loads(payload)
    except ValueError:
        return payload
    return value if isinstance(value, str) else payload


class Runner:
    """Drives the approved plan. Any problem stops the run; nothing is retried.

    ``client`` needs deploy_contract, write_contract, read_contract and
    get_transaction with genlayer-py 0.16.3 signatures (a fake in offline tests).
    """

    def __init__(self, client, guard: WriteGuard, log: StepLog, budget: RunBudget, timeouts: Timeouts,
                 clock: Callable[[], float] = time.monotonic, sleep: Callable[[float], None] = time.sleep,
                 wall: Callable[[], float] = time.time) -> None:
        self.client = client
        self.guard = guard
        self.log = log
        self.budget = budget
        self.t = timeouts
        self._clock = clock
        self._sleep = sleep
        self._wall = wall  # local UTC epoch seconds; only used to estimate the chain clock
        self.problems: list[str] = []
        self.warnings: list[str] = []
        self.results: dict[str, Any] = {}

    # -- primitives -----------------------------------------------------------

    def _stop(self, problem: str) -> HarnessStop:
        self.problems.append(problem)
        self.guard.halt(problem)
        self.log.record("stopped", problem=problem)
        return HarnessStop(problem)

    def _check_budget(self, operation: str) -> None:
        """Run-budget check that, like every other stop, is recorded as a problem and halts writes."""
        try:
            self.budget.check(operation)
        except HarnessStop as exc:
            raise self._stop(str(exc)) from None

    def _poll(self, operation: str, tx_id: str, until: str, timeout_s: float) -> PollOutcome:
        self._check_budget(operation)
        return poll_transaction(
            self.client.get_transaction, tx_id,
            operation=operation, until=until,
            timeout_s=max(0.0, min(timeout_s, self.budget.remaining())),
            interval_s=self.t.poll_interval_s,
            max_consecutive_read_failures=self.t.max_consecutive_read_failures,
            clock=self._clock, sleep=self._sleep,
        )

    def write(self, name: str, send: Callable[[], Any], timeout_s: float) -> PollOutcome:
        """Submit once, then poll until decided. Raises HarnessStop on anything but a decided status."""
        self._check_budget(name)
        sub = self.guard.submit(name, send)
        if sub.category != SUBMITTED:
            self.log.record(name, result=sub.category, submission=sub.as_dict(),
                            note="not resubmitted; check the account nonce/explorer manually before any further write")
            raise self._stop(f"{name}: {sub.category}")
        tx_id = sub.tx_id
        assert tx_id is not None  # WriteGuard returns SUBMITTED only with a well-formed tx id
        self.log.record(f"{name}.submitted", tx_id=tx_id)
        outcome = self._poll(name, tx_id, "decided", timeout_s)
        self.log.record(name, result=outcome.category, **outcome.as_dict())
        if outcome.category in (TIMED_OUT_UNKNOWN, READ_FAILURE, UNRECOGNIZED):
            raise self._stop(f"{name} ({sub.tx_id}): {outcome.category}: {outcome.detail}")
        return outcome

    def write_ok(self, name: str, send: Callable[[], Any]) -> PollOutcome:
        outcome = self.write(name, send, self.t.write_decision_timeout_s)
        if outcome.category not in SUCCESS_CATEGORIES:
            raise self._stop(f"{name} ({outcome.tx_id}): {outcome.category}: {outcome.detail}")
        return outcome

    def read(self, label: str, address: str, function_name: str, args: list, variant=None) -> Any:
        from genlayer_py.types import TransactionHashVariant

        self._check_budget(label)
        variant = variant or TransactionHashVariant.LATEST_NONFINAL
        try:
            return self.client.read_contract(address=address, function_name=function_name, args=args,
                                             transaction_hash_variant=variant)
        except Exception as exc:
            kind = "READ_TIMEOUT" if isinstance(exc, RpcError) and exc.is_timeout else READ_FAILURE
            self.log.record(label, result=kind, contract=address, function=function_name, args=args,
                            variant=_name(variant), error=f"{type(exc).__name__}: {str(exc)[:500]}")
            raise self._stop(f"{label} ({function_name} on {address}): {kind}")

    def read_case(self, label: str, address: str, case_id: str, variant) -> dict[str, Any]:
        out = {fn: self.read(f"{label}.{fn}", address, fn, [case_id], variant) for fn in CASE_READS}
        self.log.record(label, variant=_name(variant), reads=out)
        return out

    def check(self, condition: bool, problem: str) -> None:
        if not condition:
            raise self._stop(problem)

    # -- plan steps -------------------------------------------------------------

    def deploy(self, code: str, account) -> str:
        outcome = self.write_ok("deploy", lambda: self.client.deploy_contract(code=code, account=account, leader_only=False))
        address = contract_address_from(outcome.raw)
        self.check(address is not None, f"deploy ({outcome.tx_id}): no contract address in transaction")
        self.log.record("deploy.address", contract_address=address)
        return address  # type: ignore[return-value]

    def run_fixture(self, fx, address: str, claimant, respondent,
                    evaluate: Optional[Callable[[str, Optional[dict]], dict]] = None) -> dict[str, Any]:
        from genlayer_py.types import TransactionHashVariant

        if self.guard.halted is not None:
            raise HarnessStop(f"not starting {fx.key}: run halted ({self.guard.halted})")
        key = fx.key
        parties = {"claimant": claimant, "respondent": respondent}

        def call(account, fn, args):
            return lambda: self.client.write_contract(address=address, function_name=fn, account=account,
                                                      args=args, leader_only=False)

        before = self.read(f"{key}.case_count_before", address, "get_case_count", [])
        case_args = [respondent.address] + [fx.case[k] for k in CASE_ARG_ORDER]
        created_window = (self._wall(), 0.0)
        self.write_ok(f"{key}.create_case", call(claimant, "create_case", case_args))
        created_window = (created_window[0], self._wall())  # local time bracketing the create transaction
        after = self.read(f"{key}.case_count_after", address, "get_case_count", [])
        self.check(after == before + 1, f"{key}: case count {before} -> {after}, expected +1")
        case_id = "VC-" + str(after).zfill(6)
        case = self.read(f"{key}.case_created", address, "get_case", [case_id])
        self.check(
            case.get("claimant", "").lower() == claimant.address.lower()
            and case.get("respondent", "").lower() == respondent.address.lower()
            and case.get("title") == fx.case["title"]
            and case.get("status") == "AWAITING_RESPONSE",
            f"{key}: {case_id} does not match the submitted case",
        )
        self.log.record(f"{key}.case_id", case_id=case_id)

        for step in fx.evidence:
            name = f"{key}.submit_evidence_{step.expected_id}"
            args = [case_id] + [step.args[k] for k in EVIDENCE_ARG_ORDER]
            outcome = self.write_ok(name, call(parties[step.party], "submit_evidence", args))
            returned = _unquote(outcome.view.leader_result_payload if outcome.view else None)
            self.check(returned == step.expected_id, f"{name}: returned evidence id {returned!r}, expected {step.expected_id}")

        if fx.reply is None:
            self._expire_reply_window(key, address, case_id, case, created_window, call(claimant, "process_reply_deadline", [case_id]))
        else:
            self.write_ok(f"{key}.submit_reply", call(respondent, "submit_reply", [case_id, fx.reply]))
            status = self.read(f"{key}.status_after_reply", address, "get_case_status", [case_id])
            self.check(status.get("status") == "READY_FOR_ASSESSMENT" and status.get("snapshot_locked") is True,
                       f"{key}: {case_id} not READY_FOR_ASSESSMENT and locked after reply: {status}")

        name = f"{key}.request_assessment"
        assessed = self.write(name, call(claimant, "request_assessment", [case_id]), self.t.assessment_decision_timeout_s)
        if assessed.category not in ASSESSMENT_RECORDABLE:
            raise self._stop(f"{name} ({assessed.tx_id}): {assessed.category}: {assessed.detail}")
        nonfinal = self.read_case(f"{key}.reads_latest_nonfinal", address, case_id, TransactionHashVariant.LATEST_NONFINAL)
        self._check_assessment_state(key, assessed, nonfinal)

        final_poll = self._poll(f"{name}.finality", assessed.tx_id, "final", self.t.finality_timeout_s)
        self.log.record(f"{name}.finality", result=final_poll.category, **final_poll.as_dict())
        final = None
        if final_poll.category == READ_FAILURE:
            raise self._stop(f"{name}.finality ({assessed.tx_id}): READ_FAILURE")
        if final_poll.view is not None and final_poll.view.final:
            final = self.read_case(f"{key}.reads_latest_final", address, case_id, TransactionHashVariant.LATEST_FINAL)
            self.check(final["get_assessment_status"] == nonfinal["get_assessment_status"],
                       f"{key}: assessment status differs between latest-nonfinal and latest-final")
        else:
            self.warnings.append(f"{name}: finality not observed ({final_poll.category}: {final_poll.detail})")

        assessment = nonfinal["get_assessment"] if nonfinal["get_assessment"].get("exists") else None
        result = {
            "case_id": case_id,
            "assessment_tx": assessed.tx_id,
            "consensus_category": assessed.category,
            "returned": _unquote(assessed.view.leader_result_payload if assessed.view else None),
            "case_status": nonfinal["get_assessment_status"].get("status"),
            "outcome": None if assessment is None else assessment.get("outcome"),
            "determinations": None if assessment is None else {
                f["issue_id"]: (f["determination"], f["supporting_evidence_ids"], f["counter_evidence_ids"])
                for f in assessment["issue_findings"]
            },
            "finality": final_poll.category,
            "expectation": None if evaluate is None else evaluate(assessed.category, assessment),
        }
        self.results[key] = result
        self.log.record(f"{key}.result", **result)
        return result

    def _expire_reply_window(self, key: str, address: str, case_id: str, case: dict, created_window: tuple,
                             send: Callable[[], Any]) -> None:
        """No-reply path: wait until the on-chain reply deadline has certainly passed, then expire it once.

        No view exposes the chain clock, so it is bounded from the create_case
        transaction: its on-chain ``created_at`` was stamped between the local
        times just before submission and just after the decision was observed.
        The harness waits on the *lower* bound of the chain clock, plus
        ``deadline_margin_s``. The contract remains the final guard: an early
        call reverts ("reply deadline has not passed"), which write_ok reports
        as an execution failure and stops on, without retrying.
        """
        deadline, created_at = case.get("reply_deadline"), case.get("created_at")
        if not (isinstance(deadline, int) and isinstance(created_at, int) and deadline > created_at):
            raise self._stop(f"{key}: {case_id} has no usable reply_deadline/created_at: {deadline!r}/{created_at!r}")
        low, high = chain_clock_offset(created_at, created_window[0], created_window[1])
        self.check(abs(low) <= self.t.max_clock_skew_s and abs(high) <= self.t.max_clock_skew_s,
                   f"{key}: chain clock offset bounds [{low:.1f}, {high:.1f}] s exceed max_clock_skew_s "
                   f"{self.t.max_clock_skew_s}; not processing the deadline")
        target = deadline + self.t.deadline_margin_s
        planned = max(0.0, target - (self._wall() + low))
        self.check(self.budget.remaining() > planned + self.t.write_decision_timeout_s,
                   f"{key}: run budget {self.budget.remaining():.0f} s cannot cover the {planned:.0f} s wait for the reply deadline")
        self.log.record(f"{key}.wait_for_reply_deadline", case_id=case_id, reply_deadline=deadline, created_at=created_at,
                        chain_offset_bounds_s=[round(low, 1), round(high, 1)], margin_s=self.t.deadline_margin_s,
                        planned_wait_s=round(planned, 1))
        while (remaining := target - (self._wall() + low)) > 0:
            self._check_budget(f"{key}.wait_for_reply_deadline")
            self._sleep(min(remaining, 60.0))  # no requests while waiting

        status = self.read(f"{key}.status_before_deadline_processing", address, "get_case_status", [case_id])
        self.log.record(f"{key}.status_before_deadline_processing", status=status)
        self.check(status.get("status") == "AWAITING_RESPONSE" and status.get("response_state") == "PENDING"
                   and status.get("snapshot_locked") is False,
                   f"{key}: {case_id} is no longer awaiting a response before deadline processing: {status}")
        self.write_ok(f"{key}.process_reply_deadline", send)
        status = self.read(f"{key}.status_after_deadline_processing", address, "get_case_status", [case_id])
        self.log.record(f"{key}.status_after_deadline_processing", status=status)
        self.check(status.get("status") == "READY_FOR_ASSESSMENT" and status.get("snapshot_locked") is True
                   and status.get("response_state") == "NO_RESPONSE_BY_DEADLINE"
                   and status.get("lock_reason") == "REPLY_WINDOW_EXPIRED"
                   and isinstance(status.get("locked_at"), int) and status["locked_at"] > deadline,
                   f"{key}: {case_id} not expired and locked as expected after deadline processing: {status}")

    def _check_assessment_state(self, key: str, assessed: PollOutcome, reads: dict[str, Any]) -> None:
        status = reads["get_assessment_status"]
        assessment = reads["get_assessment"]
        if assessed.category in SUCCESS_CATEGORIES:
            returned = _unquote(assessed.view.leader_result_payload if assessed.view else None)
            if returned == "ATTEMPT_FAILED":
                self.check(status.get("status") == "READY_FOR_ASSESSMENT" and status.get("attempts") == 1
                           and status.get("last_error") == "INVALID_MODEL_OUTPUT" and not assessment.get("exists"),
                           f"{key}: agreed failed attempt not reflected in state: {status}")
                return
            self.check(returned in ASSESSMENT_OUTCOMES, f"{key}: unexpected return value {returned!r}")
            self.check(status.get("status") == "DECIDED" and assessment.get("exists") is True
                       and assessment.get("outcome") == returned,
                       f"{key}: decided assessment not stored as returned ({returned})")
            self.check(assessment.get("snapshot_digest") == reads["get_case"].get("snapshot_digest"),
                       f"{key}: assessment snapshot digest differs from the case")
            self.check([f["issue_id"] for f in assessment["issue_findings"]]
                       == [i["issue_id"] for i in reads["get_case"]["issues"]],
                       f"{key}: findings do not cover the case issues in order")
        else:
            # Disagreement / undetermined: the runtime records nothing.
            self.check(status.get("status") == "READY_FOR_ASSESSMENT" and status.get("attempts") == 0
                       and not assessment.get("exists"),
                       f"{key}: {assessed.category} but case state changed: {status}")


# ---------------------------------------------------------------------------
# Incremental JSON log
# ---------------------------------------------------------------------------


class StepLog:
    """Written to disk after every step, so an interrupted run still leaves a log.

    Values are JSON-serialised and any registered secret string is replaced
    before anything is printed or written.
    """

    def __init__(self, path: Path, echo: Callable[[str], None] = print) -> None:
        self.path = path
        self.steps: list[dict[str, Any]] = []
        self._secrets: list[str] = []
        self._echo = echo

    def register_secret(self, value: str) -> None:
        if value:
            self._secrets.append(value)
            if value.startswith("0x"):
                self._secrets.append(value[2:])

    def _scrub(self, text: str) -> str:
        for secret in self._secrets:
            text = text.replace(secret, "[REDACTED]")
        return text

    def record(self, step: str, **data: Any) -> dict[str, Any]:
        entry = json.loads(self._scrub(json.dumps({"step": step, **data}, default=str)))
        self.steps.append(entry)
        self._echo(self._scrub(json.dumps(entry, default=str)))
        self.flush()
        return entry

    def flush(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(self._scrub(json.dumps({"steps": self.steps}, indent=2, default=str)), encoding="utf-8")
        os.replace(tmp, self.path)
