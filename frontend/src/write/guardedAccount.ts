/**
 * Guarded local account for the SDK-only path (future Stage A, Node).
 * genlayer-js 1.1.8 treats an account object with `type: "local"` as a local
 * signer: it calls `account.signTransaction(request)` and then broadcasts the
 * bytes with `eth_sendRawTransaction` (dist/index.js 1116-1146). It cannot
 * create a transaction any other way, so a signer that signs at most once
 * means at most one transaction can exist for the operation, including when
 * the SDK attempts its V6 fallback.
 *
 * The wrapped signer is held in this closure only. The returned object exposes
 * the public address and refusing stubs for message and typed-data signing; it
 * never exposes the inner account. Nothing here creates a key: the caller
 * supplies the signer (Stage A will create a throwaway one in memory).
 */
import { parseLegacySignedTransaction, sameAddress, type Hex } from "./bytes";
import { MAX_GAS, checkSignRequest, errorCode, selectorOf, type WriteGuard } from "./guard";

export interface InnerSigner {
  readonly address: Hex;
  signTransaction(request: Record<string, unknown>): Promise<Hex>;
}

export interface GuardedLocalAccount {
  readonly address: Hex;
  readonly type: "local";
  readonly source: "vericourt-write-guard";
  signTransaction(request: Record<string, unknown>): Promise<Hex>;
  signMessage(): Promise<never>;
  signTypedData(): Promise<never>;
  sign(): Promise<never>;
}

export interface GuardedAccountOptions {
  /**
   * Optional keccak256 of the serialized transaction, so the transaction hash
   * is known before broadcast. Not built in (no keccak dependency here).
   */
  hashSignedTransaction?: (serialized: Hex) => Hex;
}

/** Compares released bytes with the request that was approved. */
function signedMatchesRequest(serialized: Hex, request: Record<string, unknown>): string | null {
  let tx;
  try {
    tx = parseLegacySignedTransaction(serialized);
  } catch {
    return "signed bytes are not a parseable legacy transaction";
  }
  const asBig = (v: unknown) => (typeof v === "bigint" ? v : typeof v === "number" ? BigInt(v) : null);
  if (tx.chainId !== asBig(request.chainId)) return "signed chain id differs";
  if (tx.nonce !== asBig(request.nonce)) return "signed nonce differs";
  if (tx.gasPrice !== 0n) return "signed gas price is not zero";
  if (tx.gas !== asBig(request.gas) || tx.gas > MAX_GAS) return "signed gas differs";
  if (tx.value !== 0n) return "signed value is not zero";
  if (tx.to === null || !sameAddress(tx.to, request.to)) return "signed `to` differs";
  if (typeof request.data !== "string" || tx.data.toLowerCase() !== request.data.toLowerCase()) return "signed data differs";
  return null;
}

export function createGuardedLocalAccount(
  inner: InnerSigner,
  guard: WriteGuard,
  options: GuardedAccountOptions = {},
): GuardedLocalAccount {
  const intent = guard.intent;
  if (!sameAddress(inner.address, intent.sender)) throw new Error("the signer is not the intent's sender");
  const address = inner.address;
  const refuseOther = (method: string) => async (): Promise<never> => {
    throw guard.refuse("signer", method, "only the one approved transaction may be signed");
  };

  return Object.freeze({
    address,
    type: "local" as const,
    source: "vericourt-write-guard" as const,
    async signTransaction(request: Record<string, unknown>): Promise<Hex> {
      const method = "signTransaction";
      const claimRefusal = guard.claim("signer", method, `refused request selector ${selectorOf(request.data)}`);
      if (claimRefusal) throw claimRefusal;
      // Copy the fields the signer needs; never pass the SDK's account object through.
      const approved: Record<string, unknown> = {
        type: request.type,
        chainId: request.chainId,
        nonce: request.nonce,
        gas: request.gas,
        gasPrice: request.gasPrice,
        to: request.to,
        value: request.value ?? 0n,
        data: request.data,
      };
      const reason = checkSignRequest(intent, approved);
      if (reason !== null) throw guard.refuse("signer", method, reason);

      try {
        guard.noteForwarded("signer", method, `to=${intent.consensusAddress} selector=${intent.selector} nonce=${String(approved.nonce)}`);
      } catch {
        throw guard.refuse("signer", method, "the pending-write record could not be saved first; nothing was signed");
      }
      let serialized: Hex;
      try {
        serialized = await inner.signTransaction(approved);
      } catch (err) {
        guard.noteSettled({ state: "error", errorCode: errorCode(err) });
        throw guard.refuse("signer", method, "signing failed; nothing was released");
      }
      const mismatch = signedMatchesRequest(serialized, approved);
      if (mismatch !== null) {
        guard.noteSettled({ state: "withheld" });
        throw guard.refuse("signer", method, `${mismatch}; the bytes were withheld`);
      }
      if (guard.closed) {
        guard.noteSettled({ state: "withheld" });
        throw guard.refuse("signer", method, "the operation was closed while signing; the bytes were withheld");
      }
      const hash = options.hashSignedTransaction?.(serialized) ?? null;
      guard.noteSettled({ state: "signed", signedTransaction: serialized, hash });
      return serialized;
    },
    signMessage: refuseOther("signMessage"),
    signTypedData: refuseOther("signTypedData"),
    sign: refuseOther("sign"),
  });
}
