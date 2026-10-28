/**
 * Guarded `fetch` for the SDK-only path (future Stage A, Node).
 *
 * genlayer-js 1.1.8 sends every non-wallet JSON-RPC call through the global
 * `fetch` at call time, one POST per request, with retryCount 0
 * (dist/index.js 2395-2416, 2425). This wrapper is the second, independent
 * layer behind the guarded signer:
 * - only the configured RPC URL, only single (non-batch) JSON-RPC bodies;
 * - an allowlist of read methods, each bounded by an abort timeout;
 * - `eth_sendRawTransaction` only for the exact bytes this operation signed,
 *   and only once;
 * - every other method (eth_sendTransaction, sim_* writes, signing) refused.
 *
 * The broadcast itself is never aborted by this wrapper: aborting the HTTP
 * request would not cancel it on the server, it would only lose the response.
 * The application-level deadline (runner.ts) decides when to stop waiting.
 */
import { isTxHash, errorCode, type WriteGuard } from "./guard";

export const READ_METHODS = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_gasPrice",
  "eth_getTransactionCount",
  "eth_estimateGas",
  "eth_getTransactionReceipt",
  "eth_getTransactionByHash",
  "eth_getBlockByNumber",
  "gen_call",
  "gen_getContractCode",
]);

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface GuardedFetchOptions {
  rpcUrl: string;
  readTimeoutMs?: number;
}

function urlOf(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

export function createGuardedFetch(inner: FetchLike, guard: WriteGuard, options: GuardedFetchOptions): FetchLike {
  const readTimeoutMs = options.readTimeoutMs ?? 20_000;

  return async (input, init) => {
    if (urlOf(input) !== options.rpcUrl) throw guard.refuse("rpc", "fetch", "request to a URL other than the configured RPC");
    if ((init?.method ?? "GET").toUpperCase() !== "POST" || typeof init?.body !== "string") {
      throw guard.refuse("rpc", "fetch", "only JSON-RPC POST bodies are permitted");
    }
    let body: unknown;
    try {
      body = JSON.parse(init.body);
    } catch {
      throw guard.refuse("rpc", "fetch", "body is not JSON");
    }
    const rpc = body as { method?: unknown; params?: unknown };
    if (Array.isArray(body) || typeof rpc.method !== "string") throw guard.refuse("rpc", "fetch", "batch or malformed JSON-RPC body");
    const method = rpc.method;

    if (READ_METHODS.has(method)) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), readTimeoutMs);
      try {
        return await inner(input, { ...init, signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
    }

    if (method !== "eth_sendRawTransaction") throw guard.refuse("rpc", method, "method not permitted during a guarded write");

    const params = Array.isArray(rpc.params) ? rpc.params : [];
    const refusal = guard.claimBroadcast(params.length === 1 ? params[0] : undefined);
    if (refusal) throw refusal;

    let response: Response;
    try {
      response = await inner(input, init);
    } catch (err) {
      // No response: the server may or may not have received the transaction.
      guard.noteBroadcastSettled({ state: "transport_error", errorCode: errorCode(err) });
      throw err;
    }
    const text = await response.text().catch(() => null);
    let parsed: { result?: unknown; error?: unknown } | null = null;
    try {
      parsed = text === null ? null : (JSON.parse(text) as { result?: unknown; error?: unknown });
    } catch {
      parsed = null;
    }
    if (parsed !== null && isTxHash(parsed.result)) {
      guard.noteBroadcastSettled({ state: "hash", hash: parsed.result });
    } else if (parsed !== null && parsed.error !== undefined && parsed.error !== null) {
      guard.noteBroadcastSettled({ state: "rpc_error", errorCode: errorCode(parsed.error) });
    } else {
      guard.noteBroadcastSettled({ state: "malformed" });
    }
    return new Response(text ?? "", { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}
