/**
 * The browser-wallet write flows (Phase 3.5C, generalised to every contract
 * write in Phase 4.1). Reachable only from the gated experiment UI
 * (config/writeGate.ts). No other path to eth_sendTransaction or signing
 * exists: the only wallet request this module can cause goes through
 * createGuardedProvider, inside a DurableWriteSession run, at most once per
 * operation.
 *
 * Flow, for every method:
 *   writeBlockers (gate, explicit connection, chain 61999, sender, input,
 *   acknowledgement)
 *   → session.beginWithPreflight: UNDER the cross-tab lock, fresh read-only
 *     checks (wallet chain + account, RPC chain, gas price 0, contract code
 *     hash, nonce latest = pending), then the method's own checks from fresh
 *     contract reads (role, state, quotas, attempts; for case-level writes the
 *     case must have no non-final changes), a gen_call simulation where it is
 *     safe (not for request_assessment, whose simulation would run the model),
 *     the baseline for the effect check, then the write-ahead record
 *   → session.run: the SDK's writeContract through the guarded provider,
 *     bounded, watched for wallet changes
 *   → monitorToFinality: bounded read-only polling, then a latest-final read
 *     that must show the method's intended effect before anything is called
 *     success.
 * Nothing here retries a write. Timeouts become uncertain, never failed.
 */
import { DEADLINE_MARGIN_SECONDS } from "../cases/actions";
import { STUDIONET } from "../config/network";
import type { WriteGate } from "../config/writeGate";
import { withTimeout } from "../live/errors";
import { classifyTransaction } from "../tx/classify";
import { InvalidTransition, SETTLED_PHASES, UNCERTAIN_PHASES, type TxPhase } from "../tx/state";
import type { Eip1193Provider } from "../wallet/eip1193";
import type { WalletState } from "../wallet/walletState";
import type { Hex } from "../write/bytes";
import {
  submitEvidenceArgs,
  submitReplyArgs,
  validateCaseIdOnly,
  validateSubmitEvidence,
  validateSubmitReply,
  type SubmitEvidenceInput,
  type SubmitReplyInput,
} from "../write/caseActions";
import { createCaseArgs, validateCreateCase, type CreateCaseInput } from "../write/createCase";
import type { DurableWriteSession } from "../write/durableSession";
import { effectNoun, matchEffect } from "../write/effects";
import { createGuardedProvider } from "../write/guardedProvider";
import { buildWriteIntent, studionetWriteParams, type CalldataArg } from "../write/intent";
import type { ContractWriteMethod } from "../write/methods";
import type { ExpectedEffect, PendingRecord } from "../write/pendingStore";
import type { ReconciliationResult } from "../write/reconcile";
import type { ReconciliationReader } from "../write/reconcileReader";
import type { WriteOutcome } from "../write/runner";

export interface ExperimentReader extends ReconciliationReader {
  chainId(): Promise<unknown>;
  gasPrice(): Promise<unknown>;
  getContractCode(address: Hex): Promise<unknown>;
  /** gen_call write SIMULATION of create_case: creates no transaction. */
  simulateCreateCase(sender: Hex, contract: Hex, args: readonly unknown[]): Promise<unknown>;
  /** gen_call write SIMULATION of another method: creates no transaction. */
  simulateWrite(sender: Hex, contract: Hex, method: ContractWriteMethod, args: readonly unknown[]): Promise<unknown>;
}

export interface WriteClient {
  writeContract(args: { address: Hex; functionName: string; args: unknown[]; value: bigint }): Promise<unknown>;
}

export interface FlowDeps {
  session: DurableWriteSession;
  reader: ExperimentReader;
  /** The raw injected wallet. Only ever wrapped by the guarded provider, and watched for events. */
  wallet: Eip1193Provider;
  /** Must build a client whose account is the address STRING and whose provider is `guarded`. */
  makeWriteClient: (guarded: Eip1193Provider, sender: Hex) => WriteClient;
  expectedCodeSha256: string;
  sha256Hex: (text: string) => Promise<string>;
  randomId: () => string;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  timing: FlowTiming;
}

export interface FlowTiming {
  /** Application deadline for the SDK call (does not cancel the wallet prompt). */
  submitTimeoutMs: number;
  readTimeoutMs: number;
  pollIntervalMs: number;
  finalityDeadlineMs: number;
  /** Consecutive failed status reads before the state becomes read_failure (uncertain). */
  maxConsecutiveReadFailures: number;
}

export const DEFAULT_TIMING: FlowTiming = {
  submitTimeoutMs: 240_000,
  readTimeoutMs: 20_000,
  pollIntervalMs: 10_000,
  finalityDeadlineMs: 30 * 60_000,
  maxConsecutiveReadFailures: 3,
};

type FlowWallet = Pick<WalletState, "phase" | "account" | "chainId" | "explicitConnection">;

export interface FlowPreconditions {
  gate: WriteGate;
  wallet: FlowWallet;
  input: CreateCaseInput;
  acknowledged: boolean;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Conditions shared by every write (pure). Empty = may proceed. */
export function writeBlockers(
  p: { gate: WriteGate; wallet: FlowWallet; inputProblems: readonly string[]; acknowledged: boolean },
  options: { includeAcknowledgement: boolean } = { includeAcknowledgement: true },
): string[] {
  const out: string[] = [];
  if (!p.gate.enabled) out.push(`Writes are off: ${p.gate.reasons.join("; ")}.`);
  if (p.wallet.phase !== "connected" || p.wallet.account === null) out.push("Connect your wallet first.");
  else if (!p.wallet.explicitConnection) out.push("Press Connect on the Wallet page in this tab first: an account shown from an earlier visit is not enough.");
  if (p.wallet.account !== null && !ADDRESS.test(p.wallet.account)) out.push("The wallet's account is not a valid address.");
  if (p.wallet.chainId !== STUDIONET.chainId) out.push(`Your wallet must be on StudioNet (chain ID ${STUDIONET.chainId}).`);
  for (const problem of p.inputProblems) out.push(`Details: ${problem}.`);
  if (options.includeAcknowledgement && !p.acknowledged) out.push("Review the details and tick the acknowledgement.");
  return out;
}

/** create_case preconditions (pure). Empty = may proceed. */
export function flowBlockers(p: FlowPreconditions, options: { includeAcknowledgement: boolean } = { includeAcknowledgement: true }): string[] {
  return writeBlockers(
    { gate: p.gate, wallet: p.wallet, inputProblems: [], acknowledged: p.acknowledged },
    options,
  ).flatMap((b) => (b.startsWith("Review the details") ? [] : [b])).concat(
    validateCreateCase(p.input, p.wallet.account).map((problem) => `Case details: ${problem}.`),
    options.includeAcknowledgement && !p.acknowledged ? ["Review the case and tick the acknowledgement."] : [],
  );
}

export class PreflightFailed extends Error {}

function fail(message: string): never {
  throw new PreflightFailed(message);
}

function quantity(v: unknown): bigint | null {
  return typeof v === "string" && /^0x[0-9a-fA-F]+$/.test(v) ? BigInt(v) : null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

// ---------------------------------------------------------------------------
// Per-method specifications
// ---------------------------------------------------------------------------

/** What the method-specific preflight returns. */
interface MethodCheck {
  effect: ExpectedEffect;
  baselinePartyCaseCount: number | null;
  /** What the simulation returned (case or evidence id), or null. */
  simulated: string | null;
}

export interface WriteSpec {
  method: ContractWriteMethod;
  args: CalldataArg[];
  /** Input problems known without reading the chain (shown before the review). */
  inputProblems: readonly string[];
  /** Read-only, method-specific checks; runs under the lock inside the preflight. */
  check(deps: FlowDeps, sender: Hex, contract: Hex): Promise<MethodCheck>;
}

const t = (deps: FlowDeps) => deps.timing.readTimeoutMs;

/**
 * Fresh case state for a case-level write. The case must read identically at
 * latest-nonfinal and latest-final: a change that is not final yet (for
 * example another party's pending write) could change what this write does.
 */
async function settledCase(deps: FlowDeps, contract: Hex, caseId: string): Promise<Obj> {
  const nonfinal = await withTimeout(deps.reader.readContract(contract, "get_case", [caseId], "latest-nonfinal"), t(deps), "get_case latest-nonfinal");
  const final = await withTimeout(deps.reader.readContract(contract, "get_case", [caseId], "latest-final"), t(deps), "get_case latest-final");
  if (!isObj(nonfinal) || nonfinal.case_id !== caseId || !isObj(final)) fail(`case ${caseId} could not be read`);
  if (JSON.stringify(nonfinal) !== JSON.stringify(final)) fail(`case ${caseId} has changes that are not final yet; wait until they finalize, then review again`);
  return final;
}

function roleOf(c: Obj, sender: Hex): "CLAIMANT" | "RESPONDENT" | null {
  if (String(c.claimant).toLowerCase() === sender.toLowerCase()) return "CLAIMANT";
  if (String(c.respondent).toLowerCase() === sender.toLowerCase()) return "RESPONDENT";
  return null;
}

const awaitingReply = (c: Obj) => c.status === "AWAITING_RESPONSE" && c.response_state === "PENDING";

/**
 * Deadline rules use THIS DEVICE's clock with a margin, never the simulation:
 * StudioNet's gen_call write simulation evaluates the contract's clock behind
 * real time (Phase 4.1 review: a 22 h old deadline "has not passed" in
 * simulation, and evidence is still accepted). Real transactions use the real
 * time, and the contract still enforces the rule; a transaction that
 * disagrees reverts with no state change.
 */
function deadlineOf(c: Obj): number {
  const d = c.reply_deadline;
  if (typeof d !== "number" || !Number.isSafeInteger(d) || d <= 0) fail("the case's reply deadline could not be read");
  return d;
}

function requireBeforeDeadline(deps: FlowDeps, c: Obj) {
  const nowS = Math.floor(deps.now() / 1000);
  if (nowS > deadlineOf(c) - DEADLINE_MARGIN_SECONDS) {
    fail(`the reply deadline has passed or is less than ${DEADLINE_MARGIN_SECONDS / 60} minutes away (by this device's clock), so the contract may refuse it`);
  }
}

function requireAfterDeadline(deps: FlowDeps, c: Obj) {
  const nowS = Math.floor(deps.now() / 1000);
  if (nowS < deadlineOf(c) + DEADLINE_MARGIN_SECONDS) {
    fail(`the reply deadline passed less than ${DEADLINE_MARGIN_SECONDS / 60} minutes ago, or has not passed (by this device's clock); wait and try again`);
  }
}

async function simulateNone(deps: FlowDeps, sender: Hex, contract: Hex, method: ContractWriteMethod, args: readonly unknown[]) {
  const r = await withTimeout(deps.reader.simulateWrite(sender, contract, method, args), t(deps), "simulation");
  // The method returns None; genlayer-js 1.1.8 decodes it as null. A contract error throws ("gen_call failed").
  if (r !== null && r !== undefined) fail(`the contract's simulation of ${method} returned an unexpected value`);
}

export function createCaseSpec(input: CreateCaseInput): WriteSpec {
  const args = createCaseArgs(input);
  return {
    method: "create_case",
    args,
    inputProblems: [],
    async check(deps, sender, contract) {
      const party = (await withTimeout(deps.reader.readContract(contract, "get_party_case_ids", [sender, 0, 1], "latest-nonfinal"), t(deps), "party cases")) as {
        total?: unknown;
      } | null;
      if (!party || typeof party.total !== "number" || !Number.isSafeInteger(party.total) || party.total < 0) fail("the account's case list could not be read");
      const simulated = await withTimeout(deps.reader.simulateCreateCase(sender, contract, args), t(deps), "simulation");
      if (typeof simulated !== "string" || !/^VC-\d{6}$/.test(simulated)) fail("the contract's simulation of create_case did not return a case ID");
      return { effect: { title: input.title, respondent: input.respondent }, baselinePartyCaseCount: party.total, simulated };
    },
  };
}

export function submitEvidenceSpec(input: SubmitEvidenceInput): WriteSpec {
  const args = submitEvidenceArgs(input);
  return {
    method: "submit_evidence",
    args,
    inputProblems: validateSubmitEvidence(input, ["I1", "I2", "I3", "I4", "I5"]).filter((p) => !p.startsWith("unknown issue")),
    async check(deps, sender, contract) {
      const c = await settledCase(deps, contract, input.caseId);
      const role = roleOf(c, sender);
      if (role === null) fail("your account is not a party to this case");
      if (c.status !== "AWAITING_RESPONSE" || c.snapshot_locked !== false) fail("the case no longer accepts evidence (the record is locked)");
      requireBeforeDeadline(deps, c);
      const issues = Array.isArray(c.issues) ? c.issues.map((i) => (isObj(i) ? String(i.issue_id) : "")) : [];
      const problems = validateSubmitEvidence(input, issues);
      if (problems.length > 0) fail(problems.join("; "));
      const own = role === "CLAIMANT" ? c.claimant_evidence_count : c.respondent_evidence_count;
      if (typeof own !== "number" || own >= 10) fail("you have reached the limit of 10 evidence items");
      const count = c.evidence_count;
      if (typeof count !== "number" || count >= 20) fail("the case has reached the limit of 20 evidence items");
      const simulated = await withTimeout(deps.reader.simulateWrite(sender, contract, "submit_evidence", args), t(deps), "simulation");
      if (simulated !== `E${count + 1}`) fail("the contract's simulation of submit_evidence did not return the next evidence ID");
      return {
        effect: {
          kind: "submit_evidence",
          caseId: input.caseId,
          label: input.label,
          description: input.description,
          contentRef: input.contentRef,
          sha256: input.sha256.toLowerCase(),
          baselineEvidenceCount: count,
        },
        baselinePartyCaseCount: null,
        simulated,
      };
    },
  };
}

export function submitReplySpec(input: SubmitReplyInput): WriteSpec {
  const args = submitReplyArgs(input);
  return {
    method: "submit_reply",
    args,
    inputProblems: validateSubmitReply(input),
    async check(deps, sender, contract) {
      const c = await settledCase(deps, contract, input.caseId);
      if (roleOf(c, sender) !== "RESPONDENT") fail("only the respondent can reply");
      if (!awaitingReply(c)) fail("the case is not awaiting a reply");
      requireBeforeDeadline(deps, c);
      await simulateNone(deps, sender, contract, "submit_reply", args);
      return { effect: { kind: "submit_reply", caseId: input.caseId, reply: input.reply }, baselinePartyCaseCount: null, simulated: null };
    },
  };
}

/**
 * No simulation: StudioNet's simulation clock lags real time, so it reports
 * the deadline as not passed (see requireAfterDeadline). Every other
 * precondition is read-checked from fresh state.
 */
export function processDeadlineSpec(caseId: string): WriteSpec {
  const args = [caseId];
  return {
    method: "process_reply_deadline",
    args,
    inputProblems: validateCaseIdOnly(caseId),
    async check(deps, sender, contract) {
      const c = await settledCase(deps, contract, caseId);
      if (roleOf(c, sender) === null) fail("your account is not a party to this case");
      if (!awaitingReply(c)) fail("the case is not awaiting a reply");
      requireAfterDeadline(deps, c);
      return { effect: { kind: "process_reply_deadline", caseId }, baselinePartyCaseCount: null, simulated: null };
    },
  };
}

/**
 * No simulation: simulating request_assessment would run the model call on
 * StudioNet. The read checks below cover every deterministic precondition
 * the contract enforces before the model runs.
 */
export function requestAssessmentSpec(caseId: string, options: { lastAttemptAcknowledged: boolean }): WriteSpec {
  const args = [caseId];
  return {
    method: "request_assessment",
    args,
    inputProblems: validateCaseIdOnly(caseId),
    async check(deps, sender, contract) {
      const c = await settledCase(deps, contract, caseId);
      if (roleOf(c, sender) === null) fail("your account is not a party to this case");
      const s = await withTimeout(deps.reader.readContract(contract, "get_assessment_status", [caseId], "latest-final"), t(deps), "get_assessment_status");
      if (!isObj(s) || typeof s.attempts !== "number" || typeof s.remaining_attempts !== "number") fail("the assessment status could not be read");
      if (s.can_request !== true || c.status !== "READY_FOR_ASSESSMENT" || c.snapshot_locked !== true) fail("the case is not ready for an assessment");
      if (s.has_assessment === true) fail("the case already has an assessment");
      if (s.attempts !== c.assessment_attempts) fail("the attempt counts disagree; read the case again");
      if (s.remaining_attempts <= 1 && !options.lastAttemptAcknowledged) fail("this is the last allowed attempt; acknowledge that before requesting it");
      return { effect: { kind: "request_assessment", caseId, baselineAttempts: s.attempts }, baselinePartyCaseCount: null, simulated: null };
    },
  };
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

/**
 * Read-only preflight common to every method. Runs under the cross-tab lock
 * (via beginWithPreflight). Two passive wallet reads (eth_chainId,
 * eth_accounts: no prompt); the rest goes to the StudioNet RPC.
 */
async function commonPreflight(deps: FlowDeps, sender: Hex, contract: Hex): Promise<bigint> {
  const walletChain = await withTimeout(deps.wallet.request({ method: "eth_chainId" }), t(deps), "wallet eth_chainId");
  if (typeof walletChain !== "string" || walletChain.toLowerCase() !== STUDIONET.chainIdHex) fail("the wallet is not on StudioNet");
  const accounts = await withTimeout(deps.wallet.request({ method: "eth_accounts" }), t(deps), "wallet eth_accounts");
  const selected = Array.isArray(accounts) ? accounts[0] : undefined;
  if (typeof selected !== "string" || selected.toLowerCase() !== sender.toLowerCase()) fail("the wallet's selected account is not the connected account");
  const rpcChain = await withTimeout(deps.reader.chainId(), t(deps), "eth_chainId");
  if (typeof rpcChain !== "string" || rpcChain.toLowerCase() !== STUDIONET.chainIdHex) fail("the RPC is not StudioNet");
  const gas = await withTimeout(deps.reader.gasPrice(), t(deps), "eth_gasPrice");
  if (quantity(gas) !== 0n) fail("StudioNet's gas price is not 0");
  const code = await withTimeout(deps.reader.getContractCode(contract), t(deps), "gen_getContractCode");
  if (typeof code !== "string" || (await deps.sha256Hex(code)) !== deps.expectedCodeSha256) fail("the contract's code does not match the reviewed contract");
  const latest = quantity(await withTimeout(deps.reader.getTransactionCount(sender, "latest"), t(deps), "nonce latest"));
  const pending = quantity(await withTimeout(deps.reader.getTransactionCount(sender, "pending"), t(deps), "nonce pending"));
  if (latest === null || pending === null) fail("the account nonce could not be read");
  if (latest !== pending) fail("this account has a pending transaction; wait until it settles");
  return pending;
}

export interface SubmitResult {
  outcome: WriteOutcome;
  /** What the simulation returned (case or evidence id), or null. */
  simulatedCaseId: string | null;
}

/** Initiates the single write. Throws WriteRefused or PreflightFailed (nothing sent) when any check fails. */
export async function submitWrite(
  deps: FlowDeps,
  pre: { gate: WriteGate; wallet: FlowWallet; spec: WriteSpec; acknowledged: boolean },
): Promise<SubmitResult> {
  const blockers = writeBlockers({ gate: pre.gate, wallet: pre.wallet, inputProblems: pre.spec.inputProblems, acknowledged: pre.acknowledged });
  if (blockers.length > 0) throw new PreflightFailed(blockers.join(" "));
  if (!pre.gate.enabled) throw new PreflightFailed("writes are off");
  const sender = pre.wallet.account as Hex;
  const contract = pre.gate.contract;
  const spec = pre.spec;
  let simulated: string | null = null;
  const guard = await deps.session.beginWithPreflight(async () => {
    const nonce = await commonPreflight(deps, sender, contract);
    const m = await spec.check(deps, sender, contract);
    simulated = m.simulated;
    const intent = buildWriteIntent({
      operationId: deps.randomId(),
      chain: studionetWriteParams(),
      sender,
      contractAddress: contract,
      method: spec.method,
      args: spec.args,
      expectedNonce: nonce,
    });
    return { intent, ctx: { expectedEffect: m.effect, baselinePartyCaseCount: m.baselinePartyCaseCount, nonceBefore: nonce } };
  });
  const client = deps.makeWriteClient(createGuardedProvider(deps.wallet, guard), sender);
  const outcome = await deps.session.run(
    () => client.writeContract({ address: contract, functionName: spec.method, args: spec.args as unknown[], value: 0n }),
    { timeoutMs: deps.timing.submitTimeoutMs, broadcastGuarded: false, wallet: deps.wallet },
  );
  return { outcome, simulatedCaseId: simulated };
}

/** create_case (Phase 3.5C entry point). */
export async function submitCreateCase(deps: FlowDeps, pre: FlowPreconditions): Promise<SubmitResult> {
  const blockers = flowBlockers(pre);
  if (blockers.length > 0) throw new PreflightFailed(blockers.join(" "));
  return submitWrite(deps, { gate: pre.gate, wallet: pre.wallet, spec: createCaseSpec(pre.input), acknowledged: pre.acknowledged });
}

// ---------------------------------------------------------------------------
// Monitoring (read-only)
// ---------------------------------------------------------------------------

const MONITORABLE: readonly TxPhase[] = ["submitted", "pending", "accepted", "execution_failed", "validator_disagreement", "undetermined", "finalized"];

export function canMonitor(record: PendingRecord | null): boolean {
  return record !== null && record.tx.txHash !== null && MONITORABLE.includes(record.tx.phase);
}

export type MonitorResult =
  | { kind: "verified"; caseId: string }
  | { kind: "verification_mismatch"; detail: string }
  | { kind: "verification_unavailable"; detail: string }
  | { kind: "finalized_unsuccessful" }
  | { kind: "timed_out" }
  | { kind: "read_failure" }
  | { kind: "not_monitorable"; phase: TxPhase | null };

/**
 * Polls the recorded transaction until it is final, the deadline passes, or
 * reads keep failing, then (on success) confirms the method's effect with a
 * latest-final read. Reads only. Safe to call again after a reload ("resume").
 */
export async function monitorToFinality(deps: FlowDeps, onPhase: (phase: TxPhase) => void = () => undefined): Promise<MonitorResult> {
  const s = deps.session;
  const start = s.current;
  if (start === null || !canMonitor(start)) return { kind: "not_monitorable", phase: start?.tx.phase ?? null };
  const hash = start.tx.txHash as Hex;
  const deadline = deps.now() + deps.timing.finalityDeadlineMs;
  let failures = 0;
  while (s.current?.tx.phase !== "finalized") {
    const phase = s.current?.tx.phase;
    if (phase === undefined || SETTLED_PHASES.includes(phase) || UNCERTAIN_PHASES.includes(phase)) break;
    if (deps.now() >= deadline) {
      s.apply({ type: "POLL_TIMED_OUT" });
      onPhase("timed_out_unknown");
      return { kind: "timed_out" };
    }
    let tx: unknown;
    try {
      tx = await withTimeout(deps.reader.getTransaction(hash), deps.timing.readTimeoutMs, "getTransaction");
      failures = 0;
    } catch {
      failures += 1;
      if (failures >= deps.timing.maxConsecutiveReadFailures) {
        s.apply({ type: "READ_FAILED" });
        onPhase("read_failure");
        return { kind: "read_failure" };
      }
      await deps.sleep(deps.timing.pollIntervalMs);
      continue;
    }
    if (tx === null || tx === undefined) {
      if (s.current?.tx.phase === "submitted") s.apply({ type: "NOT_FOUND_YET" });
    } else {
      const view = classifyTransaction(tx);
      try {
        s.apply({ type: "OBSERVED", category: view.category, final: view.final });
      } catch (err) {
        if (!(err instanceof InvalidTransition)) throw err;
        // A status that contradicts an earlier one (e.g. accepted, then disputed): unknown, so uncertain.
        s.apply({ type: "READ_FAILED" });
        onPhase("read_failure");
        return { kind: "read_failure" };
      }
      onPhase(s.current?.tx.phase ?? "submitted");
      if (view.final) break;
    }
    await deps.sleep(deps.timing.pollIntervalMs);
  }
  const phase = s.current?.tx.phase;
  if (phase === "read_failure") return { kind: "read_failure" };
  if (phase === "finalized_unsuccessful") return { kind: "finalized_unsuccessful" };
  if (phase !== "finalized") return { kind: "not_monitorable", phase: phase ?? null };

  // Success needs a latest-final read showing the intended effect.
  const finalRecord = s.current;
  if (finalRecord === null) return { kind: "not_monitorable", phase: null };
  let match;
  try {
    match = await matchEffect(deps.reader, finalRecord, "latest-final", deps.timing.readTimeoutMs);
  } catch (err) {
    // Stays "finalized" (blocking); the verification read can be resumed later.
    return { kind: "verification_unavailable", detail: (err as Error).message };
  }
  if (match.kind === "ambiguous") return { kind: "verification_unavailable", detail: match.detail };
  if (match.kind === "none") {
    const what = finalRecord.method === "create_case" ? "no matching case" : "no matching change";
    s.apply({ type: "VERIFICATION_MISMATCH", message: `The transaction finalized, but a latest-final read shows ${what} (${match.detail}).` });
    onPhase("verification_mismatch");
    return { kind: "verification_mismatch", detail: `${what} at latest-final` };
  }
  const shows = finalRecord.method === "create_case" ? match.caseId : match.detail;
  s.apply({ type: "VERIFIED", detail: `Transaction ${hash} finalized and a latest-final read shows ${shows}.` });
  onPhase("verified");
  return { kind: "verified", caseId: match.caseId };
}

/** Read-only reconciliation of an uncertain record. Never resends. */
export function reconcileUncertain(deps: FlowDeps): Promise<ReconciliationResult> {
  return deps.session.reconcile(deps.reader, { timeoutMs: deps.timing.readTimeoutMs });
}

// ---------------------------------------------------------------------------
// What to tell the user (accurate about the evidence)
// ---------------------------------------------------------------------------

export interface StatusMessage {
  tone: "ok" | "info" | "warn";
  headline: string;
  body: string;
  /** Recovery steps, shown when the write is unresolved. */
  recovery: string[];
}

const RECOVERY = [
  "Do not try the write again: it may already have been sent.",
  "Open your wallet's activity list and look for a transaction from this account at that time.",
  "Use “Run read-only check” below. It looks up the recorded transaction and the contract's state; it never sends anything.",
  "The block lifts only when that check finds positive evidence (the transaction, the intended change in final contract state, or proof nothing was sent).",
  "If it can never be resolved, see the manual recovery steps in docs/PHASE_3_5B_BROWSER_WALLET_PREPARATION_REPORT.md §7.3.",
];

const VERIFIED_HEADLINE: Record<ContractWriteMethod, string> = {
  create_case: "Case created and confirmed",
  submit_evidence: "Evidence recorded and confirmed",
  submit_reply: "Reply recorded and confirmed",
  process_reply_deadline: "Missed deadline recorded and confirmed",
  request_assessment: "Assessment request processed and confirmed",
};

const CONFIRMED_BY_STATE_HEADLINE: Record<ContractWriteMethod, string> = {
  create_case: "Case confirmed by contract state (limited evidence)",
  submit_evidence: "Evidence confirmed by contract state (limited evidence)",
  submit_reply: "Reply confirmed by contract state (limited evidence)",
  process_reply_deadline: "Missed deadline confirmed by contract state (limited evidence)",
  request_assessment: "Assessment attempt confirmed by contract state (limited evidence)",
};

export function statusMessage(record: PendingRecord | null): StatusMessage | null {
  if (record === null) return null;
  const { phase, txHash, note } = record.tx;
  const tx = txHash ? `Transaction ${txHash}. ` : "";
  const assessment = record.method === "request_assessment";
  switch (phase) {
    case "verified":
      return {
        tone: "ok",
        headline: VERIFIED_HEADLINE[record.method],
        body:
          (note ?? `${tx}Finalized and confirmed by a latest-final contract read.`) +
          (assessment ? " Open the case to see whether an assessment was stored or the attempt produced no valid result." : ""),
        recovery: [],
      };
    case "confirmed_by_state":
      return {
        tone: "ok",
        headline: CONFIRMED_BY_STATE_HEADLINE[record.method],
        body: `${note ?? ""} The intended change exists in final contract state, but the transaction itself was never identified, so its ID and consensus details are unknown. Do not repeat the write.`,
        recovery: [],
      };
    case "rejected":
      return { tone: "info", headline: "You rejected the request", body: "Nothing was sent.", recovery: [] };
    case "not_sent":
      return { tone: "info", headline: "Nothing was sent", body: note ?? "", recovery: [] };
    case "finalized_unsuccessful":
      return {
        tone: "warn",
        headline: `The transaction finalized without ${effectNoun(record.method)}`,
        body:
          `${tx}It failed, was disputed by validators, or was undetermined.` +
          (assessment ? " A failed or undetermined assessment transaction changes nothing and does not use an attempt." : ""),
        recovery: [],
      };
    case "verification_mismatch":
      return {
        tone: "warn",
        headline: record.method === "create_case" ? "Finalized, but the case was not found" : "Finalized, but the intended change was not found",
        body: `${tx}${note ?? ""} Investigate before writing again.`,
        recovery: [],
      };
    case "submission_uncertain":
    case "timed_out_unknown":
    case "read_failure":
      return {
        tone: "warn",
        headline: phase === "submission_uncertain" ? "The write may have been sent" : "The outcome is not known yet",
        body: `${tx}${note ?? ""} A timeout or lost connection is not proof that the write failed. Writes are blocked until a read-only check resolves it.`,
        recovery: RECOVERY,
      };
    case "finalized":
      return {
        tone: "info",
        headline: record.method === "create_case" ? "Finalized; confirming the case" : "Finalized; confirming the change",
        body: `${tx}A latest-final contract read is still needed before this counts as success.`,
        recovery: [],
      };
    default:
      return {
        tone: "info",
        headline: "Write in progress",
        body: `${tx}Status: ${phase}. Accepted is not final; wait for finality.${assessment ? " An assessment runs an AI model under consensus and can take several minutes." : ""}`,
        recovery: [],
      };
  }
}
