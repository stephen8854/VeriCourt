/**
 * Case discovery without a backend:
 * - "Your cases": the contract's own party index for the wallet account the
 *   page already knows from the wallet's passive state (never prompts);
 * - open a case by ID;
 * - recently viewed cases, stored only in this browser and labelled as such.
 */
import { useState, type FormEvent } from "react";
import { actionHref, caseHref, isCaseId } from "../app/routes";
import { PARTY_PAGE_SIZE } from "../cases/caseReads";
import { LOCAL_HISTORY_NOTE, browserStorage, recentCases, type StorageLike } from "../cases/localHistory";
import { usePartyCases, type ReadDeps } from "../cases/useCaseData";
import { CaseLoadProblem } from "../components/CaseLoadStatus";
import { EvidencePanel } from "../components/EvidencePanel";
import { CONTRACT_ADDRESS, CONTRACT_WRITES_ENABLED, WRITES_DISABLED_REASON, type ContractAddressConfig } from "../config/network";
import { formatUtc } from "../display/caseText";
import { caseStatusLabel, responseStateLabel } from "../display/labels";
import { useWallet } from "../wallet/WalletContext";
import { WRITE_EXPERIMENT_BUILD } from "./WritePreview";

interface Props extends ReadDeps {
  contract?: ContractAddressConfig;
  storage?: StorageLike | null;
  experimentBuild?: boolean;
}

function ContractStatus({ contract }: { contract: ContractAddressConfig }) {
  if (contract.status === "set") {
    return (
      <p>
        Reading cases from <code className="break">{contract.address}</code> on StudioNet, after confirming it is the reviewed VeriCourt contract.
      </p>
    );
  }
  if (contract.status === "invalid") {
    return (
      <p>
        The configured contract address is not valid: <code>{contract.raw}</code>. Contract features are unavailable until a valid address is
        configured.
      </p>
    );
  }
  return (
    <p>
      No VeriCourt contract address is configured, so contract features are unavailable. There is no designated application deployment yet.
    </p>
  );
}

function YourCases({ address, account, deps }: { address: `0x${string}`; account: string | null; deps: ReadDeps }) {
  const [offset, setOffset] = useState(0);
  const { state, refresh } = usePartyCases(address, account, offset, deps);
  if (account === null) {
    return (
      <EvidencePanel title="No wallet account known">
        <p>
          Connect a wallet on the <a href="#/wallet">Wallet page</a> to list the cases where your account is the claimant or the respondent. You can still
          open any case by its ID below.
        </p>
      </EvidencePanel>
    );
  }
  if (state.kind === "idle" || state.kind === "loading") return <p role="status">Reading the contract's case list for your account…</p>;
  if (state.kind === "error") return <p role="alert">{state.message}</p>;
  const v = state.value;
  if (v.kind !== "loaded") return <CaseLoadProblem problem={v} onRetry={refresh} />;
  if (v.total === 0) {
    return (
      <EvidencePanel title="No cases for this account">
        <p>
          The contract records no case where <code className="break">{account}</code> is the claimant or the respondent.
        </p>
      </EvidencePanel>
    );
  }
  return (
    <>
      <p className="hint">
        {v.total} case{v.total === 1 ? "" : "s"} for <code className="break">{account}</code>, from the contract's party index. Statuses are the latest
        state and may include changes that are not final yet; open a case to see its finality.
      </p>
      <div className="table-scroll">
        <table>
          <caption>Cases where you are the claimant or the respondent</caption>
          <thead>
            <tr>
              <th scope="col">Case</th>
              <th scope="col">Status</th>
              <th scope="col">Reply</th>
              <th scope="col">Created</th>
            </tr>
          </thead>
          <tbody>
            {v.rows.map((r) => (
              <tr key={r.caseId}>
                <td>
                  <a href={caseHref(r.caseId)}>
                    <code>{r.caseId}</code>
                  </a>
                </td>
                {r.status.ok ? (
                  <>
                    <td>{caseStatusLabel(r.status.value.status)}</td>
                    <td>{responseStateLabel(r.status.value.response_state)}</td>
                    <td>{formatUtc(r.status.value.created_at)}</td>
                  </>
                ) : (
                  <td colSpan={3}>Status not shown: unexpected data</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="actions">
        {offset > 0 ? (
          <button className="button button--secondary" type="button" onClick={() => setOffset(Math.max(0, offset - PARTY_PAGE_SIZE))}>
            Previous page
          </button>
        ) : null}
        {offset + PARTY_PAGE_SIZE < v.total ? (
          <button className="button button--secondary" type="button" onClick={() => setOffset(offset + PARTY_PAGE_SIZE)}>
            Next page
          </button>
        ) : null}
        <button className="button button--secondary" type="button" onClick={refresh}>
          Refresh (read-only)
        </button>
      </div>
    </>
  );
}

export function Dashboard({ contract = CONTRACT_ADDRESS, storage, experimentBuild = WRITE_EXPERIMENT_BUILD, ...deps }: Props) {
  const { state: wallet } = useWallet();
  const [id, setId] = useState("");
  const [idError, setIdError] = useState<string | null>(null);
  const [store] = useState<StorageLike | null>(() => (storage === undefined ? browserStorage() : storage));
  const address = contract.status === "set" ? contract.address : null;
  const recent = address === null ? [] : recentCases(store, address);

  const open = (e: FormEvent) => {
    e.preventDefault();
    const value = id.trim().toUpperCase();
    if (!isCaseId(value)) {
      setIdError("Enter a case ID such as VC-000001.");
      return;
    }
    setIdError(null);
    window.location.hash = caseHref(value);
  };

  return (
    <>
      <span className="kicker">Case dashboard</span>
      <h1>Cases</h1>

      <EvidencePanel title="Contract configuration" tone="procedural" headingLevel={2}>
        <ContractStatus contract={contract} />
        <p>
          {CONTRACT_WRITES_ENABLED || experimentBuild ? "Writes are possible only in the gated local experiment build." : WRITES_DISABLED_REASON} Nothing on
          this page sends a transaction.
        </p>
      </EvidencePanel>

      <section className="section" aria-labelledby="your-cases">
        <h2 id="your-cases">Your cases</h2>
        {address === null ? (
          <EvidencePanel title="No cases to show">
            <p>
              Once a contract is configured, VeriCourt lists the case IDs the contract records for the connected address (as claimant or respondent).
              Cases can also be opened directly by a known case ID, such as <code>VC-000001</code>.
            </p>
            <p>No cases are shown here because no contract is being read in this build. Nothing is invented.</p>
          </EvidencePanel>
        ) : (
          <YourCases address={address} account={wallet.account} deps={deps} />
        )}
      </section>

      <section className="section" aria-labelledby="open-by-id">
        <h2 id="open-by-id">Open a case by ID</h2>
        <form onSubmit={open} aria-describedby="open-by-id-note" noValidate>
          <div className="field">
            <label htmlFor="case-id">Case ID</label>
            <input
              id="case-id"
              name="case-id"
              placeholder="VC-000001"
              disabled={address === null}
              autoComplete="off"
              value={id}
              onChange={(e) => setId(e.target.value)}
              aria-invalid={idError !== null}
              aria-describedby={idError !== null ? "case-id-error" : undefined}
            />
            {idError !== null ? (
              <p id="case-id-error" role="alert" className="field-error">
                {idError}
              </p>
            ) : null}
          </div>
          <button className="button" type="submit" disabled={address === null}>
            Open case
          </button>
          <p id="open-by-id-note" className="hint">
            {address === null ? "Unavailable until a contract address is configured." : "Opening a case only reads it."}
          </p>
        </form>
      </section>

      {address !== null ? (
        <section className="section" aria-labelledby="recent-cases">
          <h2 id="recent-cases">Recently viewed in this browser</h2>
          <p className="hint">{LOCAL_HISTORY_NOTE}</p>
          {recent.length === 0 ? (
            <p>No cases viewed in this browser yet.</p>
          ) : (
            <ul>
              {recent.map((r) => (
                <li key={r}>
                  <a href={caseHref(r)}>
                    <code>{r}</code>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <section className="section" aria-labelledby="start-case">
        <h2 id="start-case">Start a case</h2>
        <div className="actions">
          {experimentBuild ? (
            <a className="button" href={actionHref("create_case")}>
              Start a case
            </a>
          ) : (
            <button className="button" type="button" disabled aria-describedby="start-case-note">
              Start a case
            </button>
          )}
        </div>
        <p id="start-case-note" className="hint">
          {experimentBuild
            ? "Opens the create-case form in the gated local experiment build. Every write is reviewed before your wallet is asked."
            : `Creating cases is not available in this build. ${WRITES_DISABLED_REASON}`}
        </p>
      </section>
    </>
  );
}
