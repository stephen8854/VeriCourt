/**
 * Transaction references for one case. The contract's history stores no
 * transaction hashes and no verified API lists a contract's transactions, so
 * the only references available are:
 * - the recorded transactions of the known throwaway test deployment;
 * - transactions this browser itself sent (local log).
 * The list is never complete and is always labelled with its source.
 */
import { PHASE_2_17C_NO_REPLY } from "../config/testDeployments";
import { localTransactions, type StorageLike } from "./localHistory";

export interface KnownTransaction {
  hash: string;
  operation: string;
  source: string;
}

export const KNOWN_TRANSACTIONS_NOTE =
  "The contract does not store transaction IDs. Only transactions known to this app are listed: recorded test runs and writes sent from this browser. The list may be incomplete.";

export function knownTransactionsFor(contract: string, caseId: string, storage: StorageLike | null): KnownTransaction[] {
  const out: KnownTransaction[] = [];
  const d = PHASE_2_17C_NO_REPLY;
  if (contract.toLowerCase() === d.address.toLowerCase()) {
    if (caseId === d.caseId) {
      for (const t of d.transactions) {
        if (t.operation !== "deploy") out.push({ hash: t.hash, operation: t.operation, source: "recorded test run (Phase 2.17C)" });
      }
    }
    for (const w of d.laterWrites) {
      if (w.caseId === caseId) out.push({ hash: w.hash, operation: w.operation.split(" ")[0] ?? w.operation, source: `recorded test (Phase ${w.phase})` });
    }
  }
  for (const e of localTransactions(storage)) {
    if (e.contract.toLowerCase() !== contract.toLowerCase() || e.caseId !== caseId) continue;
    if (out.some((o) => o.hash.toLowerCase() === e.hash.toLowerCase())) continue;
    out.push({ hash: e.hash, operation: e.method, source: `sent from this browser (${e.at.slice(0, 19).replace("T", " ")} UTC; last seen ${e.phase})` });
  }
  return out;
}
