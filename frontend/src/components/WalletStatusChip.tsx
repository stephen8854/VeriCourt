import { shortAddress } from "../wallet/eip1193";
import { useWallet } from "../wallet/WalletContext";
import { walletStatusView } from "../wallet/walletState";

/** Compact header status. Links to the wallet page; performs no wallet calls. */
export function WalletStatusChip() {
  const { state } = useWallet();
  const view = walletStatusView(state);
  return (
    <a className={`wallet-chip wallet-chip--${view.tone}`} href="#/wallet" aria-label={`Wallet status: ${view.headline}. Open wallet page.`}>
      <span className="wallet-chip__dot" aria-hidden="true" />
      {view.headline}
      {state.account !== null && <span className="mono"> · {shortAddress(state.account)}</span>}
    </a>
  );
}
