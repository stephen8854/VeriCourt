/**
 * Browser-local conveniences, never authoritative:
 * - recently viewed case IDs (written only after a case was read and validated);
 * - transaction hashes this browser itself received from the wallet (written
 *   by the write experiment), so the timeline and report can show transaction
 *   references the contract does not store.
 * Both live only in this browser profile, may be empty or cleared at any time,
 * and every access is wrapped so the app works without storage. Separate keys
 * from the write-safety record (write/pendingStore.ts), which nothing here touches.
 */

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const RECENT_KEY = "vericourt.recent-cases.v1";
export const TX_LOG_KEY = "vericourt.tx-log.v1";
export const MAX_RECENT = 20;
export const MAX_TX_LOG = 100;

export const LOCAL_HISTORY_NOTE = "Stored only in this browser. Not a complete or authoritative list.";

export function browserStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function readJson(storage: StorageLike | null, key: string): unknown {
  if (storage === null) return null;
  try {
    const text = storage.getItem(key);
    return text === null ? null : (JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

function writeJson(storage: StorageLike | null, key: string, value: unknown): void {
  if (storage === null) return;
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // Best effort only: these lists are conveniences.
  }
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const CASE = /^VC-\d{6,}$/;

// ---------------------------------------------------------------------------
// Recently viewed cases (per contract)
// ---------------------------------------------------------------------------

export function recentCases(storage: StorageLike | null, contract: string): string[] {
  const all = readJson(storage, RECENT_KEY);
  if (typeof all !== "object" || all === null || Array.isArray(all)) return [];
  const list = (all as Record<string, unknown>)[contract.toLowerCase()];
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string" && CASE.test(x)).slice(0, MAX_RECENT) : [];
}

export function rememberCase(storage: StorageLike | null, contract: string, caseId: string): void {
  if (!CASE.test(caseId) || !ADDRESS.test(contract)) return;
  const all = readJson(storage, RECENT_KEY);
  const map = typeof all === "object" && all !== null && !Array.isArray(all) ? { ...(all as Record<string, unknown>) } : {};
  const key = contract.toLowerCase();
  map[key] = [caseId, ...recentCases(storage, contract).filter((x) => x !== caseId)].slice(0, MAX_RECENT);
  writeJson(storage, RECENT_KEY, map);
}

// ---------------------------------------------------------------------------
// Transactions this browser sent
// ---------------------------------------------------------------------------

export interface LocalTxEntry {
  contract: string;
  /** The case the write targeted (or created, once verified); null when unknown. */
  caseId: string | null;
  method: string;
  hash: string;
  /** ISO time the hash was recorded. */
  at: string;
  /** The last known write phase (e.g. submitted, verified). */
  phase: string;
}

function isEntry(v: unknown): v is LocalTxEntry {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.contract === "string" && ADDRESS.test(e.contract) &&
    (e.caseId === null || (typeof e.caseId === "string" && CASE.test(e.caseId))) &&
    typeof e.method === "string" && typeof e.hash === "string" && HASH.test(e.hash) &&
    typeof e.at === "string" && typeof e.phase === "string"
  );
}

export function localTransactions(storage: StorageLike | null): LocalTxEntry[] {
  const list = readJson(storage, TX_LOG_KEY);
  return Array.isArray(list) ? list.filter(isEntry).slice(-MAX_TX_LOG) : [];
}

/** Adds or updates (by hash) one entry. */
export function recordLocalTransaction(storage: StorageLike | null, entry: LocalTxEntry): void {
  if (!isEntry(entry)) return;
  const list = localTransactions(storage);
  const i = list.findIndex((e) => e.hash.toLowerCase() === entry.hash.toLowerCase());
  const existing = i === -1 ? undefined : list[i];
  if (existing === undefined) list.push(entry);
  else list[i] = { ...existing, ...entry, caseId: entry.caseId ?? existing.caseId };
  writeJson(storage, TX_LOG_KEY, list.slice(-MAX_TX_LOG));
}
