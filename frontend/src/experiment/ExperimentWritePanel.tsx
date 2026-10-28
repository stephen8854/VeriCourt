/**
 * The gated write-experiment workspace (Phase 3.5C, extended to every
 * contract write in Phase 4.2–4.5). Rendered only when the build mode is
 * "write-experiment" (see pages/WritePreview.tsx); it then still does nothing
 * unless the runtime gate (config/writeGate.ts) is enabled.
 *
 * One action can start a write: the review screen's final button, after the
 * user's acknowledgement. Every other action here is read-only (case reads,
 * status check, reconciliation) or clears a settled record. Nothing retries a
 * write. One unresolved write blocks every other write in this browser.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { actionHref, caseHref, isCaseId } from "../app/routes";
import { browserStorage, recordLocalTransaction } from "../cases/localHistory";
import { useCaseLoad, type ReadDeps } from "../cases/useCaseData";
import { CaseLoadProblem } from "../components/CaseLoadStatus";
import { EvidencePanel } from "../components/EvidencePanel";
import { ActionConfirmation, WriteConfirmation, actionBlockers } from "../components/WriteConfirmation";
import { PHASE_2_17C_NO_REPLY } from "../config/testDeployments";
import type { WriteGate } from "../config/writeGate";
import { browserSha256Hex } from "../live/readCheck";
import { SETTLED_PHASES, UNCERTAIN_PHASES } from "../tx/state";
import type { Eip1193Provider } from "../wallet/eip1193";
import { useWallet } from "../wallet/WalletContext";
import type { CreateCaseInput } from "../write/createCase";
import { DurableWriteSession, WriteOutcomeNotRecorded, WriteRefused } from "../write/durableSession";
import { CONTRACT_WRITE_METHODS, type ContractWriteMethod } from "../write/methods";
import { PendingStore, isCaseWriteEffect, type PendingRecord } from "../write/pendingStore";
import { webLocks } from "../write/writeLock";
import { AssessmentForm, DeadlineForm, EvidenceForm, ReplyForm, type PreparedReview } from "./CaseActionForms";
import { CreateCaseWizard, EMPTY_DRAFT, type CreateDraft } from "./CreateCaseWizard";
import {
  DEFAULT_TIMING,
  PreflightFailed,
  canMonitor,
  createCaseSpec,
  flowBlockers,
  monitorToFinality,
  reconcileUncertain,
  statusMessage,
  submitWrite,
  writeBlockers,
  type FlowDeps,
  type WriteSpec,
} from "./createCaseFlow";

export function fictionalCase(nowIso: string): CreateCaseInput {
  return {
    respondent: "0xF1C710A100000000000000000000000000000001",
    category: "OTHER",
    title: `FICTIONAL TEST - VeriCourt browser-wallet write ${nowIso}`,
    agreementSummary: "FICTIONAL - no real agreement exists. Created by the VeriCourt Phase 3.5C browser-wallet experiment.",
    expectedDeliverable: "FICTIONAL - nothing was to be delivered. This record exists only to test the write path.",
    claim: "FICTIONAL TEST RECORD - not a real dispute. No real party, work, payment or claim is involved.",
    requestedRemedy: "None - fictional test record.",
    issues: ["FICTIONAL - placeholder issue for a browser-wallet write test"],
    replyWindowSeconds: 3600,
  };
}

async function defaultCreateDeps(session: DurableWriteSession, wallet: Eip1193Provider): Promise<FlowDeps> {
  const sdk = await import("./sdkExperiment");
  return {
    session,
    reader: sdk.createSdkReader(),
    wallet,
    makeWriteClient: sdk.createSdkWriteClient,
    expectedCodeSha256: PHASE_2_17C_NO_REPLY.expectedCodeSha256,
    sha256Hex: browserSha256Hex,
    randomId: () => globalThis.crypto.randomUUID(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    timing: DEFAULT_TIMING,
  };
}

const defaultOpenSession = () => DurableWriteSession.open(PendingStore.fromWindow(), webLocks());

const ACTION_LABELS: Record<ContractWriteMethod, string> = {
  create_case: "Start a case",
  submit_evidence: "Submit evidence",
  submit_reply: "Reply",
  process_reply_deadline: "Record a missed deadline",
  request_assessment: "Request an assessment",
};

function parseAction(value: string | undefined): ContractWriteMethod {
  return (CONTRACT_WRITE_METHODS as readonly string[]).includes(value ?? "") ? (value as ContractWriteMethod) : "create_case";
}

/** The case a record targets (null for create_case until verified). */
function recordCaseId(r: PendingRecord): string | null {
  return isCaseWriteEffect(r.expectedEffect) ? r.expectedEffect.caseId : null;
}

/** Keeps this browser's list of sent transactions (for the timeline and report) in step with the record. */
function logRecord(r: PendingRecord | null, caseId: string | null = null) {
  if (r === null || r.tx.txHash === null) return;
  recordLocalTransaction(browserStorage(), {
    contract: r.contract,
    caseId: caseId ?? recordCaseId(r),
    method: r.method,
    hash: r.tx.txHash,
    at: r.createdAt,
    phase: r.tx.phase,
  });
}

type Stage =
  | { kind: "form" }
  | { kind: "review_create"; input: CreateCaseInput }
  | { kind: "review_action"; review: PreparedReview };

interface Props {
  gate: WriteGate;
  /** Route query (`action`, `case`). */
  query?: Readonly<Record<string, string>>;
  /** Injected for tests. */
  openSession?: () => Promise<DurableWriteSession>;
  createDeps?: (session: DurableWriteSession, wallet: Eip1193Provider) => Promise<FlowDeps>;
  /** A fixed create_case input: the workspace opens directly on its review (Phase 3.5C tests). */
  input?: CreateCaseInput;
  /** Injected for tests: how the case-level forms read the case. */
  readDeps?: ReadDeps;
}

export function ExperimentWritePanel({ gate, query = {}, openSession = defaultOpenSession, createDeps = defaultCreateDeps, input: injectedInput, readDeps = {} }: Props) {
  const { state: wallet, provider } = useWallet();
  const [session, setSession] = useState<DurableWriteSession | null>(null);
  const [rev, setRev] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  /** Remounts the review screen (fresh acknowledgement) when no operation record exists. */
  const [confirmKey, setConfirmKey] = useState(0);
  const running = useRef(false);
  const action = injectedInput ? "create_case" : parseAction(query.action);
  const caseId = query.case ?? "";
  const [draft, setDraft] = useState<CreateDraft>(EMPTY_DRAFT);
  // The stage belongs to one action and case: a different action or case in the URL starts a fresh form.
  const stageKey = `${action}|${caseId}`;
  const [staged, setStaged] = useState<{ key: string; stage: Stage }>(() => ({
    key: stageKey,
    stage: injectedInput ? { kind: "review_create", input: injectedInput } : { kind: "form" },
  }));
  const stage: Stage = staged.key === stageKey ? staged.stage : { kind: "form" };
  const setStage = (next: Stage) => setStaged({ key: stageKey, stage: next });
  const [lastAttemptConfirmed, setLastAttemptConfirmed] = useState(false);
  const [verifiedCase, setVerifiedCase] = useState<string | null>(null);
  const bump = useCallback(() => setRev((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    void openSession().then((s) => live && setSession(s));
    return () => {
      live = false;
    };
  }, [openSession]);

  // Another tab changed the record: re-read (never recover here).
  useEffect(() => {
    if (session === null) return;
    const onStorage = () => {
      if (!running.current) {
        session.refresh();
        bump();
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [session, bump]);

  const act = useCallback(
    async (label: string, fn: (deps: FlowDeps) => Promise<string | null>) => {
      if (session === null || provider === null || running.current) return;
      running.current = true;
      setBusy(label);
      setMessage(null);
      try {
        const deps = await createDeps(session, provider);
        setMessage(await fn(deps));
      } catch (err) {
        if (err instanceof WriteRefused || err instanceof PreflightFailed) setMessage(`Nothing was sent. ${err.message}`);
        else if (err instanceof WriteOutcomeNotRecorded) setMessage(err.message);
        else setMessage(`Stopped: ${(err as Error).message}. Nothing will be retried.`);
      } finally {
        running.current = false;
        setBusy(null);
        // Refused before anything was recorded: a new review (and a new deliberate click) is needed.
        if (session.current === null) setConfirmKey((k) => k + 1);
        bump();
      }
    },
    [session, provider, createDeps, bump],
  );

  const monitor = async (deps: FlowDeps) => {
    const result = await monitorToFinality(deps, bump);
    const caseFound = result.kind === "verified" ? result.caseId : null;
    if (caseFound !== null) setVerifiedCase(caseFound);
    logRecord(session?.current ?? null, caseFound);
    return result;
  };

  const confirm = (spec: WriteSpec) =>
    void act("Waiting for your wallet…", async (deps) => {
      const { outcome } = await submitWrite(deps, { gate, wallet, spec, acknowledged: true });
      logRecord(session?.current ?? null);
      if (outcome.kind !== "submitted") return null;
      bump();
      const result = await monitor(deps);
      return result.kind === "verification_unavailable" ? `Finalized, but the confirming read failed (${result.detail}). Use “Check status” to retry the read.` : null;
    });

  const checkStatus = () =>
    void act("Checking status (read-only)…", async (deps) => {
      const result = await monitor(deps);
      return result.kind === "verification_unavailable" ? `The confirming read failed (${result.detail}). Try again later.` : null;
    });

  const reconcile = () =>
    void act("Running read-only check…", async (deps) => {
      const r = await reconcileUncertain(deps);
      logRecord(session?.current ?? null);
      if (r.kind === "unresolved") return `Still unresolved: ${r.reasons.join("; ")}.`;
      if (r.kind === "found") {
        const m = await monitor(deps);
        return m.kind === "verified" ? null : `Transaction found; status: ${m.kind}.`;
      }
      return null;
    });

  const clear = () => {
    if (session === null) return;
    try {
      session.reset();
      setMessage(null);
      setVerifiedCase(null);
      setConfirmKey((k) => k + 1);
      if (!injectedInput) setStage({ kind: "form" });
    } catch (err) {
      setMessage((err as Error).message);
    }
    bump();
  };

  const record = session?.current ?? null;
  const unresolved = record !== null && !SETTLED_PHASES.includes(record.tx.phase);
  const status = statusMessage(record);
  const sessionReason = session === null ? "Loading the write-safety record…" : session.blockedReason;
  const createInput = stage.kind === "review_create" ? stage.input : null;
  const createBlockers = useMemo(() => {
    if (createInput === null) return [];
    const b = flowBlockers({ gate, wallet, input: createInput, acknowledged: true }, { includeAcknowledgement: false });
    if (provider === null) b.unshift("No wallet was detected in this browser.");
    if (sessionReason !== null) b.unshift(sessionReason);
    return b;
    // rev: the session's state is mutable; recompute after every change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gate, wallet, createInput, provider, session, rev, sessionReason]);
  const reviewed = stage.kind === "review_action" ? stage.review : null;
  const actionReviewBlockers = useMemo(() => {
    if (reviewed === null) return [];
    const b = writeBlockers({ gate, wallet, inputProblems: reviewed.inputProblems, acknowledged: true }, { includeAcknowledgement: false });
    if (provider === null) b.unshift("No wallet was detected in this browser.");
    if (sessionReason !== null) b.unshift(sessionReason);
    return b;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gate, wallet, reviewed, provider, session, rev, sessionReason]);
  const doneCase = verifiedCase ?? (record !== null ? recordCaseId(record) : null);

  return (
    <section aria-labelledby="experiment-heading">
      <div className="callout evidence-panel--warning" role="note">
        <h2 id="experiment-heading">Write experiment build</h2>
        <p>
          <strong>This page can send real transactions to StudioNet</strong>, one at a time, each only after you review it and approve it in your wallet. Use a
          throwaway wallet and fictional data on the test contract.
        </p>
        {!gate.enabled ? (
          <>
            <p>Writes are off in this build:</p>
            <ul>
              {gate.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </>
        ) : (
          <p>
            Target: the throwaway test contract <code>{gate.contract}</code>.
          </p>
        )}
      </div>

      {busy !== null ? (
        <p role="status" className="callout">
          {busy}
        </p>
      ) : null}
      {message !== null ? (
        <p role="alert" className="callout">
          {message}
        </p>
      ) : null}

      {status !== null ? (
        <EvidencePanel title={status.headline} tone={status.tone === "warn" ? "warning" : "procedural"}>
          <p>{status.body}</p>
          {status.recovery.length > 0 ? (
            <ol>
              {status.recovery.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          ) : null}
          {!unresolved && doneCase !== null ? (
            <p>
              <a href={caseHref(doneCase)}>Open case {doneCase}</a>
            </p>
          ) : null}
          <div className="actions">
            {canMonitor(record) ? (
              <button className="button" type="button" disabled={busy !== null} onClick={checkStatus}>
                Check status (read-only)
              </button>
            ) : null}
            {record !== null && UNCERTAIN_PHASES.includes(record.tx.phase) ? (
              <button className="button" type="button" disabled={busy !== null} onClick={reconcile}>
                Run read-only check
              </button>
            ) : null}
            {record !== null && !unresolved ? (
              <button className="button button--secondary" type="button" disabled={busy !== null} onClick={clear}>
                Clear this settled result
              </button>
            ) : null}
          </div>
        </EvidencePanel>
      ) : null}

      {record === null ? (
        <>
          {!injectedInput ? (
            <nav aria-label="Write actions">
              <ul className="steps">
                {CONTRACT_WRITE_METHODS.map((m) => (
                  <li key={m} aria-current={m === action ? "step" : undefined}>
                    <a href={actionHref(m, m === "create_case" || caseId === "" ? undefined : caseId)}>{ACTION_LABELS[m]}</a>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}

          {stage.kind === "review_create" ? (
            <WriteConfirmation
              key={confirmKey}
              account={wallet.account}
              walletChainId={wallet.chainId}
              contract={gate.enabled ? gate.contract : null}
              input={stage.input}
              blockedReason={createBlockers.length > 0 ? createBlockers.join(" ") : null}
              onConfirm={() => confirm(createCaseSpec(stage.input))}
              {...(injectedInput ? {} : { onCancel: () => setStage({ kind: "form" }) })}
            />
          ) : stage.kind === "review_action" ? (
            <ActionConfirmation
              key={confirmKey}
              account={wallet.account}
              walletChainId={wallet.chainId}
              contract={gate.enabled ? gate.contract : null}
              functionName={stage.review.method}
              functionSummary={stage.review.functionSummary}
              rowsHeading={stage.review.rowsHeading}
              rows={stage.review.rows}
              beforeYouSubmit={stage.review.beforeYouSubmit}
              warnings={stage.review.warnings}
              acknowledgement={stage.review.acknowledgement}
              blockers={actionBlockers({ account: wallet.account, walletChainId: wallet.chainId, contract: gate.enabled ? gate.contract : null, blockedReason: actionReviewBlockers.length > 0 ? actionReviewBlockers.join(" ") : null, inputProblems: [] })}
              extra={
                stage.review.extraConfirmation !== null ? (
                  <p className="callout">
                    <label>
                      <input type="checkbox" checked={lastAttemptConfirmed} onChange={(e) => setLastAttemptConfirmed(e.target.checked)} /> {stage.review.extraConfirmation}
                    </label>
                  </p>
                ) : null
              }
              extraSatisfied={stage.review.extraConfirmation === null || lastAttemptConfirmed}
              onConfirm={() => confirm(stage.review.buildSpec(lastAttemptConfirmed))}
              onCancel={() => setStage({ kind: "form" })}
            />
          ) : action === "create_case" ? (
            <CreateCaseWizard draft={draft} setDraft={setDraft} account={wallet.account} onReview={(input) => setStage({ kind: "review_create", input })} />
          ) : (
            <CaseActionWorkspace
              gate={gate}
              action={action}
              caseId={caseId}
              account={wallet.account}
              readDeps={readDeps}
              onReview={(review) => {
                setLastAttemptConfirmed(false);
                setStage({ kind: "review_action", review });
              }}
            />
          )}
        </>
      ) : null}
    </section>
  );
}

function CaseActionWorkspace({
  gate,
  action,
  caseId,
  account,
  readDeps,
  onReview,
}: {
  gate: WriteGate;
  action: Exclude<ContractWriteMethod, "create_case">;
  caseId: string;
  account: string | null;
  readDeps: ReadDeps;
  onReview: (r: PreparedReview) => void;
}) {
  const [entered, setEntered] = useState(caseId);
  const valid = isCaseId(caseId);
  const { state, refresh } = useCaseLoad(gate.enabled && valid ? gate.contract : null, caseId, readDeps);
  const choose = (e: { preventDefault: () => void }) => {
    e.preventDefault();
    const v = entered.trim().toUpperCase();
    if (isCaseId(v)) window.location.hash = actionHref(action, v);
  };
  return (
    <>
      <form onSubmit={choose} className="section">
        <div className="field">
          <label htmlFor="action-case-id">Case ID</label>
          <input id="action-case-id" value={entered} onChange={(e) => setEntered(e.target.value)} placeholder="VC-000001" autoComplete="off" />
        </div>
        <button className="button button--secondary" type="submit">
          Load case (read-only)
        </button>
      </form>
      {!gate.enabled ? (
        <p className="hint">Writes are off in this build, so no case is read here.</p>
      ) : !valid ? (
        <p className="hint">Enter the ID of the case this action is for.</p>
      ) : state.kind === "idle" || state.kind === "loading" ? (
        <p role="status">Reading case {caseId}…</p>
      ) : state.kind === "error" ? (
        <p role="alert">{state.message}</p>
      ) : state.value.kind !== "loaded" ? (
        <CaseLoadProblem problem={state.value} caseId={caseId} onRetry={refresh} />
      ) : state.value.data.inconsistencies.length > 0 || state.value.data.finality.kind !== "final" ? (
        <EvidencePanel title="Not available on this case right now" tone="warning">
          <p role="alert">
            {state.value.data.inconsistencies.length > 0
              ? "The case's reads contradict each other, so no write is offered."
              : "The case has changes that are not final yet. Wait until they finalize, then load the case again."}
          </p>
          <div className="actions">
            <button className="button button--secondary" type="button" onClick={refresh}>
              Load again (read-only)
            </button>
          </div>
        </EvidencePanel>
      ) : action === "submit_evidence" ? (
        <EvidenceForm data={state.value.data} account={account} onReview={onReview} />
      ) : action === "submit_reply" ? (
        <ReplyForm data={state.value.data} account={account} onReview={onReview} />
      ) : action === "process_reply_deadline" ? (
        <DeadlineForm data={state.value.data} account={account} onReview={onReview} />
      ) : (
        <AssessmentForm data={state.value.data} account={account} onReview={onReview} />
      )}
    </>
  );
}
