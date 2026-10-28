/**
 * In-memory "StudioNet" for the write-experiment flow tests. No network, no
 * keys. The fake wallet's eth_sendTransaction can register a transaction here;
 * status reads then step through a scripted timeline, and the case appears in
 * contract state when the timeline reaches FINALIZED.
 */
import { vi } from "vitest";
import { evaluateWriteGate, WRITE_EXPERIMENT_ACK } from "../config/writeGate";
import type { ExperimentReader, FlowDeps, FlowTiming } from "../experiment/createCaseFlow";
import { createSdkWriteClient } from "../experiment/sdkExperiment";
import recordedTx from "../fixtures/recorded/phase-3-3-live-sdk-tx-subset.json";
import type { Hex } from "../write/bytes";
import type { CreateCaseInput } from "../write/createCase";
import type { DurableWriteSession } from "../write/durableSession";
import type { Eip1193Provider } from "../wallet/eip1193";
import { CONTRACT, PRE_SEND_READS, SENDER, TX_HASH, fakeRpc } from "./writeHarness";

export const CODE = "# fake contract source";
export const CODE_SHA = "sha-of-reviewed-contract";
export const ENABLED_GATE = evaluateWriteGate({ mode: "write-experiment", ack: WRITE_EXPERIMENT_ACK, contract: CONTRACT, hostname: "127.0.0.1" });

export const CONNECTED = { phase: "connected" as const, account: SENDER as string, chainId: 61999, explicitConnection: true };

export interface StoredCase {
  case_id: string;
  claimant: string;
  respondent: string;
  title: string;
}

/** A transaction object in the live genlayer-js shape (Phase 3.3 recording) with the given status. */
export function txWithStatus(status: string, hash: string = TX_HASH, resultName = "MAJORITY_AGREE") {
  return { ...recordedTx.transaction, hash, statusName: status, status, result_name: resultName };
}

export interface FakeStudioOptions {
  /** Statuses returned by successive getTransaction reads after the send. */
  timeline?: string[];
  /** Result name for the final status (e.g. MAJORITY_DISAGREE). */
  finalResult?: string;
  /** Whether finality creates the intended case in contract state. */
  createsCase?: boolean;
  preexistingPartyCases?: number;
  nonce?: number;
  overrides?: Partial<Record<keyof ExperimentReader, () => Promise<unknown>>>;
}

export function fakeStudio(options: FakeStudioOptions = {}) {
  const timeline = options.timeline ?? ["PENDING", "ACCEPTED", "FINALIZED"];
  const calls: string[] = [];
  const finalCases: StoredCase[] = Array.from({ length: options.preexistingPartyCases ?? 0 }, (_, i) => ({
    case_id: `VC-00000${i + 1}`,
    claimant: SENDER,
    respondent: "0x" + "99".repeat(20),
    title: `earlier case ${i + 1}`,
  }));
  const nonFinalCases = [...finalCases];
  let sent: { title: string; respondent: string } | null = null;
  let polls = 0;
  let nonce = options.nonce ?? 0;
  const statusAt = () => timeline[Math.min(polls, timeline.length - 1)] ?? "PENDING";

  const addCase = (into: StoredCase[]) => {
    const s = sent;
    if (s !== null && !into.some((c) => c.title === s.title)) {
      into.push({ case_id: `VC-${String(10 + into.length).padStart(6, "0")}`, claimant: SENDER, respondent: s.respondent, title: s.title });
    }
  };

  const reader: ExperimentReader = {
    chainId: async () => (calls.push("chainId"), "0xf22f"),
    gasPrice: async () => (calls.push("gasPrice"), "0x0"),
    getContractCode: async () => (calls.push("getContractCode"), CODE),
    simulateCreateCase: async () => (calls.push("simulate"), "VC-000003"),
    simulateWrite: async () => {
      throw new Error("this harness simulates create_case only");
    },
    getTransactionCount: async () => (calls.push("nonce"), `0x${nonce.toString(16)}`),
    getTransaction: async (hash: Hex) => {
      calls.push("getTransaction");
      if (sent === null || hash.toLowerCase() !== TX_HASH.toLowerCase()) return null;
      const status = statusAt();
      polls += 1;
      if (status === "ACCEPTED" || status === "FINALIZED") addCase(nonFinalCases);
      if (status === "FINALIZED" && (options.createsCase ?? true)) addCase(finalCases);
      return txWithStatus(status, TX_HASH, status === "FINALIZED" ? options.finalResult ?? "MAJORITY_AGREE" : "MAJORITY_AGREE");
    },
    readContract: async (_address, method, args, variant) => {
      calls.push(`${method}@${variant}`);
      const cases = variant === "latest-final" ? finalCases : nonFinalCases;
      if (method === "get_party_case_ids") {
        const offset = Number(args[1]);
        return { case_ids: cases.slice(offset).map((c) => c.case_id), total: cases.length };
      }
      if (method === "get_case") return cases.find((c) => c.case_id === args[0]) ?? null;
      throw new Error(`unexpected read ${method}`);
    },
  };
  for (const [k, fn] of Object.entries(options.overrides ?? {})) (reader as unknown as Record<string, unknown>)[k] = fn;

  return {
    reader,
    calls,
    /** Call from the fake wallet's eth_sendTransaction to "broadcast" the intended case. */
    accept(input: CreateCaseInput) {
      sent = { title: input.title, respondent: input.respondent };
      nonce += 1;
    },
    /** Puts the intended case into final state without any known transaction (effect-only evidence). */
    finalizeCaseOnly(input: CreateCaseInput) {
      sent = { title: input.title, respondent: input.respondent };
      addCase(nonFinalCases);
      addCase(finalCases);
      sent = null;
    },
    get finalCases() {
      return finalCases;
    },
  };
}

export const FAST_TIMING: FlowTiming = {
  submitTimeoutMs: 5_000,
  readTimeoutMs: 1_000,
  pollIntervalMs: 10_000,
  finalityDeadlineMs: 30 * 60_000,
  maxConsecutiveReadFailures: 3,
};

/** Flow dependencies using the REAL genlayer-js write client against an in-memory RPC. */
export function makeDeps(session: DurableWriteSession, wallet: Eip1193Provider, studio: ReturnType<typeof fakeStudio>, timing: Partial<FlowTiming> = {}) {
  let clock = 0;
  const rpc = fakeRpc(PRE_SEND_READS);
  vi.stubGlobal("fetch", rpc.fetch);
  let ids = 0;
  const deps: FlowDeps = {
    session,
    reader: studio.reader,
    wallet,
    makeWriteClient: createSdkWriteClient,
    expectedCodeSha256: CODE_SHA,
    sha256Hex: async (text) => (text === CODE ? CODE_SHA : "different"),
    randomId: () => `op-${Date.now().toString(36)}-${++ids}`,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    timing: { ...FAST_TIMING, ...timing },
  };
  return { deps, rpc, advance: (ms: number) => (clock += ms) };
}
