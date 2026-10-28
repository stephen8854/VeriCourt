/**
 * Runs one guarded SDK write under an application deadline and turns the
 * guard's journal into an outcome. Never retries.
 *
 * The deadline does NOT cancel anything the SDK already started (genlayer-js
 * 1.1.8 has no cancellation and no transport timeout). On the deadline the
 * guard is disarmed, so no request that has not yet left the guard ever can;
 * a request that already left is reported as uncertain, and its late result
 * is still written to the journal for reconciliation.
 *
 * The outcome is derived from the guard's journal, not from the SDK's return
 * value alone; when both exist they must agree.
 */
import { isTxHash, type GuardSnapshot, type WriteGuard } from "./guard";
import type { Hex } from "./bytes";

export type UncertainReason =
  | "timeout_while_wallet_open"
  | "wallet_error_after_forward"
  | "malformed_wallet_response"
  | "sdk_result_mismatch"
  | "sdk_returned_without_guarded_request"
  | "released_without_broadcast_guard"
  | "timeout_during_broadcast"
  | "broadcast_rpc_error"
  | "broadcast_transport_error"
  | "malformed_broadcast_response"
  | "broadcast_hash_mismatch";

export type WriteOutcome =
  /** Provably nothing left the guarded channels, and the guard is closed. */
  | { kind: "not_sent"; reason: string }
  /** The wallet returned 4001. Nothing was sent. */
  | { kind: "rejected" }
  /** A transaction hash came back from the wallet or the RPC. Not success: execution and finality are separate. */
  | { kind: "submitted"; txHash: Hex; sdkResult: unknown; note: string | null }
  /** Something may have been sent. Blocks all writes until reconciliation. */
  | { kind: "uncertain"; reason: UncertainReason; knownHash: Hex | null };

export type SdkSettlement =
  | { status: "resolved"; value: unknown }
  | { status: "rejected"; error: unknown }
  | { status: "timed_out" };

export interface DeriveOptions {
  /** Signer channel only: true when the guarded fetch was installed, so broadcasts are tracked. */
  broadcastGuarded: boolean;
}

function short(err: unknown): string {
  const name = (err as { name?: unknown } | null)?.name;
  const code = (err as { code?: unknown } | null)?.code;
  return [typeof name === "string" ? name : "Error", code !== undefined ? `code ${String(code)}` : ""].filter(Boolean).join(", ");
}

export function deriveOutcome(snap: GuardSnapshot, sdk: SdkSettlement, options: DeriveOptions): WriteOutcome {
  const o = snap.outbound;
  if (o === null) {
    if (sdk.status === "resolved") return { kind: "uncertain", reason: "sdk_returned_without_guarded_request", knownHash: isTxHash(sdk.value) ? sdk.value : null };
    return {
      kind: "not_sent",
      reason: sdk.status === "timed_out"
        ? "the deadline passed before any transaction request; the guard is closed"
        : `the SDK failed before any transaction request (${short(sdk.error)})`,
    };
  }

  if (o.channel === "wallet") {
    switch (o.state) {
      case "rejected":
        return { kind: "rejected" };
      case "hash": {
        const hash = o.hash as Hex;
        if (sdk.status === "resolved") {
          return typeof sdk.value === "string" && sdk.value.toLowerCase() === hash.toLowerCase()
            ? { kind: "submitted", txHash: hash, sdkResult: sdk.value, note: null }
            : { kind: "uncertain", reason: "sdk_result_mismatch", knownHash: hash };
        }
        return { kind: "submitted", txHash: hash, sdkResult: null, note: "the wallet returned a hash but the SDK call did not return normally" };
      }
      case "in_flight":
        return { kind: "uncertain", reason: "timeout_while_wallet_open", knownHash: null };
      case "malformed":
        return { kind: "uncertain", reason: "malformed_wallet_response", knownHash: null };
      default:
        return { kind: "uncertain", reason: "wallet_error_after_forward", knownHash: null };
    }
  }

  // Signer channel.
  const bypass: WriteOutcome = { kind: "uncertain", reason: "sdk_returned_without_guarded_request", knownHash: o.hash };
  if (o.state !== "signed") {
    if (sdk.status === "resolved") return bypass;
    // in_flight: the guard is closed, so the bytes will be withheld when signing ends.
    return { kind: "not_sent", reason: `no signed transaction was released (signer state: ${o.state})` };
  }
  const b = o.broadcast;
  if (b === null) {
    if (sdk.status === "resolved") return bypass;
    return options.broadcastGuarded
      ? { kind: "not_sent", reason: "the signed transaction was never broadcast, and the guarded fetch is closed" }
      : { kind: "uncertain", reason: "released_without_broadcast_guard", knownHash: o.hash };
  }
  switch (b.state) {
    case "hash": {
      const hash = b.hash as Hex;
      if (o.hash !== null && o.hash.toLowerCase() !== hash.toLowerCase()) {
        return { kind: "uncertain", reason: "broadcast_hash_mismatch", knownHash: o.hash };
      }
      const sdkResult = sdk.status === "resolved" ? sdk.value : null;
      const note = sdk.status === "resolved" ? null
        : sdk.status === "timed_out" ? "the deadline passed after the RPC returned the hash"
        : `the SDK threw after the broadcast (${short(sdk.error)})`;
      return { kind: "submitted", txHash: hash, sdkResult, note };
    }
    case "in_flight":
      return { kind: "uncertain", reason: "timeout_during_broadcast", knownHash: o.hash };
    case "rpc_error":
      return { kind: "uncertain", reason: "broadcast_rpc_error", knownHash: o.hash };
    case "transport_error":
      return { kind: "uncertain", reason: "broadcast_transport_error", knownHash: o.hash };
    default:
      return { kind: "uncertain", reason: "malformed_broadcast_response", knownHash: o.hash };
  }
}

export interface RunOptions extends DeriveOptions {
  timeoutMs: number;
}

/**
 * Starts `submit` once and waits at most `timeoutMs`. The guard is always
 * disarmed before this returns, so nothing the SDK does afterwards can pass.
 */
export async function runGuardedWrite(
  guard: WriteGuard,
  submit: () => Promise<unknown>,
  options: RunOptions,
): Promise<{ outcome: WriteOutcome; snapshot: GuardSnapshot }> {
  if (!guard.isArmed) throw new Error("this guard was already used; create a new operation");
  if (!(options.timeoutMs > 0)) throw new Error("a positive timeout is required");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<SdkSettlement>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timed_out" }), options.timeoutMs);
  });
  const attempt: Promise<SdkSettlement> = Promise.resolve()
    .then(submit)
    .then((value) => ({ status: "resolved", value }) as const, (error: unknown) => ({ status: "rejected", error }) as const);
  const settlement = await Promise.race([attempt, deadline]);
  clearTimeout(timer);
  guard.disarm(settlement.status === "timed_out" ? "application deadline passed" : "operation finished");
  const snapshot = guard.snapshot();
  return { outcome: deriveOutcome(snapshot, settlement, options), snapshot };
}
