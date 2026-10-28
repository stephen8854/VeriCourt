/**
 * Browser-generated case report (`#/report/VC-…`), built only from data this
 * page has just read from the contract. Printable (browser print / save as
 * PDF) and downloadable as a self-contained HTML file. No service, no
 * dependency, no signature: the report says so.
 */
import { useState } from "react";
import { caseHref, isCaseId } from "../app/routes";
import type { CaseData } from "../cases/caseReads";
import { browserStorage, type StorageLike } from "../cases/localHistory";
import { knownTransactionsFor } from "../cases/knownTransactions";
import { useCaseLoad, type ReadDeps } from "../cases/useCaseData";
import { CaseLoadProblem } from "../components/CaseLoadStatus";
import { CaseRecord } from "../components/CaseRecord";
import { EvidencePanel } from "../components/EvidencePanel";
import { CONTRACT_ADDRESS, STUDIONET, type ContractAddressConfig } from "../config/network";
import { CONSENSUS_NOT_TRUTH, REPORT_LABEL } from "../contract/copy";
import { ASSESSMENT_SCHEMA_VERSION, CASE_SCHEMA_VERSION, METHODOLOGY_VERSION } from "../contract/enums";
import { formatUtc } from "../display/caseText";
import { ContractNotConfigured } from "./CaseDetail";

interface Props extends ReadDeps {
  caseId: string;
  contract?: ContractAddressConfig;
  nowSeconds?: () => number;
  storage?: StorageLike | null;
}

const nowS = () => Math.floor(Date.now() / 1000);

/** Minimal standalone styles for the downloaded file (no external resources). */
const REPORT_CSS = `
body{font-family:"Segoe UI","Helvetica Neue",Arial,sans-serif;color:#171717;background:#fffefa;max-width:60rem;margin:2rem auto;padding:0 1rem;line-height:1.5}
code,.mono{font-family:ui-monospace,Consolas,"Courier New",monospace;overflow-wrap:anywhere}
.break,.pre-wrap{overflow-wrap:anywhere}.pre-wrap{white-space:pre-wrap}
section,.evidence-panel{border-top:2px solid #171717;margin-top:1.5rem;padding-top:.75rem}
dl.facts{display:grid;grid-template-columns:minmax(8rem,14rem) 1fr;gap:.25rem 1rem}dl.facts dt{font-weight:600}dl.facts dd{margin:0}
.hint{color:#4a4943;font-size:.9rem}.tag{border:1px solid #171717;padding:0 .3rem;font-size:.85rem}.block{display:block}
.case-number{font-size:2.5rem;font-weight:700;margin:0}.report-label{font-weight:700;border:2px solid #171717;padding:.5rem}
.actions,.no-print{display:none}
`;

function ReportBody({ data, address, now, store }: { data: CaseData; address: `0x${string}`; now: number; store: StorageLike | null }) {
  const transactions = knownTransactionsFor(address, data.caseId, store);
  return (
    <article id="case-report" className="case-report" aria-label={`Report for ${data.caseId}`}>
      <p className="report-label">{REPORT_LABEL}</p>
      <dl className="facts">
        <dt>Generated</dt>
        <dd>{formatUtc(now)}, in this browser, from contract reads made by this page</dd>
        <dt>Network</dt>
        <dd>
          {STUDIONET.name}, chain ID <code>{STUDIONET.chainId}</code>
        </dd>
        <dt>Contract</dt>
        <dd>
          <code className="break">{address}</code> (deployed code confirmed as the reviewed VeriCourt contract)
        </dd>
        <dt>Data read at</dt>
        <dd>{data.source === "latest-final" ? "latest-final" : "latest-nonfinal (the case is not final yet)"}</dd>
        <dt>Versions</dt>
        <dd>
          <code>{CASE_SCHEMA_VERSION}</code>, <code>{ASSESSMENT_SCHEMA_VERSION}</code>, <code>{METHODOLOGY_VERSION}</code>
        </dd>
      </dl>
      <p className="hint">
        This report is not signed and is not an official record. Anyone can re-read the same data from the contract. {CONSENSUS_NOT_TRUTH}
      </p>
      <CaseRecord data={data} viewer={null} nowSeconds={now} transactions={transactions} />
      <p className="report-label">{REPORT_LABEL}</p>
    </article>
  );
}

function download(caseId: string): string | null {
  const article = document.getElementById("case-report");
  if (article === null) return "The report is not ready.";
  if (typeof URL.createObjectURL !== "function") return "Downloading is not available in this browser; use Print instead.";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>VeriCourt case report ${caseId}</title><style>${REPORT_CSS}</style></head><body>${article.outerHTML}</body></html>`;
  const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `vericourt-${caseId}-report.html`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return null;
}

export function CaseReport({ caseId, contract = CONTRACT_ADDRESS, nowSeconds = nowS, storage, ...deps }: Props) {
  const address = contract.status === "set" ? contract.address : null;
  const valid = isCaseId(caseId);
  const { state, refresh } = useCaseLoad(valid ? address : null, caseId, deps);
  const [store] = useState<StorageLike | null>(() => (storage === undefined ? browserStorage() : storage));
  const [message, setMessage] = useState<string | null>(null);
  const now = nowSeconds();
  const data = state.kind === "done" && state.value.kind === "loaded" ? state.value.data : null;

  return (
    <>
      <span className="kicker no-print">Browser-generated report</span>
      <h1>Case report {valid ? <span className="mono">{caseId}</span> : null}</h1>
      <p className="no-print">
        {valid ? <a href={caseHref(caseId)}>Back to the case</a> : <a href="#/app">Back to cases</a>}
      </p>
      {address === null ? (
        <ContractNotConfigured contract={contract} />
      ) : !valid ? (
        <CaseLoadProblem problem={{ kind: "invalid_id" }} caseId={caseId} />
      ) : state.kind === "idle" || state.kind === "loading" ? (
        <p role="status" className="callout">
          Reading case {caseId} from StudioNet…
        </p>
      ) : state.kind === "error" ? (
        <EvidencePanel title="The case could not be read" tone="warning">
          <p role="alert">{state.message}</p>
        </EvidencePanel>
      ) : state.value.kind !== "loaded" ? (
        <CaseLoadProblem problem={state.value} caseId={caseId} onRetry={refresh} />
      ) : data !== null ? (
        <>
          <div className="actions no-print">
            <button className="button" type="button" onClick={() => window.print()}>
              Print or save as PDF
            </button>
            <button className="button button--secondary" type="button" onClick={() => setMessage(download(caseId))}>
              Download report (.html)
            </button>
          </div>
          {message !== null ? (
            <p role="alert" className="callout no-print">
              {message}
            </p>
          ) : null}
          <ReportBody data={data} address={address} now={now} store={store} />
        </>
      ) : null}
    </>
  );
}
