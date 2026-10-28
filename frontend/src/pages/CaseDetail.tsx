/**
 * Read-only case page (`#/case/VC-…`). Reads the configured contract only,
 * after confirming it is the reviewed contract on StudioNet. No wallet prompt:
 * the viewer's role comes from the wallet's passive state. Write actions are
 * listed with their eligibility; in the ordinary build they are unavailable,
 * and in the gated experiment build they link to the review page.
 */
import { useEffect, useState } from "react";
import { actionHref, isCaseId, reportHref } from "../app/routes";
import { caseActions } from "../cases/actions";
import type { CaseData } from "../cases/caseReads";
import { browserStorage, rememberCase, type StorageLike } from "../cases/localHistory";
import { knownTransactionsFor } from "../cases/knownTransactions";
import { useCaseLoad, type ReadDeps } from "../cases/useCaseData";
import { CaseLoadProblem } from "../components/CaseLoadStatus";
import { CaseRecord } from "../components/CaseRecord";
import { EvidencePanel } from "../components/EvidencePanel";
import { CONTRACT_ADDRESS, WRITES_DISABLED_REASON, type ContractAddressConfig } from "../config/network";
import { viewerRole } from "../display/caseText";
import { useWallet } from "../wallet/WalletContext";
import { WRITE_EXPERIMENT_BUILD } from "./WritePreview";

interface Props extends ReadDeps {
  caseId: string;
  contract?: ContractAddressConfig;
  nowSeconds?: () => number;
  storage?: StorageLike | null;
  experimentBuild?: boolean;
}

const nowS = () => Math.floor(Date.now() / 1000);

export function ContractNotConfigured({ contract }: { contract: ContractAddressConfig }) {
  return (
    <EvidencePanel title="No contract to read" tone="procedural">
      {contract.status === "invalid" ? (
        <p>
          The configured contract address is not valid: <code className="break">{contract.raw}</code>.
        </p>
      ) : (
        <p>No VeriCourt contract address is configured for this build, so no case can be read. There is no designated application deployment yet.</p>
      )}
    </EvidencePanel>
  );
}

export function CaseDetail({ caseId, contract = CONTRACT_ADDRESS, nowSeconds = nowS, storage, experimentBuild = WRITE_EXPERIMENT_BUILD, ...deps }: Props) {
  const address = contract.status === "set" ? contract.address : null;
  const valid = isCaseId(caseId);
  const { state, refresh } = useCaseLoad(valid ? address : null, caseId, deps);
  const { state: wallet } = useWallet();
  const [store] = useState<StorageLike | null>(() => (storage === undefined ? browserStorage() : storage));
  const now = nowSeconds();

  const loaded = state.kind === "done" && state.value.kind === "loaded" ? state.value.data : null;
  useEffect(() => {
    if (loaded !== null && address !== null) rememberCase(store, address, loaded.caseId);
  }, [loaded, address, store]);

  return (
    <>
      <span className="kicker">Case record (read-only)</span>
      <h1>
        Case <span className="mono">{valid ? caseId : "?"}</span>
      </h1>
      <p>
        <a href="#/app">Back to cases</a>
      </p>

      {address === null ? (
        <ContractNotConfigured contract={contract} />
      ) : !valid ? (
        <CaseLoadProblem problem={{ kind: "invalid_id" }} caseId={caseId} />
      ) : state.kind === "loading" || state.kind === "idle" ? (
        <p role="status" className="callout">
          Reading case {caseId} from StudioNet…
        </p>
      ) : state.kind === "error" ? (
        <EvidencePanel title="The case could not be read" tone="warning">
          <p role="alert">{state.message}</p>
        </EvidencePanel>
      ) : state.value.kind !== "loaded" ? (
        <CaseLoadProblem problem={state.value} caseId={caseId} onRetry={refresh} />
      ) : (
        <Loaded
          data={state.value.data}
          address={address}
          account={wallet.account}
          now={now}
          store={store}
          refresh={refresh}
          experimentBuild={experimentBuild}
        />
      )}
    </>
  );
}

function Loaded({
  data,
  address,
  account,
  now,
  store,
  refresh,
  experimentBuild,
}: {
  data: CaseData;
  address: `0x${string}`;
  account: string | null;
  now: number;
  store: StorageLike | null;
  refresh: () => void;
  experimentBuild: boolean;
}) {
  const viewer = viewerRole(data.case, account);
  const actions = caseActions(
    data.case,
    viewer,
    data.assessmentStatus.ok ? data.assessmentStatus.value : null,
    data.evidence.ok ? data.evidence.value : null,
    now,
  );
  const transactions = knownTransactionsFor(address, data.caseId, store);
  return (
    <>
      <div className="actions">
        <button className="button button--secondary" type="button" onClick={refresh}>
          Refresh (read-only)
        </button>
        <a className="button button--secondary" href={reportHref(data.caseId)}>
          Case report
        </a>
      </div>
      <p className="hint">
        Read from <code className="break">{address}</code> on StudioNet; {data.requests} read requests. Nothing on this page sends a transaction.
      </p>

      <CaseRecord data={data} viewer={viewer} nowSeconds={now} transactions={transactions} />

      <section className="section" aria-labelledby="actions-heading">
        <h2 id="actions-heading">Actions</h2>
        {!experimentBuild ? <p className="hint">{WRITES_DISABLED_REASON} The list shows what the contract would allow.</p> : null}
        {account === null ? <p className="hint">No wallet account is known on this page. Connect on the Wallet page to see your role.</p> : null}
        <ul className="action-list">
          {actions.map((a) => (
            <li key={a.method}>
              {experimentBuild && a.available ? (
                <a className="button" href={actionHref(a.method, data.caseId)}>
                  {a.label}
                </a>
              ) : (
                <strong>{a.label}</strong>
              )}{" "}
              <span className={`tag ${a.available ? "tag--ok" : "tag--neutral"}`}>{a.available ? (experimentBuild ? "Allowed now" : "The contract would allow this now") : "Not available"}</span>
              <span className="block hint">{a.note}</span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
