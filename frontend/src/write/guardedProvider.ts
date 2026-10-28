/**
 * Guarded EIP-1193 provider for the browser-wallet path (future Stage B).
 * Pass it to genlayer-js as `createClient({ chain, account: <address string>,
 * provider: guarded })`. With an address-string account, genlayer-js 1.1.8
 * routes only PROVIDER_METHODS (eth_accounts, eth_requestAccounts,
 * eth_sendTransaction, eth_signTransaction, personal_sign,
 * eth_signTypedData_v4) to `config.provider` and sends everything else to the
 * RPC URL (dist/index.js 2354-2419). `config.provider` is used instead of
 * `window.ethereum` whenever it is set, so the SDK's write path cannot bypass
 * this wrapper. (The SDK's `connect()` and `cancelTransaction()` do use
 * `window.ethereum` directly; the app must never call them.)
 *
 * Behaviour:
 * - `eth_chainId`, `eth_accounts`: passive reads, forwarded.
 * - `eth_sendTransaction`: the single permit is claimed synchronously, then
 *   the params are checked against the intent, then the wallet's own chain and
 *   selected account are read; only then is the request forwarded, once.
 * - Everything else (signing, eth_requestAccounts, network switching, other
 *   wallet_* methods) is refused.
 *
 * Not cancellable: once forwarded, the wallet prompt is outside the app's
 * control. A later timeout only disarms the guard; the user can still approve
 * the open prompt. Its late result is still recorded for reconciliation.
 */
import type { Eip1193Provider } from "../wallet/eip1193";
import { checkSendTransactionParams, errorCode, isTxHash, selectorOf, type WriteGuard } from "./guard";

export class GuardMalformedResponse extends Error {
  constructor(method: string) {
    super(`VeriCourt write guard: the wallet returned an invalid result for ${method}; the request may have been sent`);
    this.name = "GuardMalformedResponse";
  }
}

const PASSIVE = new Set(["eth_chainId", "eth_accounts"]);

export function createGuardedProvider(inner: Eip1193Provider, guard: WriteGuard): Eip1193Provider {
  const intent = guard.intent;
  const expectedChainHex = `0x${intent.chainId.toString(16)}`;

  async function send(params: unknown): Promise<unknown> {
    const method = "eth_sendTransaction";
    const first: unknown = Array.isArray(params) ? params[0] : undefined;
    const claimRefusal = guard.claim("wallet", method, `refused request selector ${selectorOf((first as { data?: unknown } | undefined)?.data)}`);
    if (claimRefusal) throw claimRefusal;

    // Check and forward a private copy, so nothing can change the request between check and send.
    const copy: unknown = Array.isArray(params) ? params.map((p: unknown) => (typeof p === "object" && p !== null ? { ...p } : p)) : params;
    const reason = checkSendTransactionParams(intent, copy);
    if (reason !== null) throw guard.refuse("wallet", method, reason);

    // The SDK skips its own chain check on Studio chains (assertChainMatch, dist/index.js 2362-2363).
    let walletChain: unknown;
    let walletAccounts: unknown;
    try {
      walletChain = await inner.request({ method: "eth_chainId" });
      walletAccounts = await inner.request({ method: "eth_accounts" });
    } catch {
      throw guard.refuse("wallet", method, "could not read the wallet's chain and account before sending");
    }
    if (typeof walletChain !== "string" || walletChain.toLowerCase() !== expectedChainHex) {
      throw guard.refuse("wallet", method, "the wallet is not on the expected chain");
    }
    const selected = Array.isArray(walletAccounts) ? walletAccounts[0] : undefined;
    if (typeof selected !== "string" || selected.toLowerCase() !== intent.sender.toLowerCase()) {
      throw guard.refuse("wallet", method, "the wallet's selected account is not the approved account");
    }
    if (guard.closed) {
      // Disarmed (e.g. timed out) while the pre-send reads were in progress.
      throw guard.refuse("wallet", method, "the operation was closed before the request was forwarded");
    }

    try {
      guard.noteForwarded("wallet", method, `to=${intent.consensusAddress} selector=${intent.selector} bytes=${(intent.calldata.length - 2) / 2}`);
    } catch {
      throw guard.refuse("wallet", method, "the pending-write record could not be saved first; nothing was sent");
    }
    let result: unknown;
    try {
      result = await inner.request({ method, params: copy as unknown[] });
    } catch (err) {
      const code = errorCode(err);
      guard.noteSettled({ state: code === 4001 ? "rejected" : "error", errorCode: code });
      throw err;
    }
    if (!isTxHash(result)) {
      guard.noteSettled({ state: "malformed" });
      throw new GuardMalformedResponse(method);
    }
    guard.noteSettled({ state: "hash", hash: result });
    return result;
  }

  return {
    async request({ method, params }) {
      if (method === "eth_sendTransaction") return send(params);
      if (PASSIVE.has(method)) return inner.request({ method });
      throw guard.refuse("wallet", method, "method not permitted during a guarded write");
    },
  };
}
