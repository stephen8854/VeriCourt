/**
 * Isolated EIP-1193 provider access for wallet connection.
 *
 * genlayer-js 1.1.8's `client.connect()` requires MetaMask Snaps
 * (wallet_requestSnaps) and adds/switches networks, so it is not used.
 * This module only:
 * - detects an injected provider (never assumes `window.ethereum` exists),
 * - reads `eth_chainId` / `eth_accounts` (passive, no prompt),
 * - asks for accounts with `eth_requestAccounts` (only when the user clicks Connect),
 * - subscribes to `accountsChanged`, `chainChanged` and `disconnect`.
 * It never switches or adds networks and never sends or signs anything.
 * Values are returned raw; interpretChainId / interpretAccounts validate them.
 */
import { STUDIONET } from "../config/network";

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
}

/** The only provider methods this build may call. */
export const ALLOWED_WALLET_METHODS = ["eth_chainId", "eth_accounts", "eth_requestAccounts"] as const;
type AllowedMethod = (typeof ALLOWED_WALLET_METHODS)[number];

export function getInjectedProvider(win: unknown = globalThis): Eip1193Provider | null {
  let candidate: unknown;
  try {
    candidate = (win as { ethereum?: unknown } | null | undefined)?.ethereum;
  } catch {
    return null; // a throwing getter is treated as "no provider"
  }
  return typeof candidate === "object" && candidate !== null && typeof (candidate as Eip1193Provider).request === "function"
    ? (candidate as Eip1193Provider)
    : null;
}

function call(provider: Eip1193Provider, method: AllowedMethod): Promise<unknown> {
  return provider.request({ method });
}

export interface RawWalletRead {
  chainId: unknown;
  accounts: unknown;
}

/** Passive read: never prompts the user. */
export async function readWalletRaw(provider: Eip1193Provider): Promise<RawWalletRead> {
  const chainId = await call(provider, "eth_chainId");
  const accounts = await call(provider, "eth_accounts");
  return { chainId, accounts };
}

/** Explicit connection: prompts the user to share accounts. Call only from a user action. */
export async function requestWalletRaw(provider: Eip1193Provider): Promise<RawWalletRead> {
  const accounts = await call(provider, "eth_requestAccounts");
  const chainId = await call(provider, "eth_chainId");
  return { chainId, accounts };
}

export function readChainIdRaw(provider: Eip1193Provider): Promise<unknown> {
  return call(provider, "eth_chainId");
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Shown in messages about malformed values: clipped and stringified, never interpreted. */
export function displayRaw(value: unknown): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

export type ChainIdResult = { ok: true; chainId: number } | { ok: false; raw: string };

/** EIP-1193 chain IDs are 0x-prefixed hex strings. Anything else is malformed. */
export function interpretChainId(value: unknown): ChainIdResult {
  if (typeof value === "string" && /^0x[0-9a-fA-F]{1,16}$/.test(value)) {
    const n = Number.parseInt(value, 16);
    if (Number.isSafeInteger(n) && n > 0) return { ok: true, chainId: n };
  }
  return { ok: false, raw: displayRaw(value) };
}

export type AccountsResult = { ok: true; accounts: string[] } | { ok: false; raw: string };

/**
 * Accepts only an array of 0x-prefixed 20-byte hex addresses. One invalid entry
 * makes the whole result malformed (nothing is silently dropped). The EIP-55
 * checksum is not verified (no keccak dependency); addresses are shown as returned.
 */
export function interpretAccounts(value: unknown): AccountsResult {
  if (!Array.isArray(value)) return { ok: false, raw: displayRaw(value) };
  if (!value.every((a) => typeof a === "string" && ADDRESS.test(a))) return { ok: false, raw: displayRaw(value) };
  return { ok: true, accounts: [...(value as string[])] };
}

export function isExpectedChain(chainId: number): boolean {
  return chainId === STUDIONET.chainId;
}

export function shortAddress(address: string): string {
  return ADDRESS.test(address) ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ProviderErrorKind = "rejected" | "pending" | "other";

export function classifyProviderError(err: unknown): { kind: ProviderErrorKind; message: string } {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 4001) return { kind: "rejected", message: "You declined the request in your wallet. Nothing was shared." };
  if (code === -32002) return { kind: "pending", message: "A request is already waiting in your wallet. Open your wallet to respond." };
  const message = (err as { message?: unknown } | null)?.message;
  const text = typeof message === "string" && message !== "" ? message : "The wallet returned an error.";
  return { kind: "other", message: text.length > 200 ? `${text.slice(0, 200)}…` : text };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface WalletEventHandlers {
  onAccountsChanged: (raw: unknown) => void;
  onChainChanged: (raw: unknown) => void;
  onDisconnect: () => void;
}

export interface Subscription {
  /** False when the provider has no usable on/removeListener: changes will not be reported. */
  supported: boolean;
  unsubscribe: () => void;
}

/** Registers exactly one listener per event; unsubscribe removes exactly those listeners. */
export function subscribeToWallet(provider: Eip1193Provider, handlers: WalletEventHandlers): Subscription {
  if (typeof provider.on !== "function" || typeof provider.removeListener !== "function") {
    return { supported: false, unsubscribe: () => undefined };
  }
  const accounts = (raw: unknown) => handlers.onAccountsChanged(raw);
  const chain = (raw: unknown) => handlers.onChainChanged(raw);
  const disconnect = () => handlers.onDisconnect();
  provider.on("accountsChanged", accounts);
  provider.on("chainChanged", chain);
  provider.on("disconnect", disconnect);
  let active = true;
  return {
    supported: true,
    unsubscribe: () => {
      if (!active) return;
      active = false;
      provider.removeListener?.("accountsChanged", accounts);
      provider.removeListener?.("chainChanged", chain);
      provider.removeListener?.("disconnect", disconnect);
    },
  };
}
