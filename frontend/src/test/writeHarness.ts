/**
 * Offline doubles for the guarded write path. No keys, no signatures, no network:
 * - the fake signer returns RLP-correct legacy bytes with dummy r/s values
 *   (not a signature; nothing could ever verify or broadcast them);
 * - the fake wallet and RPC answer from memory and count every call.
 */
import { vi } from "vitest";
import { PHASE_2_17C_NO_REPLY } from "../config/testDeployments";
import { bigintToBytes, bytesToHex, hexToBytes, rlpEncode, type Hex } from "../write/bytes";
import type { InnerSigner } from "../write/guardedAccount";
import { buildWriteIntent, studionetWriteParams, type CalldataArg, type ContractWriteMethod, type WriteIntent } from "../write/intent";

export const SENDER = `0x${"1a".repeat(20)}` as Hex;
export const OTHER = `0x${"2b".repeat(20)}` as Hex;
export const CONTRACT = PHASE_2_17C_NO_REPLY.address;
export const TX_HASH = `0x${"cd".repeat(32)}` as Hex;
export const RPC_URL = "https://studio.genlayer.com/api";

export function testIntent(
  overrides: { method?: ContractWriteMethod; args?: CalldataArg[]; expectedNonce?: bigint; sender?: Hex; operationId?: string } = {},
): WriteIntent {
  return buildWriteIntent({
    operationId: overrides.operationId ?? "op-1",
    chain: studionetWriteParams(),
    sender: overrides.sender ?? SENDER,
    contractAddress: CONTRACT,
    method: overrides.method ?? "request_assessment",
    args: overrides.args ?? ["VC-FICTIONAL-1"],
    ...(overrides.expectedNonce !== undefined ? { expectedNonce: overrides.expectedNonce } : {}),
  });
}

/** The eth_sendTransaction params genlayer-js 1.1.8 builds for this intent (dist/index.js 1160-1171). */
export function sdkLikeSendParams(intent: WriteIntent, overrides: Record<string, unknown> = {}): unknown[] {
  return [
    {
      from: intent.sender,
      to: intent.consensusAddress,
      data: intent.calldata,
      value: "0x0",
      gas: "0x30d40",
      nonce: "0x0",
      type: "0x0",
      chainId: "0xf22f",
      gasPrice: "0x0",
      ...overrides,
    },
  ];
}

/** The signTransaction request genlayer-js 1.1.8 builds for a local account (dist/index.js 1123-1133). */
export function sdkLikeSignRequest(intent: WriteIntent, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    account: { address: intent.sender },
    to: intent.consensusAddress,
    data: intent.calldata,
    type: "legacy",
    nonce: 0,
    value: 0n,
    gas: 200000n,
    gasPrice: 0n,
    chainId: 61999,
    ...overrides,
  };
}

const big = (v: unknown) => (typeof v === "bigint" ? v : BigInt(v as number));

/** Builds legacy RLP bytes for a request, with dummy (non-signature) r and s. */
export function fakeSerialize(request: Record<string, unknown>, tamper: Partial<Record<"to" | "data" | "nonce", unknown>> = {}): Hex {
  const r: Record<string, unknown> = { ...request, ...tamper };
  return bytesToHex(
    rlpEncode([
      bigintToBytes(big(r.nonce)),
      bigintToBytes(big(r.gasPrice)),
      bigintToBytes(big(r.gas)),
      hexToBytes(r.to as string),
      bigintToBytes(big(r.value ?? 0n)),
      hexToBytes(r.data as string),
      bigintToBytes(big(r.chainId) * 2n + 35n),
      Uint8Array.of(1),
      Uint8Array.of(2),
    ]),
  );
}

export function fakeSigner(address: Hex = SENDER, behaviour: "ok" | "throw" | "tamper" = "ok"): InnerSigner & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  return {
    address,
    calls,
    signTransaction: vi.fn(async (request: Record<string, unknown>) => {
      calls.push(request);
      if (behaviour === "throw") throw Object.assign(new Error("signer unavailable"), { code: "SIGNER" });
      return fakeSerialize(request, behaviour === "tamper" ? { nonce: 7 } : {});
    }),
  };
}

type WalletReply = { result: unknown } | { error: unknown } | { pending: Promise<unknown> };

/** A fake wallet that records every request. `send` controls the eth_sendTransaction reply. */
export function fakeWallet(options: { chainId?: unknown; accounts?: unknown; send?: () => WalletReply } = {}) {
  const sends: unknown[][] = [];
  const request = vi.fn(async ({ method, params }: { method: string; params?: unknown[] }) => {
    if (method === "eth_chainId") return options.chainId ?? "0xf22f";
    if (method === "eth_accounts") return options.accounts ?? [SENDER];
    if (method === "eth_requestAccounts") return options.accounts ?? [SENDER];
    if (method === "eth_sendTransaction") {
      sends.push(params ?? []);
      const reply = options.send?.() ?? { result: TX_HASH };
      if ("error" in reply) throw reply.error;
      if ("pending" in reply) return reply.pending;
      return reply.result;
    }
    throw new Error(`fake wallet: unexpected method ${method}`);
  });
  return { request, sends, methods: () => request.mock.calls.map(([a]) => a.method) };
}

export function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type RpcHandler = (params: unknown[]) => { result: unknown } | { error: unknown } | Promise<{ result: unknown } | { error: unknown }>;

/**
 * In-memory JSON-RPC endpoint with the `fetch` signature. Unknown methods fail
 * the test. Records every method called.
 */
export function fakeRpc(handlers: Record<string, RpcHandler>) {
  const calls: { method: string; params: unknown[] }[] = [];
  const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: unknown; method: string; params?: unknown[] };
    const params = body.params ?? [];
    calls.push({ method: body.method, params });
    const handler = handlers[body.method];
    if (!handler) throw new Error(`fake RPC: unexpected method ${body.method}`);
    const reply = await handler(params);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...reply }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  return { fetch: fetchImpl, calls, methods: () => calls.map((c) => c.method) };
}

/** Read handlers the SDK's write path needs before it sends anything. */
export const PRE_SEND_READS: Record<string, RpcHandler> = {
  eth_getTransactionCount: () => ({ result: "0x0" }),
  eth_estimateGas: () => ({ result: "0x30d40" }),
  eth_gasPrice: () => ({ result: "0x0" }),
};

/** In-memory browser storage shared by simulated "tabs" and "reloads". Failure switches per operation. */
export function fakeStorage() {
  const data = new Map<string, string>();
  const fail = { get: false, set: false, setOnlyWhen: null as null | ((value: string) => boolean) };
  const writes: string[] = [];
  return {
    data,
    fail,
    writes,
    getItem(key: string) {
      if (fail.get) throw new Error("storage read blocked");
      return data.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (fail.set || (fail.setOnlyWhen?.(value) ?? false)) throw new Error("storage write blocked");
      writes.push(value);
      data.set(key, value);
    },
    removeItem(key: string) {
      data.delete(key);
    },
  };
}

/** fakeWallet plus EIP-1193 events (accountsChanged, chainChanged, disconnect). */
export function eventfulWallet(options: Parameters<typeof fakeWallet>[0] = {}) {
  const base = fakeWallet(options);
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    ...base,
    on(event: string, l: (...args: unknown[]) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)?.add(l);
    },
    removeListener(event: string, l: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(l);
    },
    emit(event: string, ...args: unknown[]) {
      for (const l of [...(listeners.get(event) ?? [])]) l(...args);
    },
    listenerCount: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
  };
}
