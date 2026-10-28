import { lazy, Suspense } from "react";
import { CONTRACT_ADDRESS, CONTRACT_WRITES_ENABLED, WRITES_DISABLED_REASON } from "../config/network";
import { evaluateWriteGate } from "../config/writeGate";
import { EvidencePanel } from "../components/EvidencePanel";
import { WriteConfirmation } from "../components/WriteConfirmation";
import { useWallet } from "../wallet/WalletContext";
import type { CreateCaseInput } from "../write/createCase";
import { PendingStore, blockReason } from "../write/pendingStore";

/** Fictional example shown in the preview. */
export const PREVIEW_CASE: CreateCaseInput = {
  respondent: "0xF1C710A100000000000000000000000000000001",
  category: "OTHER",
  title: "FICTIONAL EXAMPLE - preview of the transaction review",
  agreementSummary: "FICTIONAL - an example agreement summary, shown only to preview the review step.",
  expectedDeliverable: "FICTIONAL - an example deliverable.",
  claim: "FICTIONAL - an example claim. Nothing on this page can be submitted.",
  requestedRemedy: "FICTIONAL - an example remedy.",
  issues: ["FICTIONAL - first example issue", "FICTIONAL - second example issue"],
  replyWindowSeconds: 72 * 3600,
};

function SafetyStatus() {
  const load = PendingStore.fromWindow().load();
  const reason = blockReason(load);
  return (
    <EvidencePanel title="Write-safety status in this browser" tone={reason === null ? "procedural" : "warning"}>
      <p role="status">
        {reason ??
          (load.kind === "record"
            ? `The last recorded write (${load.record.operationId}) is settled (${load.record.tx.phase}).`
            : "No unresolved write is recorded in this browser.")}
      </p>
    </EvidencePanel>
  );
}

/**
 * Build-time gate. Vite replaces `import.meta.env.MODE` with a string literal,
 * so in every ordinary build this is `false` and the dynamic import below is
 * removed from the bundle: the ordinary app contains no write path at all.
 * The string must stay inline here (not imported) for that to happen.
 */
const ExperimentWritePanel =
  import.meta.env.MODE === "write-experiment"
    ? lazy(() => import("../experiment/ExperimentWritePanel").then((m) => ({ default: m.ExperimentWritePanel })))
    : null;

/** True only in the gated write-experiment build (folded to `false` in every ordinary build). */
export const WRITE_EXPERIMENT_BUILD = ExperimentWritePanel !== null;

function ExperimentOrPreview({ query }: { query: Readonly<Record<string, string>> }) {
  if (ExperimentWritePanel === null) return <WritePreviewBody />;
  const gate = evaluateWriteGate({
    mode: import.meta.env.MODE,
    ack: import.meta.env.VITE_VERICOURT_WRITE_EXPERIMENT as string | undefined,
    contract: import.meta.env.VITE_VERICOURT_CONTRACT_ADDRESS as string | undefined,
    hostname: typeof window === "undefined" ? undefined : window.location.hostname,
  });
  return (
    <Suspense fallback={<p role="status">Loading the write experiment…</p>}>
      <ExperimentWritePanel gate={gate} query={query} />
    </Suspense>
  );
}

export function WritePreview({ query = {} }: { query?: Readonly<Record<string, string>> }) {
  return <ExperimentOrPreview query={query} />;
}

/**
 * Preview of the confirmation step. Not connected to any submission path:
 * the final button stays disabled because writes are disabled in this build.
 */
function WritePreviewBody() {
  const { state } = useWallet();
  const contract = CONTRACT_ADDRESS.status === "set" ? CONTRACT_ADDRESS.address : null;
  const blocked = CONTRACT_WRITES_ENABLED ? null : WRITES_DISABLED_REASON;
  return (
    <>
      <span className="kicker">Preview</span>
      <h1>Transaction review</h1>
      <EvidencePanel title="Preview only" tone="procedural">
        <p>
          This is the review step a future write will use, filled with fictional example data. {WRITES_DISABLED_REASON} Nothing on
          this page can send a transaction or open a wallet request.
        </p>
      </EvidencePanel>
      <SafetyStatus />
      <WriteConfirmation
        account={state.account}
        walletChainId={state.chainId}
        contract={contract}
        input={PREVIEW_CASE}
        blockedReason={blocked}
        onConfirm={() => undefined}
      />
    </>
  );
}
