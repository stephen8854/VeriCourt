/**
 * Read-only live check against a known StudioNet test deployment.
 *
 * Order (each step stops the check if its precondition fails):
 *   1. eth_chainId must be StudioNet (0xf22f).
 *   2. Deployment confirmation: the deployed code (gen_getContractCode) must
 *      hash to the expected SHA-256 of contracts/vericourt.py. The deploy
 *      transaction's contract address is recorded as further evidence and must
 *      not contradict the configured address.
 *   3. get_contract_info, get_case_count, and existence of the case ID.
 *   4. The six case/assessment reads at latest-nonfinal and latest-final,
 *      each validated and compared with the recorded Phase 2.17C read-back.
 *   5. Transaction lookups for the known transaction hashes.
 *
 * Every call is wrapped in a timeout. Nothing is retried. Sequential, so the
 * whole check is ~25 requests.
 */
import { STUDIONET } from "../config/network";
import type { TestDeployment } from "../config/testDeployments";
import { classifyTransaction, type TxCategory } from "../tx/classify";
import { categoriseError, withTimeout, type CategorisedError } from "./errors";
import type { HashVariant, ReadMethod, ReadOnlyGateway } from "./gateway";
import { diffPaths, validateRead } from "./validate";

export type StepOutcome = "ok" | "mismatch" | "malformed" | "error" | "skipped";

export interface StepResult {
  id: string;
  label: string;
  call: string;
  outcome: StepOutcome;
  /** A response arrived from the endpoint (false for timeouts and network/CORS failures). */
  responseReceived: boolean | null;
  /** The SDK decoded it and our validator accepted the shape. */
  decodedAndValid: boolean | null;
  /** Equal to the recorded StudioNet read-back (null when there is nothing to compare). */
  matchesRecorded: boolean | null;
  details: string[];
  error: CategorisedError | null;
  durationMs: number;
}

export interface TransactionObservation {
  operation: string;
  hash: string;
  topLevelKeys: string[];
  statusName: unknown;
  status: unknown;
  resultName: unknown;
  txExecutionResultName: unknown;
  numOfRounds: unknown;
  leaderReceiptModes: unknown[];
  category: TxCategory;
  lastRoundVotes: string[] | null;
}

export interface CaseReads {
  get_case: unknown;
  get_case_status: unknown;
  get_case_evidence: unknown;
  get_case_history: unknown;
  get_assessment_status: unknown;
  get_assessment: unknown;
}

export interface ReadCheckReport {
  steps: StepResult[];
  stoppedAt: string | null;
  reads: Partial<Record<HashVariant, Partial<CaseReads>>>;
  transactions: TransactionObservation[];
}

export interface ReadCheckOptions {
  timeoutMs: number;
  /** SHA-256 hex of a string (injected so tests do not depend on WebCrypto). */
  sha256Hex: (text: string) => Promise<string>;
  now?: () => number;
  onStep?: (step: StepResult) => void;
}

export const CASE_READ_METHODS = [
  "get_case",
  "get_case_status",
  "get_case_evidence",
  "get_case_history",
  "get_assessment_status",
  "get_assessment",
] as const satisfies readonly ReadMethod[];

export async function browserSha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export async function runReadCheck(
  gateway: ReadOnlyGateway,
  deployment: TestDeployment,
  recorded: CaseReads,
  opts: ReadCheckOptions,
): Promise<ReadCheckReport> {
  const now = opts.now ?? (() => performance.now());
  const report: ReadCheckReport = { steps: [], stoppedAt: null, reads: {}, transactions: [] };

  const record = (step: StepResult) => {
    report.steps.push(step);
    opts.onStep?.(step);
    return step;
  };

  /** One bounded call. Never retried. */
  async function attempt<T>(id: string, label: string, call: string, fn: () => Promise<T>) {
    const start = now();
    try {
      const value = await withTimeout(fn(), opts.timeoutMs, call);
      return { ok: true as const, value, start };
    } catch (err) {
      const error = categoriseError(err);
      const received = error.category === "rpc_error" || error.category === "unparseable_response" || error.category === "sdk_error";
      record({
        id, label, call, outcome: "error", responseReceived: received, decodedAndValid: false,
        matchesRecorded: null, details: [], error, durationMs: Math.round(now() - start),
      });
      return { ok: false as const };
    }
  }

  const stop = (id: string) => {
    report.stoppedAt = id;
    return report;
  };

  // 1. Chain
  const chain = await attempt("rpc.chain", "RPC chain ID", "eth_chainId", () => gateway.chainId());
  if (!chain.ok) return stop("rpc.chain");
  const chainOk = typeof chain.value === "string" && chain.value.toLowerCase() === STUDIONET.chainIdHex;
  record({
    id: "rpc.chain", label: "RPC chain ID", call: "eth_chainId", outcome: chainOk ? "ok" : "mismatch",
    responseReceived: true, decodedAndValid: true, matchesRecorded: chainOk,
    details: [`returned ${JSON.stringify(chain.value)}; expected ${STUDIONET.chainIdHex} (${STUDIONET.chainId})`],
    error: null, durationMs: Math.round(now() - chain.start),
  });
  if (!chainOk) return stop("rpc.chain");

  // 2a. Deploy transaction (supporting evidence for the address)
  const deployTx = await attempt("deploy.tx", "Deploy transaction lookup", `getTransaction(${deployment.deployTx})`, () =>
    gateway.getTransaction(deployment.deployTx),
  );
  if (deployTx.ok) {
    const data = isObj(deployTx.value) && isObj(deployTx.value.data) ? deployTx.value.data : null;
    const decoded = isObj(deployTx.value) && isObj(deployTx.value.txDataDecoded) ? deployTx.value.txDataDecoded : null;
    const reported = data?.contract_address ?? decoded?.contractAddress ?? null;
    const matches = typeof reported === "string" ? reported.toLowerCase() === deployment.address.toLowerCase() : null;
    record({
      id: "deploy.tx", label: "Deploy transaction lookup", call: `getTransaction(${deployment.deployTx})`,
      outcome: matches === false ? "mismatch" : "ok", responseReceived: true, decodedAndValid: isObj(deployTx.value),
      matchesRecorded: matches,
      details: [typeof reported === "string" ? `contract address in transaction: ${reported}` : "no contract address field found in the returned transaction"],
      error: null, durationMs: Math.round(now() - deployTx.start),
    });
    if (matches === false) return stop("deploy.tx");
  }

  // 2b. Deployed code hash (required)
  const code = await attempt("deploy.code", "Deployed contract code", `gen_getContractCode(${deployment.address})`, () =>
    gateway.getContractCode(deployment.address),
  );
  if (!code.ok) return stop("deploy.code");
  const codeHash = typeof code.value === "string" ? await opts.sha256Hex(code.value) : null;
  const codeOk = codeHash === deployment.expectedCodeSha256;
  record({
    id: "deploy.code", label: "Deployed contract code", call: `gen_getContractCode(${deployment.address})`,
    outcome: codeOk ? "ok" : codeHash === null ? "malformed" : "mismatch", responseReceived: true,
    decodedAndValid: codeHash !== null, matchesRecorded: codeOk,
    details: [codeHash === null ? "code was not a string" : `sha256 ${codeHash}; expected ${deployment.expectedCodeSha256}`],
    error: null, durationMs: Math.round(now() - code.start),
  });
  if (!codeOk) return stop("deploy.code");

  // 3. Contract info, case count, case existence (latest-nonfinal)
  const readStep = async (method: ReadMethod, args: readonly string[], variant: HashVariant, expected?: unknown) => {
    const id = `read.${variant}.${method}`;
    const call = `${method}(${args.map((a) => JSON.stringify(a)).join(", ")}) @ ${variant}`;
    const r = await attempt(id, method, call, () => gateway.readContract(deployment.address, method, args, variant));
    if (!r.ok) return { ok: false as const };
    const v = validateRead(method, r.value);
    const diffs = v.ok && expected !== undefined ? diffPaths(r.value, expected) : [];
    const matches = expected === undefined ? null : v.ok && diffs.length === 0;
    record({
      id, label: method, call, outcome: !v.ok ? "malformed" : matches === false ? "mismatch" : "ok",
      responseReceived: true, decodedAndValid: v.ok, matchesRecorded: matches,
      details: v.ok ? diffs.map((d) => `differs from recorded at ${d}`) : v.problems,
      error: null, durationMs: Math.round(now() - r.start),
    });
    return v.ok ? { ok: true as const, value: r.value } : { ok: false as const };
  };

  const info = await readStep("get_contract_info", [], "latest-nonfinal");
  if (!info.ok) return stop("read.latest-nonfinal.get_contract_info");
  const count = await readStep("get_case_count", [], "latest-nonfinal");
  if (!count.ok) return stop("read.latest-nonfinal.get_case_count");
  const caseNumber = Number.parseInt(deployment.caseId.replace(/^VC-/, ""), 10);
  const exists = typeof count.value === "number" && caseNumber >= 1 && caseNumber <= count.value;
  record({
    id: "case.exists", label: "Case exists on this contract", call: `${deployment.caseId} <= case_count`,
    outcome: exists ? "ok" : "mismatch", responseReceived: true, decodedAndValid: true, matchesRecorded: exists,
    details: [`case_count ${String(count.value)}`], error: null, durationMs: 0,
  });
  if (!exists) return stop("case.exists");

  // 4. Case reads at both variants
  for (const variant of ["latest-nonfinal", "latest-final"] as const) {
    const reads: Partial<CaseReads> = {};
    report.reads[variant] = reads;
    for (const method of CASE_READ_METHODS) {
      const r = await readStep(method, [deployment.caseId], variant, recorded[method]);
      if (r.ok) reads[method] = r.value;
    }
  }

  // 5. Transactions
  for (const tx of deployment.transactions) {
    const call = `getTransaction(${tx.hash})`;
    const r = await attempt(`tx.${tx.operation}`, `Transaction: ${tx.operation}`, call, () => gateway.getTransaction(tx.hash));
    if (!r.ok) continue;
    const v = r.value;
    const view = classifyTransaction(v);
    const o = isObj(v) ? v : {};
    const consensus = isObj(o.consensus_data) ? o.consensus_data : null;
    const receipts = consensus && Array.isArray(consensus.leader_receipt) ? consensus.leader_receipt : [];
    report.transactions.push({
      operation: tx.operation, hash: tx.hash, topLevelKeys: Object.keys(o).sort(),
      statusName: o.statusName, status: o.status, resultName: o.resultName ?? o.result_name,
      txExecutionResultName: o.txExecutionResultName, numOfRounds: o.numOfRounds ?? o.num_of_rounds,
      leaderReceiptModes: receipts.map((x) => (isObj(x) ? x.mode : null)), category: view.category,
      lastRoundVotes: view.lastRoundVotes,
    });
    record({
      id: `tx.${tx.operation}`, label: `Transaction: ${tx.operation}`, call,
      outcome: view.category === "UNRECOGNIZED" ? "malformed" : view.category === "FINALIZED_SUCCESS" ? "ok" : "mismatch",
      responseReceived: true, decodedAndValid: view.category !== "UNRECOGNIZED",
      matchesRecorded: view.category === "FINALIZED_SUCCESS",
      details: [`classified ${view.category}; status ${String(view.statusName)}; result ${String(view.resultName)}${view.detail ? `; ${view.detail}` : ""}`],
      error: null, durationMs: Math.round(now() - r.start),
    });
  }
  return report;
}
