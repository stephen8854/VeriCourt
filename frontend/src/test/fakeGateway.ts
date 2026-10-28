/**
 * Offline stand-in for the StudioNet read-only gateway, built from RECORDED
 * Phase 2.17C data. Wrapped in a strict proxy: touching any property other than
 * the four read-only methods throws, so a write attempt cannot go unnoticed.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { vi } from "vitest";
import { PHASE_2_17C_NO_REPLY } from "../config/testDeployments";
import { GATEWAY_METHODS, type HashVariant, type ReadMethod, type ReadOnlyGateway } from "../live/gateway";
import { recordedNoReplyCaseReads } from "../live/expected";

export const CONTRACT_SOURCE = readFileSync(resolve(process.cwd(), "..", "contracts", "vericourt.py"), "utf8");
export const nodeSha256Hex = async (text: string) => createHash("sha256").update(text).digest("hex");

/** Reconstructed (shape inferred) FINALIZED transaction in the raw Studio shape. */
export function finalizedTx(payload: string | null, extra: Record<string, unknown> = {}) {
  return {
    status: 7,
    statusName: "FINALIZED",
    result_name: "MAJORITY_AGREE",
    num_of_rounds: "1",
    consensus_data: {
      leader_receipt: [{ mode: "leader", execution_result: "SUCCESS", result: { status: "return", payload: { readable: payload } } }],
    },
    last_round: { validator_votes_name: ["IDLE", "AGREE", "AGREE", "AGREE", "IDLE"] },
    ...extra,
  };
}

export interface FakeOptions {
  chainId?: unknown;
  code?: unknown;
  deployAddress?: string;
  overrideRead?: (method: ReadMethod, variant: HashVariant) => Promise<unknown> | undefined;
  overrideChain?: () => Promise<unknown>;
}

export function fakeGateway(opts: FakeOptions = {}) {
  const reads = recordedNoReplyCaseReads() as unknown as Record<string, unknown>;
  const info = { schema_version: "vericourt-case-v1", case_count: 1, statuses: [], categories: [], evidence_types: [], limits: {}, assessment: {} };
  const impl: ReadOnlyGateway = {
    chainId: vi.fn(async () => (opts.overrideChain ? opts.overrideChain() : (opts.chainId ?? "0xf22f"))),
    getContractCode: vi.fn(async () => opts.code ?? CONTRACT_SOURCE),
    readContract: vi.fn(async (_address, method, _args, variant) => {
      const override = opts.overrideRead?.(method, variant);
      if (override !== undefined) return override;
      if (method === "get_contract_info") return info;
      if (method === "get_case_count") return 1;
      return structuredClone(reads[method]);
    }),
    getTransaction: vi.fn(async (hash) =>
      hash === PHASE_2_17C_NO_REPLY.deployTx
        ? finalizedTx(null, { data: { contract_address: opts.deployAddress ?? PHASE_2_17C_NO_REPLY.address } })
        : finalizedTx('"ok"'),
    ),
  };
  const strict = new Proxy(impl, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && !(GATEWAY_METHODS as readonly string[]).includes(prop) && prop !== "then") {
        throw new Error(`gateway property ${prop} accessed: only read-only methods exist`);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { gateway: strict, impl };
}
