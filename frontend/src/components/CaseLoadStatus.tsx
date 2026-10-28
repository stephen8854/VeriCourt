import type { CaseLoad, PartyCasesLoad } from "../cases/caseReads";
import { EvidencePanel } from "./EvidencePanel";

type Problem = Exclude<CaseLoad, { kind: "loaded" }> | Exclude<PartyCasesLoad, { kind: "loaded" }>;

const CATEGORY_TEXT: Record<string, string> = {
  timeout: "No response arrived in time",
  network_or_cors: "The network request failed (offline, blocked, or refused by the server)",
  rpc_error: "The StudioNet endpoint returned an error",
  unparseable_response: "The response could not be read (StudioNet may be rate-limiting this connection)",
  sdk_error: "The response could not be processed",
};

/** Every non-loaded outcome of a case read, explained. Reads change nothing and are safe to repeat. */
export function CaseLoadProblem({ problem, caseId, onRetry }: { problem: Problem; caseId?: string; onRetry?: () => void }) {
  const retry =
    onRetry === undefined ? null : (
      <div className="actions">
        <button className="button button--secondary" type="button" onClick={onRetry}>
          Try the reads again
        </button>
      </div>
    );
  switch (problem.kind) {
    case "invalid_id":
      return (
        <EvidencePanel title="Not a case ID" tone="warning">
          <p role="alert">
            <code className="break">{caseId}</code> is not a VeriCourt case ID. Case IDs look like <code>VC-000001</code>.
          </p>
        </EvidencePanel>
      );
    case "not_found":
      return (
        <EvidencePanel title="No such case" tone="warning">
          <p role="alert">
            This contract has {problem.caseCount} case{problem.caseCount === 1 ? "" : "s"}; <code>{caseId}</code> is not one of them.
          </p>
        </EvidencePanel>
      );
    case "unexpected_contract":
      return (
        <EvidencePanel title="Unexpected contract" tone="warning">
          <p role="alert">
            No case data is shown because the configured contract could not be confirmed as the reviewed VeriCourt contract on StudioNet: {problem.reason}.
          </p>
        </EvidencePanel>
      );
    case "malformed":
      return (
        <EvidencePanel title="Case data not shown" tone="warning">
          <p role="alert">A read returned data in an unexpected shape, so it is not displayed ({problem.step}).</p>
          <ul>
            {problem.problems.slice(0, 10).map((p) => (
              <li key={p}>
                <code className="break">{p}</code>
              </li>
            ))}
          </ul>
          {retry}
        </EvidencePanel>
      );
    case "unavailable":
      return (
        <EvidencePanel title="StudioNet could not be read" tone="warning">
          <p role="alert">
            {CATEGORY_TEXT[problem.error.category] ?? "The read failed"}. Nothing was changed: reads never write anything and are safe to repeat.
          </p>
          <p className="hint">
            Step: <code className="break">{problem.step}</code>. Detail: <span className="break">{problem.error.message}</span>
          </p>
          {retry}
        </EvidencePanel>
      );
  }
}
