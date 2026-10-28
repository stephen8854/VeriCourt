/**
 * App-wide wallet state. One provider instance, one set of event listeners,
 * removed on unmount (React StrictMode's mount/unmount/mount leaves exactly one set).
 *
 * On load: a passive read (eth_chainId + eth_accounts; never prompts).
 * Connect: eth_requestAccounts, only from an explicit user action.
 * Events: accountsChanged / chainChanged update state immediately from their
 * payload; a chain change is then confirmed with one eth_chainId read.
 * Nothing is retried automatically. No write, signature or network switch exists here.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { getInjectedProvider, readChainIdRaw, readWalletRaw, requestWalletRaw, subscribeToWallet, type Eip1193Provider } from "./eip1193";
import { initialWalletState, walletReducer, type WalletState } from "./walletState";

export interface WalletApi {
  state: WalletState;
  hasProvider: boolean;
  /**
   * The detected provider, for the gated write experiment only (it wraps it in
   * the guarded provider). Nothing else may call it directly.
   */
  provider: Eip1193Provider | null;
  /** Explicit user action only: asks the wallet to share an account. */
  connect: () => void;
  /** Passive re-check (no prompt). */
  recheck: () => void;
  /** Stops this app from showing the account; does NOT revoke the wallet's permission. */
  forget: () => void;
}

const WalletContext = createContext<WalletApi | null>(null);

interface Props {
  children: ReactNode;
  /** Injected for tests. `undefined` means: detect window.ethereum once at mount. */
  provider?: Eip1193Provider | null;
}

export function WalletProvider({ children, provider: injected }: Props) {
  // Detected once per mount; a provider injected later is picked up on reload.
  const [provider] = useState<Eip1193Provider | null>(() =>
    injected !== undefined ? injected : getInjectedProvider(typeof window === "undefined" ? undefined : window),
  );
  const [state, dispatch] = useReducer(walletReducer, provider !== null, initialWalletState);
  const opRef = useRef(0);
  const stateRef = useRef(state);
  useLayoutEffect(() => {
    stateRef.current = state; // read only by event handlers and actions, never during render
  }, [state]);
  const mounted = useRef(false);

  const nextOp = () => {
    opRef.current += 1;
    return opRef.current;
  };

  const passiveRead = useCallback(() => {
    if (provider === null) return;
    const op = nextOp();
    dispatch({ type: "READ_START", op, source: "passive" });
    readWalletRaw(provider).then(
      (raw) => mounted.current && dispatch({ type: "READ_OK", op, source: "passive", raw }),
      (error: unknown) => mounted.current && dispatch({ type: "READ_FAILED", op, source: "passive", error }),
    );
  }, [provider]);

  useEffect(() => {
    mounted.current = true;
    if (provider === null) return () => {
      mounted.current = false;
    };
    const sub = subscribeToWallet(provider, {
      onAccountsChanged: (raw) => {
        dispatch({ type: "ACCOUNTS_CHANGED", op: nextOp(), raw });
        // An account with no verified chain is not shown as connected: read the chain (no prompt).
        if (stateRef.current.chainId === null) passiveRead();
      },
      onChainChanged: (raw) => {
        const op = nextOp();
        const hadAccount = stateRef.current.account !== null;
        dispatch({ type: "CHAIN_CHANGED", op, raw });
        if (!hadAccount) {
          // The event superseded any read in flight; with no account known, re-read both (no prompt).
          passiveRead();
          return;
        }
        readChainIdRaw(provider).then(
          (chainRaw) => mounted.current && dispatch({ type: "CHAIN_REREAD", op, raw: chainRaw }),
          (error: unknown) => mounted.current && dispatch({ type: "READ_FAILED", op, source: "passive", error }),
        );
      },
      onDisconnect: () => dispatch({ type: "PROVIDER_DISCONNECT", op: nextOp() }),
    });
    dispatch({ type: "EVENTS_SUPPORTED", supported: sub.supported });
    passiveRead();
    return () => {
      mounted.current = false;
      sub.unsubscribe();
    };
  }, [provider, passiveRead]);

  const connect = useCallback(() => {
    if (provider === null || stateRef.current.phase === "connecting") return;
    const op = nextOp();
    dispatch({ type: "READ_START", op, source: "connect" });
    requestWalletRaw(provider).then(
      (raw) => mounted.current && dispatch({ type: "READ_OK", op, source: "connect", raw }),
      (error: unknown) => mounted.current && dispatch({ type: "READ_FAILED", op, source: "connect", error }),
    );
  }, [provider]);

  const forget = useCallback(() => dispatch({ type: "FORGET", op: nextOp() }), []);

  const api = useMemo<WalletApi>(
    () => ({ state, hasProvider: provider !== null, provider, connect, recheck: passiveRead, forget }),
    [state, provider, connect, passiveRead, forget],
  );
  return <WalletContext.Provider value={api}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletApi {
  const api = useContext(WalletContext);
  if (api === null) throw new Error("useWallet must be used inside <WalletProvider>");
  return api;
}
