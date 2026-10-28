"""StudioNet smoke test for VeriCourt - runs only with explicit, per-run approval.

Deploys one fresh contract instance to StudioNet (chain 61999) and runs the
selected fictional fixtures (tests/integration/case_fixtures.py) through real
GenVM and real validator consensus. Per fixture:

    create_case -> submit_evidence x2 -> submit_reply -> request_assessment

Default plan (VERICOURT_FIXTURES=clear,ambiguous): 1 deploy + 2 x 5 = 11 writes.
The `no_reply` fixture runs only when selected explicitly. It skips
submit_reply, waits (without requests) until the on-chain reply deadline has
passed, then sends process_reply_deadline once; it needs a larger
VERICOURT_RUN_BUDGET_S (checked before any network activity).
The exact plan is printed in the preflight before the first write. Every write
uses one of the throwaway accounts gltest provides for the run; their keys are
registered with the log scrubber and never written. All case content is
fictional. Data written to StudioNet is public and permanent.

Phase 2.13 safety properties (harness.py; tested offline in tests/harness/):
- Every RPC request has a connect and read timeout (genlayer-py 0.16.3 sends
  none) and requests are spaced to stay under StudioNet's rate limit.
- Every wait has a finite deadline and ends in a named category; a timeout is
  reported as TIMED_OUT_UNKNOWN, never as an execution failure.
- Each planned write is attempted at most once. If a submission's fate is
  uncertain, or any write does not reach a decided, successful state, the run
  halts: no resubmission and no further writes.
- A write counts as successful only if consensus is MAJORITY_AGREE, the
  status is ACCEPTED/FINALIZED and the leader's execution returned normally.
- The JSON log in integration-logs/ is rewritten after every step.

Guards: skipped unless VERICOURT_RUN_STUDIONET=1; refuses any network other
than "studionet" and leader_only mode.

Run (only after approval):
    VERICOURT_RUN_STUDIONET=1 gltest tests/integration/test_studionet_smoke.py -v -s --network studionet
"""

import os
from datetime import datetime, timezone
from pathlib import Path

import pytest

from gltest_cli.config.general import get_general_config

from case_fixtures import DEFAULT_ORDER, FIXTURES, evaluate_expectation
from harness import (
    SDK_SEND_RECEIPT_TIMEOUT_S,
    HarnessStop,
    RequestJournal,
    RunBudget,
    Runner,
    StepLog,
    Timeouts,
    WriteGuard,
    make_client,
    minimum_run_budget_s,
)

pytestmark = pytest.mark.skipif(
    os.environ.get("VERICOURT_RUN_STUDIONET") != "1",
    reason="StudioNet smoke test requires explicit approval: set VERICOURT_RUN_STUDIONET=1",
)

ROOT = Path(__file__).resolve().parents[2]
CONTRACT_PATH = ROOT / "contracts" / "vericourt.py"
LOG_DIR = ROOT / "integration-logs"


def selected_fixtures(env) -> list[str]:
    raw = env.get("VERICOURT_FIXTURES")
    keys: list[str] = list(DEFAULT_ORDER) if raw is None else [k.strip() for k in raw.split(",") if k.strip()]
    unknown = [k for k in keys if k not in FIXTURES]
    if unknown or not keys or len(set(keys)) != len(keys):
        raise ValueError(f"VERICOURT_FIXTURES must list distinct keys from {sorted(FIXTURES)}")
    return keys


def planned_writes(keys) -> list[str]:
    return ["deploy"] + [name for k in keys for name in FIXTURES[k].write_names()]


def test_studionet_assessment_smoke(accounts):
    config = get_general_config()
    assert config.get_network_name() == "studionet", "refusing to run outside StudioNet"
    assert config.get_leader_only() is False, "leader_only would bypass validator consensus"
    timeouts = Timeouts.from_env(os.environ)
    keys = selected_fixtures(os.environ)
    plan = planned_writes(keys)
    # Checked before any network activity: a no-reply plan must fit its >= 1 h wait.
    required_budget = minimum_run_budget_s([FIXTURES[k] for k in keys], timeouts)
    assert timeouts.run_budget_s >= required_budget, (
        f"VERICOURT_RUN_BUDGET_S={timeouts.run_budget_s:.0f} is below the {required_budget:.0f} s this plan needs"
    )
    claimant, respondent = accounts[0], accounts[1]
    assert claimant.address != respondent.address

    started = datetime.now(timezone.utc).isoformat()
    log = StepLog(LOG_DIR / f"studionet-smoke-{started.replace(':', '-')}.json")
    for account in (claimant, respondent):
        log.register_secret(account.key.hex())
    journal = RequestJournal()
    budget = RunBudget(timeouts.run_budget_s)
    guard = WriteGuard(plan, journal)
    runner = None
    try:
        client = make_client(config.get_chain(), config.get_rpc_url(), claimant, timeouts, journal)
        runner = Runner(client, guard, log, budget, timeouts)
        # Read-only preflight: fresh throwaway accounts have sent nothing.
        nonces = {}
        for account in (claimant, respondent):
            budget.check("preflight nonce read")
            nonces[account.address] = client.get_current_nonce(address=account.address)
        log.record(
            "preflight",
            started=started,
            network=config.get_network_name(),
            rpc_url=config.get_rpc_url(),
            approval_guard=os.environ.get("VERICOURT_RUN_STUDIONET"),
            leader_only=config.get_leader_only(),
            claimant=claimant.address,
            respondent=respondent.address,
            account_nonces=nonces,
            fixtures=keys,
            planned_transactions=plan,
            timeouts=timeouts.as_dict(),
            minimum_run_budget_s=required_budget,
            sdk_send_receipt_timeout_s=SDK_SEND_RECEIPT_TIMEOUT_S,
        )
        assert all(n == 0 for n in nonces.values()), "accounts are not fresh"

        address = runner.deploy(CONTRACT_PATH.read_text(encoding="utf-8"), claimant)
        for key in keys:
            runner.run_fixture(FIXTURES[key], address, claimant, respondent,
                               evaluate=lambda category, a, k=key: evaluate_expectation(k, category, a))
    except HarnessStop:
        pass  # recorded in runner.problems and the log
    finally:
        log.record(
            "summary",
            writes_planned=plan,
            writes_attempted=guard.attempted,
            halted=guard.halted,
            problems=None if runner is None else runner.problems,
            warnings=None if runner is None else runner.warnings,
            results=None if runner is None else runner.results,
            rpc_request_counts=journal.counts(),
            rpc_failures=[r.__dict__ for r in journal.records if r.outcome != "ok"],
        )

    assert runner is not None and not runner.problems, runner.problems if runner else "client setup failed"
    # Writes after the last success would mean the guard failed.
    assert guard.attempted == plan, (guard.attempted, plan)
