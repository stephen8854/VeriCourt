/**
 * React glue for the read-only case views. Reads happen on mount and on an
 * explicit refresh only: no polling (StudioNet allows about 500 requests per
 * hour per IP). The genlayer-js read gateway is loaded lazily, as on the live
 * check page.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { REVIEWED_CONTRACT_CODE_SHA256 } from "../config/contract";
import type { ReadOnlyGateway } from "../live/gateway";
import { DEFAULT_READ_TIMEOUT_MS, loadCase, loadPartyCases, type Address, type CaseLoad, type PartyCasesLoad, type ReadOptions } from "./caseReads";

let sharedGateway: Promise<ReadOnlyGateway> | null = null;

export function defaultLoadGateway(): Promise<ReadOnlyGateway> {
  sharedGateway ??= import("../live/sdkGateway").then((m) => m.createSdkGateway());
  return sharedGateway;
}

export async function browserSha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface ReadDeps {
  loadGateway?: () => Promise<ReadOnlyGateway>;
  sha256Hex?: (text: string) => Promise<string>;
  timeoutMs?: number;
  networkRetryDelayMs?: number;
}

function options(d: ReadDeps): ReadOptions {
  return {
    timeoutMs: d.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS,
    ...(d.networkRetryDelayMs === undefined ? {} : { networkRetryDelayMs: d.networkRetryDelayMs }),
    sha256Hex: d.sha256Hex ?? browserSha256Hex,
    expectedCodeSha256: REVIEWED_CONTRACT_CODE_SHA256,
  };
}

export type Loadable<T> = { kind: "idle" } | { kind: "loading" } | { kind: "done"; value: T } | { kind: "error"; message: string };

function useLoader<T>(run: (() => Promise<T>) | null): { state: Loadable<T>; refresh: () => void } {
  const [tick, setTick] = useState(0);
  // One token per (loader, refresh): results of an older token are ignored.
  const token = useMemo(() => ({ run, tick }), [run, tick]);
  const [result, setResult] = useState<{ token: object; value: Loadable<T> } | null>(null);
  useEffect(() => {
    if (token.run === null) return;
    let live = true;
    token.run().then(
      (value) => live && setResult({ token, value: { kind: "done", value } }),
      (err: unknown) => live && setResult({ token, value: { kind: "error", message: err instanceof Error ? err.message : String(err) } }),
    );
    return () => {
      live = false;
    };
  }, [token]);
  const state: Loadable<T> = run === null ? { kind: "idle" } : result?.token === token ? result.value : { kind: "loading" };
  return { state, refresh: useCallback(() => setTick((n) => n + 1), []) };
}

export function useCaseLoad(contract: Address | null, caseId: string, deps: ReadDeps) {
  const { loadGateway = defaultLoadGateway } = deps;
  const opts = options(deps);
  const key = `${contract}|${caseId}|${opts.timeoutMs}`;
  const run = useMemo(
    () => (contract === null ? null : async (): Promise<CaseLoad> => loadCase(await loadGateway(), contract, caseId, opts)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, loadGateway],
  );
  return useLoader(run);
}

export function usePartyCases(contract: Address | null, party: string | null, offset: number, deps: ReadDeps) {
  const { loadGateway = defaultLoadGateway } = deps;
  const opts = options(deps);
  const key = `${contract}|${party}|${offset}|${opts.timeoutMs}`;
  const run = useMemo(
    () => (contract === null || party === null ? null : async (): Promise<PartyCasesLoad> => loadPartyCases(await loadGateway(), contract, party, offset, opts)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, loadGateway],
  );
  return useLoader(run);
}
