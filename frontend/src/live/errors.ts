/** Bounded waits and error categories for read-only calls. No retries anywhere. */

export class ReadTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label}: no response within ${ms} ms`);
    this.name = "ReadTimeoutError";
  }
}

/**
 * Resolves or rejects with the promise, or rejects with ReadTimeoutError after
 * `ms`. The underlying request cannot be cancelled (the SDK's fetch takes no
 * signal); it is abandoned, which is safe only because every call here is a read.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ReadTimeoutError(label, ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export type ErrorCategory =
  | "timeout"
  | "network_or_cors" // fetch rejected: no response reached the page (network, DNS, CORS or blocked request)
  | "rpc_error" // the endpoint answered with a JSON-RPC error or gen_call failure status
  | "unparseable_response" // a response arrived but was not valid JSON
  | "sdk_error"; // the SDK threw while processing or decoding a response

export interface CategorisedError {
  category: ErrorCategory;
  message: string;
}

function clip(text: string): string {
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

export function categoriseError(err: unknown): CategorisedError {
  if (err instanceof ReadTimeoutError) return { category: "timeout", message: err.message };
  if (err instanceof TypeError && /fetch|network|load failed/i.test(err.message)) {
    return { category: "network_or_cors", message: clip(err.message) };
  }
  if (err instanceof SyntaxError) return { category: "unparseable_response", message: clip(err.message) };
  if (err instanceof Error) {
    if (/gen_call failed|Unexpected gen_call response/.test(err.message)) return { category: "rpc_error", message: clip(err.message) };
    // viem (inside genlayer-js) wraps a failed fetch in an UnknownRpcError whose details say so: still a network failure.
    if (/Details: (Failed to fetch|NetworkError|Load failed)/i.test(err.message)) return { category: "network_or_cors", message: clip(`${err.name}: ${err.message}`) };
    return { category: "sdk_error", message: clip(`${err.name}: ${err.message}`) };
  }
  // The SDK transport throws the raw JSON-RPC `error` object ({code, message}).
  if (typeof err === "object" && err !== null && "code" in err) {
    const e = err as { code: unknown; message?: unknown };
    return { category: "rpc_error", message: clip(`code ${String(e.code)}: ${String(e.message ?? "")}`) };
  }
  return { category: "sdk_error", message: clip(String(err)) };
}
