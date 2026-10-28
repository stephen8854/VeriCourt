/**
 * Classifies a GenLayer transaction object (TypeScript port of the Phase 2.13
 * harness classifier, tests/integration/harness.py `classify_transaction`).
 *
 * Success requires all of: status ACCEPTED or FINALIZED, consensus result
 * MAJORITY_AGREE, and the leader receipt (mode "leader") reporting execution
 * SUCCESS with a `return` result. Anything unreadable is UNRECOGNIZED, never
 * success.
 *
 * Verification status of the input shape:
 * - Verified: StudioNet's raw eth_getTransactionByHash shape (snake_case
 *   `status`, `result_name`, `consensus_data.leader_receipt[]`, `last_round`),
 *   recorded in Phase 2.8; genlayer-js 1.1.8 adds `statusName` on Studio chains
 *   (dist/index.js, transactionActions.getTransaction).
 * - Unverified: the exact object genlayer-js returns in a browser after
 *   `decodeLocalnetTransaction` (leader `result` may be base64 or decoded);
 *   both forms are accepted. CamelCase fallbacks are defensive guesses.
 */

export type TxCategory =
  | "PENDING"
  | "ACCEPTED_SUCCESS"
  | "FINALIZED_SUCCESS"
  | "ACCEPTED_EXECUTION_FAILED"
  | "FINALIZED_EXECUTION_FAILED"
  | "VALIDATOR_DISAGREEMENT"
  | "UNDETERMINED"
  | "UNRECOGNIZED";

export const SUCCESS_CATEGORIES: readonly TxCategory[] = ["ACCEPTED_SUCCESS", "FINALIZED_SUCCESS"];

export interface TxView {
  category: TxCategory;
  statusName: string | null;
  resultName: string | null;
  final: boolean;
  leaderExecution: string | null;
  leaderResultStatus: string | null;
  leaderResultPayload: string | null;
  /** Names exactly as reported for the last round; never summarised into "all agreed". */
  lastRoundVotes: string[] | null;
  detail: string;
}

const PENDING_STATUSES = [
  "UNINITIALIZED",
  "PENDING",
  "ACTIVATED",
  "PROPOSING",
  "COMMITTING",
  "REVEALING",
  "APPEAL_REVEALING",
  "APPEAL_COMMITTING",
  "READY_TO_FINALIZE",
];
const INCONCLUSIVE_STATUSES = ["LEADER_TIMEOUT", "VALIDATORS_TIMEOUT", "CANCELED"];
const INCONCLUSIVE_RESULTS = ["NO_MAJORITY", "TIMEOUT", "DETERMINISTIC_VIOLATION"];
const RESULT_CODES: Record<number, string> = {
  0: "return",
  1: "rollback",
  2: "contract_error",
  3: "error",
  4: "none",
  5: "no_leaders",
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function statusNameOf(tx: Obj): string | null {
  return str(tx.statusName) ?? str(tx.status_name) ?? str(tx.status);
}

function resultNameOf(tx: Obj): string | null {
  return str(tx.resultName) ?? str(tx.result_name);
}

function leaderReceipt(tx: Obj): Obj | null {
  const consensus = isObj(tx.consensus_data) ? tx.consensus_data : isObj(tx.consensusData) ? tx.consensusData : null;
  if (consensus === null) return null;
  const raw = consensus.leader_receipt ?? consensus.leaderReceipt;
  const receipts = Array.isArray(raw) ? raw : isObj(raw) ? [raw] : [];
  // The list can also hold the leader's own validator-mode receipt (Phase 2.8): select by mode.
  const leader = receipts.find((r) => isObj(r) && r.mode === "leader");
  return isObj(leader) ? leader : null;
}

function decodeBase64(value: string): Uint8Array | null {
  try {
    const bin = atob(value);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** (status, payload) of a leader result, whether still base64 or already decoded. */
export function decodeLeaderResult(result: unknown): { status: string | null; payload: string | null } {
  if (isObj(result)) {
    const payload = isObj(result.payload) ? str(result.payload.readable) : str(result.payload);
    return { status: str(result.status), payload };
  }
  if (typeof result === "string" && result.length > 0) {
    const bytes = decodeBase64(result);
    const first = bytes?.[0];
    if (bytes === null || first === undefined) return { status: null, payload: null };
    const status = RESULT_CODES[first] ?? null;
    const payload = first === 1 || first === 2 ? new TextDecoder().decode(bytes.slice(1)).slice(0, 500) : null;
    return { status, payload };
  }
  return { status: null, payload: null };
}

function votesOf(tx: Obj): string[] | null {
  const round = isObj(tx.last_round) ? tx.last_round : isObj(tx.lastRound) ? tx.lastRound : null;
  const names = round?.validator_votes_name ?? round?.validatorVotesName;
  return Array.isArray(names) && names.every((n) => typeof n === "string") ? [...names] : null;
}

export function classifyTransaction(tx: unknown): TxView {
  const view: TxView = {
    category: "UNRECOGNIZED",
    statusName: null,
    resultName: null,
    final: false,
    leaderExecution: null,
    leaderResultStatus: null,
    leaderResultPayload: null,
    lastRoundVotes: null,
    detail: "",
  };
  if (!isObj(tx)) return { ...view, detail: "transaction is not an object" };
  const status = statusNameOf(tx);
  const result = resultNameOf(tx);
  view.statusName = status;
  view.resultName = result;
  view.final = status === "FINALIZED";
  view.lastRoundVotes = votesOf(tx);

  if (status !== null && PENDING_STATUSES.includes(status)) return { ...view, category: "PENDING" };
  if (status !== null && INCONCLUSIVE_STATUSES.includes(status)) {
    return { ...view, category: "UNDETERMINED", detail: `status ${status}` };
  }
  if (status !== "ACCEPTED" && status !== "UNDETERMINED" && status !== "FINALIZED") {
    return { ...view, detail: `unknown status ${String(status)}` };
  }
  if (result === "MAJORITY_DISAGREE") {
    return { ...view, category: "VALIDATOR_DISAGREEMENT", detail: "validators rejected the leader's result; no state change" };
  }
  if (status === "UNDETERMINED" || (result !== null && INCONCLUSIVE_RESULTS.includes(result))) {
    return { ...view, category: "UNDETERMINED", detail: `status ${status}, result ${String(result)}` };
  }
  if (result !== "MAJORITY_AGREE") {
    return { ...view, detail: `unexpected consensus result ${String(result)} for status ${status}` };
  }
  const leader = leaderReceipt(tx);
  if (leader === null) return { ...view, detail: "no leader receipt" };
  const decoded = decodeLeaderResult(leader.result);
  view.leaderExecution = str(leader.execution_result) ?? str(leader.executionResult);
  view.leaderResultStatus = decoded.status;
  view.leaderResultPayload = decoded.payload;
  if (view.leaderExecution === "SUCCESS" && decoded.status === "return") {
    return { ...view, category: view.final ? "FINALIZED_SUCCESS" : "ACCEPTED_SUCCESS" };
  }
  if (view.leaderExecution === "ERROR" || ["rollback", "contract_error", "error"].includes(decoded.status ?? "")) {
    return {
      ...view,
      category: view.final ? "FINALIZED_EXECUTION_FAILED" : "ACCEPTED_EXECUTION_FAILED",
      detail: "validators agreed on a failed execution",
    };
  }
  return { ...view, detail: `leader execution ${String(view.leaderExecution)}, result ${String(decoded.status)}` };
}
