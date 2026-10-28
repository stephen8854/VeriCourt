/**
 * Read-only loading of case data for the general case views (Phase 4.0B).
 *
 * - Only the four read-only gateway operations are used; nothing here can
 *   write, sign or reach a wallet.
 * - Before any case data is trusted, the configured contract is checked once
 *   per session: StudioNet chain, deployed code equal to the reviewed
 *   contract, and the expected schema versions.
 * - Every call is bounded by a timeout and never retried. A failed read stops
 *   the load ("unavailable"); reads are safe to repeat by hand.
 * - The record shown is read at latest-final. A latest-nonfinal `get_case` is
 *   compared with it, so changes that are not final yet are reported, never
 *   shown as the record. A case that exists only at latest-nonfinal is shown
 *   from latest-nonfinal and marked "not final yet".
 * - Every response is validated; invalid sections are never rendered.
 */
import { ASSESSMENT_SCHEMA_VERSION, CASE_SCHEMA_VERSION } from "../contract/enums";
import type { AssessmentView, CaseView, EvidenceView, HistoryEntryView } from "../contract/types";
import { STUDIONET } from "../config/network";
import { categoriseError, withTimeout, type CategorisedError } from "../live/errors";
import type { HashVariant, ReadMethod, ReadOnlyGateway } from "../live/gateway";
import { diffPaths, validateAssessment, validateCase, validatePartyCaseIds, validateRead, type Validation } from "../live/validate";
import { checkConsistency } from "./consistency";

export type Address = `0x${string}`;

export interface ReadOptions {
  timeoutMs: number;
  /** Pause before the single retry of a read that failed at the network level (no response reached the page). */
  networkRetryDelayMs?: number;
  sha256Hex: (text: string) => Promise<string>;
  expectedCodeSha256: string;
}

export const DEFAULT_READ_TIMEOUT_MS = 20_000;

/** A read that could not complete: no response, an RPC error, or an unparseable answer. */
export interface ReadFailure {
  kind: "unavailable";
  step: string;
  error: CategorisedError;
}

export class ReadStopped extends Error {
  constructor(readonly failure: ReadFailure) {
    super(`${failure.step}: ${failure.error.message}`);
  }
}

/**
 * One bounded read. A read that failed before any response arrived (network,
 * DNS, CORS, a dropped connection) is retried once after a short pause: it is
 * a read, so repeating it changes nothing. Timeouts and RPC errors are not
 * retried.
 */
async function call<T>(step: string, timeoutMs: number, fn: () => Promise<T>, retryDelayMs = DEFAULT_NETWORK_RETRY_DELAY_MS): Promise<T> {
  try {
    return await withTimeout(fn(), timeoutMs, step);
  } catch (err) {
    const first = categoriseError(err);
    if (first.category !== "network_or_cors") throw new ReadStopped({ kind: "unavailable", step, error: first });
  }
  await new Promise((r) => setTimeout(r, retryDelayMs));
  try {
    return await withTimeout(fn(), timeoutMs, step);
  } catch (err) {
    throw new ReadStopped({ kind: "unavailable", step, error: categoriseError(err) });
  }
}

export const DEFAULT_NETWORK_RETRY_DELAY_MS = 1500;

function read(gateway: ReadOnlyGateway, address: Address, method: ReadMethod, args: readonly (string | number)[], variant: HashVariant, timeoutMs: number, retryDelayMs?: number) {
  const step = `${method}(${args.map((a) => JSON.stringify(a)).join(", ")}) @ ${variant}`;
  return call(step, timeoutMs, () => gateway.readContract(address, method, args, variant), retryDelayMs);
}

// ---------------------------------------------------------------------------
// Contract check (once per session per address)
// ---------------------------------------------------------------------------

export type ContractCheck =
  | { kind: "ok" }
  | ReadFailure
  | { kind: "unexpected_contract"; reason: string };

const contractChecks = new Map<string, Promise<ContractCheck>>();

/** For tests: forget cached contract checks. */
export function resetContractCheckCache(): void {
  contractChecks.clear();
}

async function runContractCheck(gateway: ReadOnlyGateway, address: Address, opts: ReadOptions): Promise<ContractCheck> {
  try {
    // Independent reads run in parallel (same request count, fewer round trips).
    const [chain, code, info] = await Promise.all([
      call("eth_chainId", opts.timeoutMs, () => gateway.chainId(), opts.networkRetryDelayMs),
      call(`gen_getContractCode(${address})`, opts.timeoutMs, () => gateway.getContractCode(address), opts.networkRetryDelayMs),
      read(gateway, address, "get_contract_info", [], "latest-final", opts.timeoutMs, opts.networkRetryDelayMs),
    ]);
    if (typeof chain !== "string" || chain.toLowerCase() !== STUDIONET.chainIdHex) {
      return { kind: "unexpected_contract", reason: `the RPC reports chain ${JSON.stringify(chain)}, not StudioNet (${STUDIONET.chainId})` };
    }
    if (typeof code !== "string" || code.length === 0) return { kind: "unexpected_contract", reason: "no contract code was returned for this address" };
    if ((await opts.sha256Hex(code)) !== opts.expectedCodeSha256) {
      return { kind: "unexpected_contract", reason: "the deployed code is not the reviewed VeriCourt contract" };
    }
    const v = validateRead("get_contract_info", info);
    if (!v.ok) return { kind: "unexpected_contract", reason: `get_contract_info: ${v.problems.join("; ")}` };
    const i = info as { schema_version: unknown; assessment: { schema_version?: unknown } };
    if (i.schema_version !== CASE_SCHEMA_VERSION) return { kind: "unexpected_contract", reason: `case schema ${String(i.schema_version)}, expected ${CASE_SCHEMA_VERSION}` };
    if (i.assessment.schema_version !== ASSESSMENT_SCHEMA_VERSION) {
      return { kind: "unexpected_contract", reason: `assessment schema ${String(i.assessment.schema_version)}, expected ${ASSESSMENT_SCHEMA_VERSION}` };
    }
    return { kind: "ok" };
  } catch (err) {
    if (err instanceof ReadStopped) return err.failure;
    throw err;
  }
}

/** Cached per address; a failed (unavailable) check is not cached, so it can be repeated. */
export async function checkContract(gateway: ReadOnlyGateway, address: Address, opts: ReadOptions): Promise<ContractCheck> {
  const key = address.toLowerCase();
  const cached = contractChecks.get(key);
  if (cached) return cached;
  const p = runContractCheck(gateway, address, opts);
  contractChecks.set(key, p);
  const result = await p;
  if (result.kind === "unavailable") contractChecks.delete(key);
  return result;
}

// ---------------------------------------------------------------------------
// One case
// ---------------------------------------------------------------------------

export type Finality =
  /** latest-final and latest-nonfinal `get_case` are identical. */
  | { kind: "final" }
  /** The record shown is final; newer changes exist that are not final yet. */
  | { kind: "pending_changes"; differences: string[]; nonfinalStatus: string }
  /** The case exists only at latest-nonfinal (just created). */
  | { kind: "not_final_yet" };

export interface CaseData {
  caseId: string;
  /** Variant the record (all sections) was read at. */
  source: HashVariant;
  finality: Finality;
  case: CaseView;
  evidence: Validation<EvidenceView[]>;
  history: Validation<HistoryEntryView[]>;
  assessmentStatus: Validation<AssessmentStatusView>;
  assessment: Validation<AssessmentView>;
  /** Cross-read contradictions (empty when consistent). */
  inconsistencies: string[];
  /** Number of read requests made for this load (excluding the cached contract check). */
  requests: number;
}

export interface AssessmentStatusView {
  case_id: string;
  status: string;
  has_assessment: boolean;
  attempts: number;
  max_attempts: number;
  remaining_attempts: number;
  can_request: boolean;
  last_error: string;
  schema_version: string;
}

export type CaseLoad =
  | { kind: "loaded"; data: CaseData }
  | { kind: "invalid_id" }
  | { kind: "not_found"; caseCount: number }
  | { kind: "malformed"; step: string; problems: string[] }
  | ReadFailure
  | { kind: "unexpected_contract"; reason: string };

function caseNumber(caseId: string): number | null {
  const m = /^VC-(\d{6,})$/.exec(caseId);
  if (!m) return null;
  const n = Number.parseInt(m[1] ?? "", 10);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

function countOf(v: unknown): number | null {
  const r = validateRead("get_case_count", v);
  return r.ok ? (r.value as number) : null;
}

/**
 * Loads one case in three parallel rounds: the two counts; then `get_case`
 * at both variants with evidence, history, assessment status and assessment
 * (8 requests in total), after the cached contract check.
 */
export async function loadCase(gateway: ReadOnlyGateway, address: Address, caseId: string, opts: ReadOptions): Promise<CaseLoad> {
  const n = caseNumber(caseId);
  if (n === null) return { kind: "invalid_id" };
  const check = await checkContract(gateway, address, opts);
  if (check.kind !== "ok") return check;
  let requests = 0;
  const r = async (method: ReadMethod, args: readonly (string | number)[], variant: HashVariant) => {
    requests += 1;
    return read(gateway, address, method, args, variant, opts.timeoutMs, opts.networkRetryDelayMs);
  };
  try {
    const [nonfinalRawCount, finalRawCount] = await Promise.all([r("get_case_count", [], "latest-nonfinal"), r("get_case_count", [], "latest-final")]);
    const nonfinalCount = countOf(nonfinalRawCount);
    if (nonfinalCount === null) return { kind: "malformed", step: "get_case_count @ latest-nonfinal", problems: ["expected a non-negative integer"] };
    if (n > nonfinalCount) return { kind: "not_found", caseCount: nonfinalCount };
    const finalCount = countOf(finalRawCount);
    if (finalCount === null) return { kind: "malformed", step: "get_case_count @ latest-final", problems: ["expected a non-negative integer"] };
    const source: HashVariant = n <= finalCount ? "latest-final" : "latest-nonfinal";

    // The record and its sections at `source`, plus latest-nonfinal get_case for the finality comparison, in parallel.
    const [primaryRaw, nonfinalRaw, evidenceRaw, historyRaw, statusRaw, assessmentRaw] = await Promise.all([
      r("get_case", [caseId], source),
      source === "latest-final" ? r("get_case", [caseId], "latest-nonfinal") : Promise.resolve(null),
      r("get_case_evidence", [caseId], source),
      r("get_case_history", [caseId], source),
      r("get_assessment_status", [caseId], source),
      r("get_assessment", [caseId], source),
    ]);
    const primary = validateCase(primaryRaw);
    if (!primary.ok) return { kind: "malformed", step: `get_case @ ${source}`, problems: primary.problems };
    let finality: Finality = { kind: "not_final_yet" };
    if (source === "latest-final") {
      const nonfinal = validateCase(nonfinalRaw);
      if (!nonfinal.ok) return { kind: "malformed", step: "get_case @ latest-nonfinal", problems: nonfinal.problems };
      const differences = diffPaths(primary.value, nonfinal.value);
      finality = differences.length === 0 ? { kind: "final" } : { kind: "pending_changes", differences, nonfinalStatus: nonfinal.value.status };
    }
    const evidence = validateRead("get_case_evidence", evidenceRaw) as Validation<EvidenceView[]>;
    const history = validateRead("get_case_history", historyRaw) as Validation<HistoryEntryView[]>;
    const assessmentStatus = validateRead("get_assessment_status", statusRaw) as Validation<AssessmentStatusView>;
    const assessment = validateAssessment(assessmentRaw);
    const data: CaseData = {
      caseId,
      source,
      finality,
      case: primary.value,
      evidence,
      history,
      assessmentStatus,
      assessment,
      inconsistencies: [],
      requests,
    };
    data.inconsistencies = checkConsistency(data);
    return { kind: "loaded", data };
  } catch (err) {
    if (err instanceof ReadStopped) return err.failure;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Cases of one party (dashboard)
// ---------------------------------------------------------------------------

export interface PartyCaseRow {
  caseId: string;
  status: Validation<CaseStatusRow>;
}

export interface CaseStatusRow {
  case_id: string;
  status: string;
  response_state: string;
  created_at: number;
  reply_deadline: number;
  snapshot_locked: boolean;
}

export type PartyCasesLoad =
  | { kind: "loaded"; total: number; offset: number; rows: PartyCaseRow[] }
  | { kind: "malformed"; step: string; problems: string[] }
  | ReadFailure
  | { kind: "unexpected_contract"; reason: string };

export const PARTY_PAGE_SIZE = 10;

/**
 * The contract's own index of cases where `party` is claimant or respondent,
 * read at latest-nonfinal (so a just-created case appears; rows say so).
 * 1 + up to PARTY_PAGE_SIZE requests.
 */
export async function loadPartyCases(
  gateway: ReadOnlyGateway,
  address: Address,
  party: string,
  offset: number,
  opts: ReadOptions,
): Promise<PartyCasesLoad> {
  const check = await checkContract(gateway, address, opts);
  if (check.kind !== "ok") return check;
  try {
    const page = validatePartyCaseIds(await read(gateway, address, "get_party_case_ids", [party, offset, PARTY_PAGE_SIZE], "latest-nonfinal", opts.timeoutMs, opts.networkRetryDelayMs));
    if (!page.ok) return { kind: "malformed", step: "get_party_case_ids", problems: page.problems };
    const statuses = await Promise.all(page.value.case_ids.map((id) => read(gateway, address, "get_case_status", [id], "latest-nonfinal", opts.timeoutMs, opts.networkRetryDelayMs)));
    const rows: PartyCaseRow[] = page.value.case_ids.map((id, i) => ({ caseId: id, status: validateRead("get_case_status", statuses[i]) as Validation<CaseStatusRow> }));
    return { kind: "loaded", total: page.value.total, offset, rows };
  } catch (err) {
    if (err instanceof ReadStopped) return err.failure;
    throw err;
  }
}
