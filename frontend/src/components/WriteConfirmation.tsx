import { useId, useRef, useState, type ReactNode } from "react";
import { STUDIONET } from "../config/network";
import { BEFORE_YOU_SUBMIT_BODY, BEFORE_YOU_SUBMIT_LEAD } from "../contract/copy";
import { describeCreateCase, validateCreateCase, type CreateCaseInput } from "../write/createCase";
import { EvidencePanel } from "./EvidencePanel";

export interface WriteConfirmationProps {
  /** The wallet's connected account, as the wallet reports it. */
  account: string | null;
  /** The wallet's chain, as the wallet reports it (never inferred from config). */
  walletChainId: number | null;
  /** The contract the case will be created on. */
  contract: string | null;
  input: CreateCaseInput;
  /** Set when writes may not start (disabled build, unresolved earlier write, storage, lock…). */
  blockedReason: string | null;
  /** Called at most once, only after every precondition holds and the user acknowledged. */
  onConfirm: () => void;
  onCancel?: () => void;
}

/** Preconditions that must all hold before the final action is enabled. */
export function confirmationBlockers(p: Pick<WriteConfirmationProps, "account" | "walletChainId" | "contract" | "input" | "blockedReason">): string[] {
  return baseBlockers(p).concat(validateCreateCase(p.input, p.account).map((problem) => `Case details: ${problem}.`));
}

function baseBlockers(p: { account: string | null; walletChainId: number | null; contract: string | null; blockedReason: string | null }): string[] {
  const out: string[] = [];
  if (p.blockedReason !== null) out.push(p.blockedReason);
  if (p.account === null) out.push("No wallet account is connected.");
  if (p.walletChainId !== STUDIONET.chainId) {
    out.push(`Your wallet is not on StudioNet (chain ID ${STUDIONET.chainId})${p.walletChainId === null ? "" : `; it reports ${p.walletChainId}`}.`);
  }
  if (p.contract === null) out.push("No VeriCourt contract is configured for this build.");
  return out;
}

/** One reviewed value, exactly as it will be encoded (rendered as text). */
export interface ConfirmationRow {
  label: string;
  value: string | string[];
  note?: string;
  /** Prefix list items with I1, I2… (issues are numbered by the contract). */
  numberIssues?: boolean;
}

export interface ActionConfirmationProps {
  account: string | null;
  walletChainId: number | null;
  contract: string | null;
  /** Contract function name, shown verbatim. */
  functionName: string;
  functionSummary: string;
  rows: readonly ConfirmationRow[];
  rowsHeading: string;
  /** Accessible name of the reviewed-values list (defaults to the heading). */
  rowsLabel?: string;
  /** Method-specific warnings, shown before the acknowledgement. */
  warnings: readonly { title: string; body: ReactNode }[];
  /** Show the mandatory "Before you submit" warning (case creation and evidence). */
  beforeYouSubmit: boolean;
  acknowledgement: string;
  /** Every reason the write may not start (empty = may start once acknowledged). */
  blockers: readonly string[];
  onConfirm: () => void;
  onCancel?: () => void;
  /** Extra controls rendered just above the acknowledgement (e.g. a last-attempt confirmation). */
  extra?: ReactNode;
  /** When false, the final button stays disabled (e.g. an extra confirmation is missing). */
  extraSatisfied?: boolean;
}

export function BeforeYouSubmit() {
  return (
    <EvidencePanel title="Before you submit" tone="warning">
      <p>
        <strong>{BEFORE_YOU_SUBMIT_LEAD}</strong> {BEFORE_YOU_SUBMIT_BODY}
      </p>
    </EvidencePanel>
  );
}

/**
 * The last screen before a wallet request, for any contract write. It shows
 * exactly the values that will be encoded, and the final button is the only
 * way to proceed. All values render as text.
 */
export function ActionConfirmation(props: ActionConfirmationProps) {
  const { account, walletChainId, contract, rows, onConfirm, onCancel, blockers } = props;
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const fired = useRef(false); // a double click must not call onConfirm twice
  const ackId = useId();
  const canConfirm = blockers.length === 0 && acknowledged && !confirmed && props.extraSatisfied !== false;

  const confirm = () => {
    if (!canConfirm || fired.current) return;
    fired.current = true;
    setConfirmed(true);
    onConfirm();
  };

  return (
    <section aria-labelledby="confirm-heading">
      <h2 id="confirm-heading">Review this transaction</h2>
      <p className="lede">Check every detail. Your wallet will ask you to sign only after you press the final button below.</p>

      <dl className="facts">
        <dt>Network</dt>
        <dd>
          {STUDIONET.name} (StudioNet), chain ID <code>{STUDIONET.chainId}</code>{" "}
          {walletChainId === STUDIONET.chainId ? (
            <span className="tag tag--ok">Wallet is on StudioNet</span>
          ) : (
            <span className="tag tag--warn">Wallet is not on StudioNet</span>
          )}
        </dd>
        <dt>Your account</dt>
        <dd>{account === null ? "Not connected" : <code className="block">{account}</code>}</dd>
        <dt>Contract</dt>
        <dd>{contract === null ? "Not configured" : <code className="block">{contract}</code>}</dd>
        <dt>Function</dt>
        <dd>
          <code>{props.functionName}</code>: {props.functionSummary}
        </dd>
      </dl>

      <h3>{props.rowsHeading}</h3>
      <dl className="facts" aria-label={props.rowsLabel ?? props.rowsHeading}>
        {rows.map((f) => (
          <div key={f.label} className="facts__row">
            <dt>{f.label}</dt>
            <dd>
              {Array.isArray(f.value) ? (
                <ol>
                  {f.value.map((item, i) => (
                    <li key={i}>
                      {f.numberIssues ? <span className="mono">I{i + 1}</span> : null} <span className="pre-wrap break">{item}</span>
                    </li>
                  ))}
                </ol>
              ) : (
                <span className="pre-wrap break">{f.value}</span>
              )}
              {f.note ? <span className="hint block">{f.note}</span> : null}
            </dd>
          </div>
        ))}
      </dl>

      {props.beforeYouSubmit ? <BeforeYouSubmit /> : null}
      {props.warnings.map((w) => (
        <EvidencePanel key={w.title} title={w.title} tone="warning">
          {w.body}
        </EvidencePanel>
      ))}

      {blockers.length > 0 ? (
        <div className="callout" role="status">
          <p>
            <strong>This transaction cannot be sent yet:</strong>
          </p>
          <ul>
            {blockers.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {props.extra}

      <p>
        <input id={ackId} type="checkbox" checked={acknowledged} disabled={confirmed} onChange={(e) => setAcknowledged(e.target.checked)} />{" "}
        <label htmlFor={ackId}>{props.acknowledgement}</label>
      </p>

      <div className="actions">
        <button className="button" type="button" disabled={!canConfirm} onClick={confirm}>
          {confirmed ? "Request sent to your wallet" : "Sign in wallet"}
        </button>
        {onCancel ? (
          <button className="button button--secondary" type="button" disabled={confirmed} onClick={onCancel}>
            Back to the form
          </button>
        ) : null}
      </div>
    </section>
  );
}

/** Generic blockers for a case-level write review (wallet, chain, contract, session, input). */
export function actionBlockers(p: { account: string | null; walletChainId: number | null; contract: string | null; blockedReason: string | null; inputProblems: readonly string[] }): string[] {
  return baseBlockers(p).concat(p.inputProblems.map((problem) => `Details: ${problem}.`));
}

/** The create_case review (Phase 3.5B screen, now with the mandatory "Before you submit" text). */
export function WriteConfirmation(props: WriteConfirmationProps) {
  const fields = describeCreateCase(props.input);
  return (
    <ActionConfirmation
      account={props.account}
      walletChainId={props.walletChainId}
      contract={props.contract}
      functionName="create_case"
      functionSummary="creates a new case with you as the claimant"
      rowsHeading="Case details that will be written"
      rowsLabel="Case details"
      rows={fields.map((f) => ({ label: f.label, value: f.value, ...(f.note ? { note: f.note } : {}), numberIssues: f.param === "issues" }))}
      beforeYouSubmit
      warnings={[
        {
          title: "This creates a case on chain",
          body: (
            <>
              <p>
                Signing sends one transaction that <strong>creates a new case on chain</strong>, naming the respondent above as the other party. It cannot
                be edited or withdrawn afterwards. The case ID is assigned by the contract.
              </p>
              <p>
                VeriCourt expects no fee on StudioNet. If your wallet shows a different network, a non-zero fee, or details that do not match this page,
                reject the request in your wallet.
              </p>
            </>
          ),
        },
        {
          title: "Privacy: public and permanent",
          body: (
            <p>
              Everything shown above, together with your account address, <strong>may be publicly visible and cannot be deleted</strong>. Do not include
              personal data, confidential information, or anything you would not publish.
            </p>
          ),
        },
      ]}
      acknowledgement="I understand this case will be created on chain, may be public, and cannot be deleted."
      blockers={confirmationBlockers(props)}
      onConfirm={props.onConfirm}
      {...(props.onCancel ? { onCancel: props.onCancel } : {})}
    />
  );
}
