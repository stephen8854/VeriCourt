import { STUDIONET, WRITES_DISABLED_REASON } from "../config/network";
import { AddressDisplay } from "../components/AddressDisplay";
import { EvidencePanel } from "../components/EvidencePanel";
import { useWallet } from "../wallet/WalletContext";
import { walletStatusView, type WalletState } from "../wallet/walletState";

function ChainLine({ chainId }: { chainId: number | null }) {
  if (chainId === null) return <>Not reported yet</>;
  const ok = chainId === STUDIONET.chainId;
  return (
    <>
      <code>{chainId}</code> (<code>0x{chainId.toString(16)}</code>){" "}
      <span className={`tag ${ok ? "tag--ok" : "tag--warn"}`}>{ok ? "Matches StudioNet" : "Not StudioNet"}</span>
    </>
  );
}

function WrongNetworkHelp({ chainId }: { chainId: number }) {
  return (
    <div role="alert" className="evidence-panel--warning callout">
      <p>
        <strong>Your wallet is on a different network.</strong> It reports chain ID <code>{chainId}</code>, but
        VeriCourt uses {STUDIONET.name}, chain ID <code>{STUDIONET.chainId}</code>.
      </p>
      <p>
        VeriCourt will not switch or add networks for you. To use VeriCourt, open your wallet and select a network with
        chain ID <code>{STUDIONET.chainId}</code> (RPC <code>{STUDIONET.rpcUrl}</code>). If your wallet does not list it,
        you can add it yourself in the wallet&apos;s network settings. This page updates when the wallet reports the change.
      </p>
    </div>
  );
}

function ChangeNote({ state }: { state: WalletState }) {
  if (state.lastChange === null) return null;
  return (
    <p className="hint" role="status">
      {state.lastChange === "account" ? "The wallet's active account changed." : "The wallet's network changed."} Anything
      that depended on the previous {state.lastChange} was cleared.
    </p>
  );
}

export function WalletDiagnostics() {
  const { state, hasProvider, connect, recheck, forget } = useWallet();
  const view = walletStatusView(state);
  const busy = state.phase === "connecting" || state.phase === "checking";

  return (
    <>
      <span className="kicker">Wallet</span>
      <h1>Wallet &amp; network</h1>

      <section aria-labelledby="wallet-heading">
        <h2 id="wallet-heading" className="visually-hidden">
          Your wallet
        </h2>
        {!hasProvider ? (
          <EvidencePanel title="No compatible wallet found" tone="warning">
            <p role="status">
              No injected EIP-1193 wallet (<code>window.ethereum</code>) was found in this browser. Install or enable a
              browser wallet, then reload this page. VeriCourt never asks for a private key or seed phrase.
            </p>
          </EvidencePanel>
        ) : (
          <EvidencePanel title={view.headline} tone={view.tone === "warn" ? "warning" : "default"}>
            <div aria-live="polite">
              <dl className="facts">
                <dt>Status</dt>
                <dd>
                  <span className={`tag tag--${view.tone}`}>{view.headline}</span>
                </dd>
                <dt>Account</dt>
                <dd>{state.account !== null ? <AddressDisplay address={state.account} label="Connected account" /> : "None shared with VeriCourt"}</dd>
                <dt>Wallet network</dt>
                <dd>
                  <ChainLine chainId={state.chainId} />
                </dd>
                <dt>Expected network</dt>
                <dd>
                  {STUDIONET.name}, chain ID <code>{STUDIONET.chainId}</code> (<code>{STUDIONET.chainIdHex}</code>)
                </dd>
              </dl>
              {state.message !== null && (
                <p role="alert">
                  <span className="tag tag--warn">Wallet message</span> {state.message}
                </p>
              )}
              {state.phase === "connected" && state.chainId !== null && view.chainMatches === false && (
                <WrongNetworkHelp chainId={state.chainId} />
              )}
              <ChangeNote state={state} />
              {state.eventsSupported === false && (
                <p className="hint">
                  This wallet does not report account or network changes. Use “Re-check wallet” after changing them.
                </p>
              )}
            </div>

            <div className="actions">
              {state.account === null && (
                <button className="button" type="button" onClick={connect} disabled={busy}>
                  Connect wallet
                </button>
              )}
              <button className="button button--secondary" type="button" onClick={recheck} disabled={busy}>
                Re-check wallet
              </button>
              {state.account !== null && (
                <button className="button button--secondary" type="button" onClick={forget} aria-describedby="forget-note">
                  Stop showing this account
                </button>
              )}
            </div>
            <p className="hint">
              “Connect wallet” asks your wallet to share an account. “Re-check wallet” only reads what the wallet already
              shares and never prompts. Neither changes your network or sends anything.
            </p>
            {state.account !== null && (
              <p id="forget-note" className="hint">
                “Stop showing this account” only clears it from this page. VeriCourt cannot revoke your wallet&apos;s
                permission: to disconnect, remove VeriCourt in your wallet&apos;s connected-sites settings. After a
                reload, VeriCourt will see the account again unless you do that.
              </p>
            )}
          </EvidencePanel>
        )}
      </section>

      <section className="section" aria-labelledby="separate-heading">
        <h2 id="separate-heading">How this relates to reading StudioNet</h2>
        <EvidencePanel title="Wallet network and data source are separate" tone="procedural">
          <p>
            The network shown above is what your <em>wallet</em> reports. VeriCourt reads contract data directly from{" "}
            <code>{STUDIONET.rpcUrl}</code> (see the Live read-only check). A working read connection does not mean your
            wallet is on the right network, and the wallet network never changes where VeriCourt reads from.
          </p>
          <p>
            <strong>{WRITES_DISABLED_REASON}</strong>
          </p>
        </EvidencePanel>
      </section>
    </>
  );
}
