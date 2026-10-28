/**
 * Phase 3.5A Stage A: shared configuration for the one-off Node scripts.
 * Not part of the app: nothing under src/ imports this, and it is not in the build.
 *
 * Every RPC call goes through `boundedFetch`: a method allowlist, a per-call
 * abort timeout, spacing between requests, and a request log (method, timing,
 * outcome, never bodies).
 */
import { PHASE_2_17C_NO_REPLY } from "../../src/config/testDeployments";
import type { Hex } from "../../src/write/bytes";
import type { CalldataArg } from "../../src/write/intent";

export const RPC_URL = "https://studio.genlayer.com/api";
export const CHAIN_ID_HEX = "0xf22f";
export const CONTRACT = PHASE_2_17C_NO_REPLY.address as Hex;
export const EXPECTED_CODE_SHA256 = PHASE_2_17C_NO_REPLY.expectedCodeSha256;
export const DEPLOY_TX = PHASE_2_17C_NO_REPLY.deployTx;

/** Respondent: a fictional address. Its "F1C710A1" prefix reads as "FICTIONAL". Nobody signs with it. */
export const FICTIONAL_RESPONDENT = "0xF1C710A100000000000000000000000000000001" as Hex;

/** create_case arguments, in contract order. Every field is visibly fictional. */
export const FICTIONAL_CASE_ARGS: CalldataArg[] = [
  FICTIONAL_RESPONDENT,
  "OTHER",
  "FICTIONAL TEST - VeriCourt Phase 3.5A Stage A write check",
  "FICTIONAL - no real agreement exists. This record was created by the VeriCourt Phase 3.5A Stage A experiment to test one genlayer-js write on StudioNet.",
  "FICTIONAL - nothing was to be delivered. This record exists only to test the write path.",
  "FICTIONAL TEST RECORD - not a real dispute. No real party, work, payment or claim is involved.",
  "None - fictional test record.",
  ["FICTIONAL - placeholder issue for a write-path test"],
  3600n,
];

export interface RequestLogEntry {
  seq: number;
  method: string;
  startedMs: number;
  durationMs: number;
  outcome: "ok" | "rpc_error" | "http_error" | "transport_error" | "timeout" | "refused";
  detail: string | null;
}

export const T0 = Date.now();
export const requestLog: RequestLogEntry[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wraps fetch: only `allowed` JSON-RPC methods to RPC_URL, one at a time,
 * >= 300 ms apart, each aborted after `timeoutMs`. Methods in `noAbort` are
 * never aborted (a broadcast must not lose its response).
 */
export function boundedFetch(
  inner: typeof fetch,
  allowed: ReadonlySet<string>,
  options: { timeoutMs?: number; noAbort?: ReadonlySet<string> } = {},
): typeof fetch {
  const timeoutMs = options.timeoutMs ?? 20_000;
  let last = 0;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let method = "?";
    try {
      method = String((JSON.parse(String(init?.body)) as { method?: unknown }).method);
    } catch {
      /* recorded as "?" and refused below */
    }
    const entry: RequestLogEntry = { seq: requestLog.length + 1, method, startedMs: Date.now() - T0, durationMs: 0, outcome: "ok", detail: null };
    requestLog.push(entry);
    if (url !== RPC_URL || !allowed.has(method)) {
      entry.outcome = "refused";
      entry.detail = url !== RPC_URL ? "URL not allowed" : "method not allowed";
      throw new Error(`Stage A bounded fetch refused ${method}`);
    }
    const wait = last + 300 - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    const started = Date.now();
    const controller = new AbortController();
    const abortable = !(options.noAbort?.has(method) ?? false);
    const timer = abortable ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
    try {
      const res = await inner(input, { ...init, ...(abortable ? { signal: controller.signal } : {}) });
      const text = await res.text();
      entry.durationMs = Date.now() - started;
      if (!res.ok) {
        entry.outcome = "http_error";
        entry.detail = `HTTP ${res.status}`;
      } else {
        try {
          const err = (JSON.parse(text) as { error?: { code?: unknown; message?: unknown } }).error;
          if (err) {
            entry.outcome = "rpc_error";
            entry.detail = `code ${String(err.code)}: ${String(err.message).slice(0, 200)}`;
          }
        } catch {
          entry.detail = "non-JSON body";
        }
      }
      return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
    } catch (err) {
      entry.durationMs = Date.now() - started;
      entry.outcome = controller.signal.aborted ? "timeout" : "transport_error";
      entry.detail = (err as Error).name;
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }) as typeof fetch;
}

/** Runs `fn`, records {ok, value | error} and never throws. */
export async function step<T>(label: string, fn: () => Promise<T>): Promise<{ label: string; ok: true; value: T } | { label: string; ok: false; error: string }> {
  try {
    return { label, ok: true, value: await fn() };
  } catch (err) {
    const e = err as { name?: unknown; message?: unknown; code?: unknown };
    return { label, ok: false, error: `${String(e.name ?? "Error")}${e.code !== undefined ? ` (code ${String(e.code)})` : ""}: ${String(e.message ?? err).slice(0, 300)}` };
  }
}

export function toJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? `${v.toString()}n` : v instanceof Map ? Object.fromEntries(v) : v), 2);
}

/** Throws (without echoing anything) if `secretHex`'s digits occur anywhere in `text`. */
export function assertSecretAbsent(text: string, secretHex: string): void {
  const digits = secretHex.toLowerCase().replace(/^0x/, "");
  if (digits.length < 32 || text.toLowerCase().includes(digits)) throw new Error("refusing to output: secret material detected");
}
