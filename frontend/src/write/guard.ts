/**
 * Single-use write guard. One WriteGuard exists per user-approved operation
 * and permits at most ONE outbound transaction request:
 * - wallet channel: one `eth_sendTransaction` forwarded to the wallet;
 * - signer channel: one `signTransaction` by the in-memory test account.
 *
 * The permit is claimed synchronously before any check or await, so concurrent
 * or repeated calls (double clicks, the SDK's V6 fallback, a late SDK call
 * after a timeout) are refused without ever reaching the wallet or the key.
 * Any refusal, and any timeout, disarms the guard for good.
 *
 * The journal records method names, decisions, reasons, selectors, byte
 * lengths, public transaction hashes and error codes. It never stores account
 * objects, keys, signatures' secrets or free text from the request.
 */
import { decodeAddTransactionV5 } from "./addTransaction";
import { isHex, type Hex } from "./bytes";
import type { WriteIntent } from "./intent";

export type Channel = "wallet" | "signer" | "rpc";

export type OutboundState =
  /** Forwarded to the wallet, or handed to the signer; no result yet. */
  | "in_flight"
  /** The wallet returned a well-formed 32-byte hash. */
  | "hash"
  /** The test account signed; the signed bytes are recorded (public once broadcast). */
  | "signed"
  /** The wallet returned EIP-1193 error 4001 (user rejected). Nothing was sent. */
  | "rejected"
  /**
   * Any other error. Wallet channel: sending is NOT ruled out. Signer channel:
   * signing failed, so no signed bytes exist to send.
   */
  | "error"
  /** The wallet returned something that is not a valid result. Sending is NOT ruled out. */
  | "malformed"
  /** Signer channel: the signed bytes did not match the approved request and were never released to the SDK. */
  | "withheld";

export interface BroadcastRecord {
  state: "in_flight" | "hash" | "rpc_error" | "transport_error" | "malformed";
  hash: Hex | null;
  errorCode: number | string | null;
  at: number;
  settledAt: number | null;
}

export interface OutboundRecord {
  channel: "wallet" | "signer";
  method: string;
  authorizedAt: number;
  state: OutboundState;
  /** Wallet-returned hash, or the hash of the signed bytes when a hasher was supplied. */
  hash: Hex | null;
  signedTransaction: Hex | null;
  errorCode: number | string | null;
  settledAt: number | null;
  /** True when the result arrived after the operation was closed (deadline, refusal or finish): a late response. */
  settledAfterDisarm: boolean;
  broadcast: BroadcastRecord | null;
}

export interface JournalEntry {
  seq: number;
  at: number;
  channel: Channel;
  method: string;
  event: "refused" | "forwarded" | "settled" | "disarmed" | "broadcast" | "broadcast_settled" | "passive";
  detail: string;
}

export interface GuardSnapshot {
  operationId: string;
  armed: boolean;
  disarmReason: string | null;
  /** Number of transaction requests that left the guard: 0 or 1, never more. */
  requestsForwarded: number;
  refusals: number;
  outbound: OutboundRecord | null;
  journal: JournalEntry[];
}

export const GUARD_REFUSED_CODE = "VERICOURT_GUARD_REFUSED";

/**
 * Thrown to the SDK when a request is refused. Its message never contains the
 * strings genlayer-js uses to decide on its V6 fallback
 * (isAddTransactionAbiMismatchError, dist/index.js 1047-1070), so a refusal
 * does not by itself provoke a fallback attempt. If one happens anyway, the
 * guard refuses it too.
 */
export class GuardRefusal extends Error {
  readonly code = GUARD_REFUSED_CODE;
  constructor(readonly method: string, readonly reason: string) {
    super(`VeriCourt write guard refused ${method}: ${reason}`);
    this.name = "GuardRefusal";
  }
}

export function errorCode(err: unknown): number | string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "number" || typeof code === "string" ? code : null;
}

/** Thrown by noteForwarded when the observer could not persist the forward: the request must not be sent. */
export class GuardPersistenceFailure extends Error {
  constructor() {
    super("VeriCourt write guard: the pending-write record could not be saved, so the request was not sent");
    this.name = "GuardPersistenceFailure";
  }
}

/**
 * Receives a snapshot after every change. For the forward step it is a
 * write-ahead hook: if it throws, the forward is undone and the caller must
 * not send. For every other change a throw is counted, never propagated.
 */
export type GuardObserver = (snapshot: GuardSnapshot) => void;

export class WriteGuard {
  private armed = true;
  private observer: GuardObserver | null = null;
  private observerFailures = 0;
  private reasonDisarmed: string | null = null;
  private refusalCount = 0;
  private record: OutboundRecord | null = null;
  private readonly entries: JournalEntry[] = [];

  constructor(
    readonly intent: WriteIntent,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Installs the persistence observer (one per guard). */
  observe(observer: GuardObserver): void {
    if (this.observer !== null) throw new Error("a guard has one observer");
    this.observer = observer;
  }

  /** Number of non-forward changes the observer failed to persist. */
  get persistFailures(): number {
    return this.observerFailures;
  }

  private changed(): void {
    if (this.observer === null) return;
    try {
      this.observer(this.snapshot());
    } catch {
      this.observerFailures += 1;
    }
  }

  get isArmed(): boolean {
    return this.armed;
  }

  get outbound(): Readonly<OutboundRecord> | null {
    return this.record;
  }

  private log(channel: Channel, method: string, event: JournalEntry["event"], detail: string) {
    this.entries.push({ seq: this.entries.length + 1, at: this.now(), channel, method, event, detail });
  }

  /**
   * Synchronously takes the single permit. Returns a refusal if the permit is
   * gone (already used, refused or disarmed). Call before any await.
   */
  claim(channel: Channel, method: string, detail?: string): GuardRefusal | null {
    if (this.armed) {
      this.armed = false;
      return null;
    }
    const reason = this.reasonDisarmed !== null
      ? `the operation is closed (${this.reasonDisarmed})`
      : "this operation already made its one transaction request";
    return this.refuse(channel, method, detail ? `${reason}; ${detail}` : reason);
  }

  /** Records a refusal and closes the operation. Returns the error to throw. */
  refuse(channel: Channel, method: string, reason: string): GuardRefusal {
    this.refusalCount += 1;
    this.armed = false;
    this.reasonDisarmed ??= `refused ${method}`;
    this.log(channel, method, "refused", reason);
    this.changed();
    return new GuardRefusal(method, reason);
  }

  /** Closes the operation: no later request can pass. Idempotent. */
  disarm(reason: string): void {
    if (this.reasonDisarmed === null) {
      this.reasonDisarmed = reason;
      this.log("rpc", "-", "disarmed", reason);
    }
    this.armed = false;
    this.changed();
  }

  /** True when the operation was closed by disarm/refusal (not just by using its permit). */
  get closed(): boolean {
    return this.reasonDisarmed !== null;
  }

  noteForwarded(channel: "wallet" | "signer", method: string, detail: string): void {
    this.record = {
      channel,
      method,
      authorizedAt: this.now(),
      state: "in_flight",
      hash: null,
      signedTransaction: null,
      errorCode: null,
      settledAt: null,
      settledAfterDisarm: false,
      broadcast: null,
    };
    this.log(channel, method, "forwarded", detail);
    if (this.observer !== null) {
      try {
        this.observer(this.snapshot());
      } catch {
        // Write-ahead failed: undo, so the journal never claims a request that was not sent.
        this.record = null;
        this.entries.pop();
        throw new GuardPersistenceFailure();
      }
    }
  }

  noteSettled(update: Pick<OutboundRecord, "state"> & Partial<Pick<OutboundRecord, "hash" | "signedTransaction" | "errorCode">>): void {
    const r = this.record;
    if (r === null || r.state !== "in_flight") throw new Error("no in-flight request to settle");
    r.state = update.state;
    r.hash = update.hash ?? null;
    r.signedTransaction = update.signedTransaction ?? null;
    r.errorCode = update.errorCode ?? null;
    r.settledAt = this.now();
    r.settledAfterDisarm = this.closed;
    const parts = [`state=${r.state}`];
    if (r.hash) parts.push(`hash=${r.hash}`);
    if (r.errorCode !== null) parts.push(`code=${String(r.errorCode)}`);
    if (r.settledAfterDisarm) parts.push("late (after disarm)");
    this.log(r.channel, r.method, "settled", parts.join(" "));
    this.changed();
  }

  /** Signer channel only: the SDK is about to broadcast the signed bytes. */
  claimBroadcast(serialized: unknown): GuardRefusal | null {
    const r = this.record;
    const method = "eth_sendRawTransaction";
    if (r === null || r.channel !== "signer" || r.state !== "signed" || r.signedTransaction === null) {
      return this.refuse("rpc", method, "no transaction signed under this operation");
    }
    if (r.broadcast !== null) return this.refuse("rpc", method, "the signed transaction was already broadcast once");
    if (typeof serialized !== "string" || serialized.toLowerCase() !== r.signedTransaction.toLowerCase()) {
      return this.refuse("rpc", method, "the bytes differ from the transaction this operation signed");
    }
    if (this.closed) return this.refuse("rpc", method, `the operation is closed (${this.reasonDisarmed ?? ""})`);
    r.broadcast = { state: "in_flight", hash: null, errorCode: null, at: this.now(), settledAt: null };
    this.log("rpc", method, "broadcast", `bytes=${(serialized.length - 2) / 2}`);
    this.changed();
    return null;
  }

  noteBroadcastSettled(update: Pick<BroadcastRecord, "state"> & Partial<Pick<BroadcastRecord, "hash" | "errorCode">>): void {
    const b = this.record?.broadcast;
    if (!b || b.state !== "in_flight") throw new Error("no in-flight broadcast to settle");
    b.state = update.state;
    b.hash = update.hash ?? null;
    b.errorCode = update.errorCode ?? null;
    b.settledAt = this.now();
    const parts = [`state=${b.state}`];
    if (b.hash) parts.push(`hash=${b.hash}`);
    if (b.errorCode !== null) parts.push(`code=${String(b.errorCode)}`);
    this.log("rpc", "eth_sendRawTransaction", "broadcast_settled", parts.join(" "));
    this.changed();
  }

  notePassive(channel: Channel, method: string): void {
    this.log(channel, method, "passive", "read-only call forwarded");
  }

  snapshot(): GuardSnapshot {
    const r = this.record;
    return {
      operationId: this.intent.operationId,
      armed: this.armed,
      disarmReason: this.reasonDisarmed,
      requestsForwarded: r === null ? 0 : 1,
      refusals: this.refusalCount,
      outbound: r === null ? null : { ...r, broadcast: r.broadcast === null ? null : { ...r.broadcast } },
      journal: this.entries.map((e) => ({ ...e })),
    };
  }
}

// ---------------------------------------------------------------------------
// Request checks (pure). Each returns null when the request matches the
// intent, or the first mismatch as a reason.
// ---------------------------------------------------------------------------

const HASH32 = /^0x[0-9a-fA-F]{64}$/;

/** First 4 bytes of a request's calldata, for the journal only (public, never a secret). */
export function selectorOf(data: unknown): string {
  return typeof data === "string" && /^0x[0-9a-fA-F]{8}/.test(data) ? data.slice(0, 10).toLowerCase() : "none";
}

export function isTxHash(value: unknown): value is Hex {
  return typeof value === "string" && HASH32.test(value);
}

function sameAddr(a: unknown, b: string): boolean {
  return typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) && a.toLowerCase() === b.toLowerCase();
}

/** Checks the decoded calldata in a fixed order so the reason names the first difference. */
export function checkCalldata(intent: WriteIntent, data: unknown): string | null {
  if (!isHex(data)) return "calldata is not hex";
  if (!data.toLowerCase().startsWith(intent.selector)) {
    return `unexpected selector ${data.slice(0, 10)} (expected ${intent.selector}, the V5 addTransaction)`;
  }
  const decoded = decodeAddTransactionV5(data);
  if (decoded === null) return "calldata is not a canonical V5 addTransaction call";
  if (!sameAddr(decoded.sender, intent.sender)) return "encoded _sender is not the approved account";
  if (!sameAddr(decoded.recipient, intent.contractAddress)) return "encoded _recipient is not the approved contract";
  if (decoded.txData.toLowerCase() !== intent.txData.toLowerCase()) return `encoded call is not the approved ${intent.method} call`;
  if (data.toLowerCase() !== intent.calldata) return "calldata differs from the approved request";
  return null;
}

function quantity(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value)) return BigInt(value);
  return null;
}

/** Wallet channel: params of `eth_sendTransaction` as built by genlayer-js (dist/index.js 1160-1171). */
export function checkSendTransactionParams(intent: WriteIntent, params: unknown): string | null {
  if (!Array.isArray(params) || params.length !== 1 || typeof params[0] !== "object" || params[0] === null) {
    return "params must be one transaction object";
  }
  const tx = params[0] as Record<string, unknown>;
  if (!sameAddr(tx.from, intent.sender)) return "`from` is not the approved account";
  if (!sameAddr(tx.to, intent.consensusAddress)) return "`to` is not the expected consensus contract";
  const dataReason = checkCalldata(intent, tx.data);
  if (dataReason !== null) return dataReason;
  if (tx.value !== undefined && quantity(tx.value) !== 0n) return "`value` must be zero";
  if (tx.chainId !== undefined && quantity(tx.chainId) !== BigInt(intent.chainId)) return "`chainId` parameter is not the expected chain";
  if (tx.gasPrice !== undefined && quantity(tx.gasPrice) !== 0n) return "`gasPrice` is not zero (StudioNet is expected to be gasless)";
  if (intent.expectedNonce !== null && quantity(tx.nonce) !== intent.expectedNonce) return "`nonce` is not the pre-checked nonce";
  return null;
}

/** Signer channel: the viem-style request genlayer-js passes to `signTransaction` (dist/index.js 1123-1134). */
export function checkSignRequest(intent: WriteIntent, request: unknown): string | null {
  if (typeof request !== "object" || request === null) return "sign request is not an object";
  const tx = request as Record<string, unknown>;
  if (tx.type !== "legacy") return "only a legacy transaction may be signed";
  if (quantity(tx.chainId) !== BigInt(intent.chainId)) return "`chainId` is not the expected chain";
  if (!sameAddr(tx.to, intent.consensusAddress)) return "`to` is not the expected consensus contract";
  const dataReason = checkCalldata(intent, tx.data);
  if (dataReason !== null) return dataReason;
  if (tx.value !== undefined && quantity(tx.value) !== 0n) return "`value` must be zero";
  if (quantity(tx.gasPrice) !== 0n) return "`gasPrice` is not zero (StudioNet is expected to be gasless)";
  const gas = quantity(tx.gas);
  if (gas === null || gas <= 0n || gas > MAX_GAS) return "`gas` is missing or out of range";
  const nonce = quantity(tx.nonce);
  if (nonce === null) return "`nonce` is missing";
  if (intent.expectedNonce !== null && nonce !== intent.expectedNonce) return "`nonce` is not the pre-checked nonce";
  return null;
}

/** Upper bound on the gas field the signer will accept (the SDK's fallback estimate is 200000). */
export const MAX_GAS = 30_000_000n;
