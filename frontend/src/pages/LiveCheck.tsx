import { useState } from "react";
import { STUDIONET } from "../config/network";
import { PHASE_2_17C_NO_REPLY } from "../config/testDeployments";
import { CaseSnapshot } from "../components/CaseSnapshot";
import { EvidencePanel } from "../components/EvidencePanel";
import type { ReadOnlyGateway } from "../live/gateway";
import type { CaseReads, ReadCheckReport, StepResult } from "../live/readCheck";

export const READ_TIMEOUT_MS = 20_000;

interface Props {
  /** Injected in tests. Defaults to the lazily loaded genlayer-js gateway. */
  loadGateway?: () => Promise<ReadOnlyGateway>;
  sha256Hex?: (text: string) => Promise<string>;
}

async function defaultGateway(): Promise<ReadOnlyGateway> {
  const { createSdkGateway } = await import("../live/sdkGateway");
  return createSdkGateway();
}

type RunState =
  | { kind: "idle" }
  | { kind: "running"; steps: StepResult[] }
  | { kind: "done"; report: ReadCheckReport }
  | { kind: "failed"; message: string; steps: StepResult[] };

const OUTCOME_TAG: Record<StepResult["outcome"], string> = {
  ok: "tag--ok",
  mismatch: "tag--warn",
  malformed: "tag--warn",
  error: "tag--warn",
  skipped: "tag--neutral",
};

const yesNo = (v: boolean | null) => (v === null ? "n/a" : v ? "yes" : "no");

function StepsTable({ steps }: { steps: StepResult[] }) {
  return (
    <div className="table-scroll">
      <table>
        <caption>Read results, in the order they ran</caption>
        <thead>
          <tr>
            <th scope="col">Call</th>
            <th scope="col">Outcome</th>
            <th scope="col">Response received</th>
            <th scope="col">Decoded and valid</th>
            <th scope="col">Matches recorded</th>
            <th scope="col">Details</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((s) => (
            <tr key={s.id}>
              <td>
                <code>{s.call}</code>
              </td>
              <td>
                <span className={`tag ${OUTCOME_TAG[s.outcome]}`}>{s.outcome}</span>
              </td>
              <td>{yesNo(s.responseReceived)}</td>
              <td>{yesNo(s.decodedAndValid)}</td>
              <td>{yesNo(s.matchesRecorded)}</td>
              <td>
                {s.error !== null && (
                  <span>
                    {s.error.category}: {s.error.message}
                  </span>
                )}
                {s.details.map((d) => (
                  <span key={d} className="block">
                    {d}
                  </span>
                ))}
                <span className="block hint">{s.durationMs} ms</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LiveCheck({ loadGateway = defaultGateway, sha256Hex }: Props) {
  const [state, setState] = useState<RunState>({ kind: "idle" });
  const d = PHASE_2_17C_NO_REPLY;

  const run = async () => {
    const steps: StepResult[] = [];
    setState({ kind: "running", steps });
    try {
      const [{ runReadCheck, browserSha256Hex }, { recordedNoReplyCaseReads }, gateway] = await Promise.all([
        import("../live/readCheck"),
        import("../live/expected"),
        loadGateway(),
      ]);
      const report = await runReadCheck(gateway, d, recordedNoReplyCaseReads(), {
        timeoutMs: READ_TIMEOUT_MS,
        sha256Hex: sha256Hex ?? browserSha256Hex,
        onStep: (s) => {
          steps.push(s);
          setState({ kind: "running", steps: [...steps] });
        },
      });
      setState({ kind: "done", report });
    } catch (err) {
      setState({ kind: "failed", message: err instanceof Error ? err.message : String(err), steps });
    }
  };

  const steps = state.kind === "done" ? state.report.steps : state.kind === "idle" ? [] : state.steps;
  const report = state.kind === "done" ? state.report : null;
  const reads: { nonfinal: Partial<CaseReads> | undefined; final: Partial<CaseReads> | undefined } = {
    nonfinal: report?.reads["latest-nonfinal"],
    final: report?.reads["latest-final"],
  };

  return (
    <>
      <span className="kicker">Read-only integration check</span>
      <h1>Live read-only check</h1>
      <EvidencePanel title="What this does" tone="procedural" headingLevel={2}>
        <p>
          Sends read-only requests from this browser to {STUDIONET.name} (<code>{STUDIONET.rpcUrl}</code>) for a known
          throwaway test deployment, and compares the answers with the read-back recorded on StudioNet in Phase 2.17C.
          Nothing is sent until you press the button. Nothing is written, signed or sent from a wallet.
        </p>
        <dl className="facts">
          <dt>Deployment</dt>
          <dd>{d.label}</dd>
          <dt>Contract</dt>
          <dd>
            <code>{d.address}</code>
          </dd>
          <dt>Case</dt>
          <dd>
            <code>{d.caseId}</code>
          </dd>
          <dt>Per-request timeout</dt>
          <dd>{READ_TIMEOUT_MS / 1000} s, no retries</dd>
        </dl>
        <div className="actions">
          <button className="button" type="button" onClick={() => void run()} disabled={state.kind === "running"}>
            Run read-only check
          </button>
        </div>
      </EvidencePanel>

      <section className="section" aria-labelledby="results-heading" aria-live="polite">
        <h2 id="results-heading">Results</h2>
        {state.kind === "idle" && <p>No requests have been sent.</p>}
        {state.kind === "running" && <p>Running… {steps.length} step(s) completed.</p>}
        {state.kind === "failed" && (
          <p role="alert">
            <span className="tag tag--warn">Check could not run</span> {state.message}
          </p>
        )}
        {report?.stoppedAt != null && (
          <p role="alert">
            <span className="tag tag--warn">Stopped</span> The check stopped at <code>{report.stoppedAt}</code>; later
            reads were not attempted.
          </p>
        )}
        {steps.length > 0 && <StepsTable steps={steps} />}
      </section>

      {report !== null && report.transactions.length > 0 && (
        <section className="section" aria-labelledby="tx-heading">
          <h2 id="tx-heading">Transaction lookups (as returned by the SDK)</h2>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Operation</th>
                  <th scope="col">statusName / status</th>
                  <th scope="col">Consensus result field</th>
                  <th scope="col">txExecutionResultName</th>
                  <th scope="col">Rounds</th>
                  <th scope="col">Last-round votes (as returned)</th>
                  <th scope="col">Classified</th>
                </tr>
              </thead>
              <tbody>
                {report.transactions.map((t) => (
                  <tr key={t.hash}>
                    <td>{t.operation}</td>
                    <td>
                      <code>{String(t.statusName)}</code> / <code>{String(t.status)}</code>
                    </td>
                    <td>
                      <code>{String(t.resultName)}</code>
                    </td>
                    <td>
                      <code>{String(t.txExecutionResultName)}</code>
                    </td>
                    <td>{String(t.numOfRounds)}</td>
                    <td>{t.lastRoundVotes === null ? "not returned" : t.lastRoundVotes.join(", ")}</td>
                    <td>
                      <code>{t.category}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {report !== null && report.stoppedAt === null && <CaseSnapshot nonfinal={reads.nonfinal} final={reads.final} />}
    </>
  );
}
