/**
 * Wallet connection state: a pure reducer, no I/O.
 *
 * - Every value from the provider is validated before it is stored or shown.
 * - Results of superseded reads (an older op id) are ignored, so a slow passive
 *   read cannot overwrite a newer connection or event.
 * - `accountEpoch` increments whenever the displayed account or chain changes
 *   or is cleared; account-dependent views key on it to drop stale state.
 * - "Forget" only stops this app from showing an account. It cannot revoke the
 *   wallet's permission; that must be done in the wallet itself.
 * - Nothing here starts a write, a signature or a network switch.
 */
import { classifyProviderError, interpretAccounts, interpretChainId, isExpectedChain, type RawWalletRead } from "./eip1193";

export type WalletPhase =
  | "no_provider"
  | "checking" // passive read in progress
  | "not_connected" // provider present, no account shared with this app
  | "connecting" // eth_requestAccounts pending
  | "connected"
  | "rejected" // user declined the connection request
  | "provider_error" // provider failed or returned malformed data
  | "disconnected"; // account list became empty after an account was shown

export interface WalletState {
  phase: WalletPhase;
  account: string | null;
  chainId: number | null;
  message: string | null;
  lastChange: "account" | "chain" | null;
  accountEpoch: number;
  forgotten: boolean;
  eventsSupported: boolean | null;
  op: number;
  /**
   * True only after the user pressed Connect (eth_requestAccounts) in this page
   * and the same account is still shown. A passive read on load, or a switch to
   * another account in the wallet, does not count. Writes require it.
   */
  explicitConnection: boolean;
  /**
   * The account (lowercase) that the latest Connect request in this page
   * returned. Recorded even when a wallet event superseded that request:
   * many wallets emit accountsChanged / chainChanged while eth_requestAccounts
   * is resolving (Phase 3.6 live-test finding). `explicitConnection` holds
   * only while the shown account equals it. Cleared by a switch to another
   * account, disconnect, Forget, a rejected or failed Connect, and reloads.
   */
  connectGrant: string | null;
}

export const initialWalletState = (hasProvider: boolean): WalletState => ({
  phase: hasProvider ? "not_connected" : "no_provider",
  account: null,
  chainId: null,
  message: null,
  lastChange: null,
  accountEpoch: 0,
  forgotten: false,
  eventsSupported: null,
  op: 0,
  explicitConnection: false,
  connectGrant: null,
});

export type WalletEvent =
  | { type: "READ_START"; op: number; source: "passive" | "connect" }
  | { type: "READ_OK"; op: number; source: "passive" | "connect"; raw: RawWalletRead }
  | { type: "READ_FAILED"; op: number; source: "passive" | "connect"; error: unknown }
  | { type: "ACCOUNTS_CHANGED"; op: number; raw: unknown }
  | { type: "CHAIN_CHANGED"; op: number; raw: unknown }
  | { type: "CHAIN_REREAD"; op: number; raw: unknown }
  | { type: "PROVIDER_DISCONNECT"; op: number }
  | { type: "EVENTS_SUPPORTED"; supported: boolean }
  | { type: "FORGET"; op: number };

function cleared(state: WalletState, phase: WalletPhase, message: string | null): WalletState {
  const changed = state.account !== null || state.chainId !== null;
  return {
    ...state,
    phase,
    account: null,
    chainId: null,
    message,
    accountEpoch: changed ? state.accountEpoch + 1 : state.accountEpoch,
    explicitConnection: false,
    connectGrant: null,
  };
}

/** The grant applies only to the exact account Connect returned (case-insensitive). */
function explicitFor(account: string | null, grant: string | null, phase: WalletPhase): boolean {
  return phase === "connected" && account !== null && grant !== null && account.toLowerCase() === grant;
}

function withAccount(
  state: WalletState,
  account: string,
  chainId: number,
  lastChange: WalletState["lastChange"],
  explicit: "granted" | "keep_existing_grant",
): WalletState {
  const changed = account !== state.account || chainId !== state.chainId;
  const connectGrant = explicit === "granted" ? account.toLowerCase() : state.connectGrant;
  return {
    ...state,
    phase: "connected",
    account,
    chainId,
    message: null,
    lastChange,
    accountEpoch: changed ? state.accountEpoch + 1 : state.accountEpoch,
    connectGrant,
    explicitConnection: explicitFor(account, connectGrant, "connected"),
  };
}

export function walletReducer(state: WalletState, event: WalletEvent): WalletState {
  if (state.phase === "no_provider") return state;
  switch (event.type) {
    case "READ_START":
      if (event.source === "connect") {
        // A new Connect replaces any earlier grant; only its own result can grant again.
        return { ...state, phase: "connecting", message: null, op: event.op, forgotten: false, connectGrant: null, explicitConnection: false };
      }
      return { ...state, phase: state.account === null ? "checking" : state.phase, op: event.op };

    case "READ_OK": {
      if (event.op !== state.op) {
        // Superseded by a newer read or a wallet event. A passive result is dropped.
        // A Connect result still records WHICH account the user's Connect returned;
        // the newer state decides what is shown, and the grant applies only if it
        // shows that same account.
        if (event.source !== "connect" || state.forgotten) return state;
        const accounts = interpretAccounts(event.raw.accounts);
        const chain = interpretChainId(event.raw.chainId);
        const [first] = accounts.ok ? accounts.accounts : [];
        if (!accounts.ok || !chain.ok || first === undefined) return state;
        const connectGrant = first.toLowerCase();
        return { ...state, connectGrant, explicitConnection: explicitFor(state.account, connectGrant, state.phase) };
      }
      const chain = interpretChainId(event.raw.chainId);
      const accounts = interpretAccounts(event.raw.accounts);
      if (!accounts.ok) return cleared(state, "provider_error", `The wallet returned a malformed account list: ${accounts.raw}`);
      if (!chain.ok) return cleared(state, "provider_error", `The wallet returned a malformed chain ID: ${chain.raw}`);
      const [first] = accounts.accounts;
      if (first === undefined) {
        if (state.account !== null) return cleared(state, "disconnected", "The wallet no longer shares any account with VeriCourt.");
        const message = event.source === "connect" ? "The wallet did not share any account." : null;
        return { ...cleared(state, "not_connected", message), chainId: chain.chainId };
      }
      if (event.source === "passive" && state.forgotten) return { ...cleared(state, "not_connected", null), chainId: chain.chainId };
      return withAccount(state, first, chain.chainId, null, event.source === "connect" ? "granted" : "keep_existing_grant");
    }

    case "READ_FAILED": {
      if (event.op !== state.op) return state;
      const err = classifyProviderError(event.error);
      if (event.source === "connect" && err.kind === "rejected") return cleared(state, "rejected", err.message);
      return cleared(state, "provider_error", err.message);
    }

    case "ACCOUNTS_CHANGED": {
      const accounts = interpretAccounts(event.raw);
      const next = { ...state, op: event.op }; // supersede any read in flight
      if (!accounts.ok) return { ...cleared(next, "provider_error", `The wallet reported a malformed account list: ${accounts.raw}`), lastChange: "account" };
      const [first] = accounts.accounts;
      if (first === undefined) {
        if (state.account === null) return next;
        return { ...cleared(next, "disconnected", "The wallet no longer shares any account with VeriCourt."), lastChange: "account" };
      }
      if (state.forgotten) return next;
      // A switch to a different account ends the grant (switching back does not restore it).
      const kept = state.connectGrant !== null && first.toLowerCase() === state.connectGrant ? state.connectGrant : null;
      const nextKept = { ...next, connectGrant: kept };
      if (state.chainId === null) {
        // Account known, chain not yet verified: do not show it as connected until the chain is read.
        return { ...cleared(nextKept, "checking", null), connectGrant: kept, lastChange: "account" };
      }
      return withAccount(nextKept, first, state.chainId, "account", "keep_existing_grant");
    }

    case "CHAIN_CHANGED":
    case "CHAIN_REREAD": {
      if (event.type === "CHAIN_REREAD" && event.op !== state.op) return state;
      const chain = interpretChainId(event.raw);
      const next = event.type === "CHAIN_CHANGED" ? { ...state, op: event.op } : state;
      if (!chain.ok) return { ...cleared(next, "provider_error", `The wallet reported a malformed chain ID: ${chain.raw}`), lastChange: "chain" };
      if (next.account === null) return { ...next, chainId: chain.chainId, lastChange: "chain" };
      return withAccount(next, next.account, chain.chainId, "chain", "keep_existing_grant");
    }

    case "PROVIDER_DISCONNECT":
      return { ...cleared({ ...state, op: event.op }, "provider_error", "The wallet reported that it lost its connection to the network."), lastChange: null };

    case "EVENTS_SUPPORTED":
      return { ...state, eventsSupported: event.supported };

    case "FORGET":
      return { ...cleared({ ...state, op: event.op }, "not_connected", null), forgotten: true, lastChange: null };
  }
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export type WalletTone = "ok" | "warn" | "neutral" | "info";

export interface WalletStatusView {
  headline: string;
  tone: WalletTone;
  /** True only when an account is shown AND the wallet reports StudioNet. */
  readyForStudioNet: boolean;
  chainMatches: boolean | null;
}

export function walletStatusView(state: WalletState): WalletStatusView {
  const chainMatches = state.chainId === null ? null : isExpectedChain(state.chainId);
  switch (state.phase) {
    case "no_provider":
      return { headline: "No compatible wallet detected", tone: "neutral", readyForStudioNet: false, chainMatches: null };
    case "checking":
      return { headline: "Checking wallet…", tone: "info", readyForStudioNet: false, chainMatches };
    case "not_connected":
      return { headline: "Wallet detected, not connected", tone: "neutral", readyForStudioNet: false, chainMatches };
    case "connecting":
      return { headline: "Waiting for your wallet…", tone: "info", readyForStudioNet: false, chainMatches };
    case "connected":
      return chainMatches
        ? { headline: "Connected to StudioNet", tone: "ok", readyForStudioNet: true, chainMatches }
        : { headline: "Connected, wrong network", tone: "warn", readyForStudioNet: false, chainMatches };
    case "rejected":
      return { headline: "Connection declined", tone: "warn", readyForStudioNet: false, chainMatches };
    case "provider_error":
      return { headline: "Wallet problem", tone: "warn", readyForStudioNet: false, chainMatches };
    case "disconnected":
      return { headline: "Wallet disconnected", tone: "warn", readyForStudioNet: false, chainMatches };
  }
}
