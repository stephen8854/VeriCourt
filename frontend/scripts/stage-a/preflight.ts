/**
 * Phase 3.5A Stage A: read-only preflight. Sends no transaction, creates no key.
 * Only read methods are allowed through the bounded fetch; `gen_call` is used
 * for reads and for one write SIMULATION (no transaction is created).
 *
 * Usage (from frontend/): node <bundle> <output-json-path>
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createClient, decodeInputData } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { decodeAddTransactionV5 } from "../../src/write/addTransaction";
import { buildWriteIntent, studionetWriteParams } from "../../src/write/intent";
import {
  CHAIN_ID_HEX, CONTRACT, DEPLOY_TX, EXPECTED_CODE_SHA256, FICTIONAL_CASE_ARGS, FICTIONAL_RESPONDENT,
  RPC_URL, T0, boundedFetch, requestLog, step, toJson,
} from "./shared";

const READS = new Set([
  "eth_chainId", "eth_gasPrice", "eth_getCode", "eth_estimateGas", "eth_blockNumber",
  "gen_getContractCode", "gen_call", "eth_getTransactionByHash", "sim_getConsensusContract",
]);

/** Placeholder claimant for the simulation only. Never signs anything. */
const SIMULATION_SENDER = "0x5157000000000000000000000000000000000001" as const;

type ClientConfig = NonNullable<Parameters<typeof createClient>[0]>;

async function main() {
  const out = process.argv[2];
  if (!out) throw new Error("usage: preflight <output-json>");
  globalThis.fetch = boundedFetch(globalThis.fetch.bind(globalThis), READS);
  const client = createClient({ chain: studionet } as unknown as ClientConfig);
  const rpc = (method: string, params: unknown[] = []) => client.request({ method, params } as never) as Promise<unknown>;

  const r: Record<string, unknown> = { startedAt: new Date(T0).toISOString(), rpcUrl: RPC_URL, contract: CONTRACT };

  r.chainId = await step("eth_chainId", () => rpc("eth_chainId"));
  r.gasPrice = await step("eth_gasPrice", () => rpc("eth_gasPrice"));
  r.blockNumber = await step("eth_blockNumber", () => rpc("eth_blockNumber"));
  r.consensusReported = await step("sim_getConsensusContract(ConsensusMain)", () => rpc("sim_getConsensusContract", ["ConsensusMain"]));
  r.sdkConsensusAddress = studionet.consensusMainContract?.address;
  r.codeAtSdkConsensusAddress = await step("eth_getCode(sdk consensus address)", () => rpc("eth_getCode", [studionet.consensusMainContract?.address, "latest"]));

  const code = await step("gen_getContractCode", () => client.getContractCode(CONTRACT));
  const sha = code.ok ? createHash("sha256").update(code.value, "utf8").digest("hex") : null;
  r.code = { ok: code.ok, sha256: sha, expected: EXPECTED_CODE_SHA256, matches: sha === EXPECTED_CODE_SHA256, ...(code.ok ? {} : { error: code.error }) };

  const deploy = await step("getTransaction(deployTx)", () => client.getTransaction({ hash: DEPLOY_TX as never }));
  if (deploy.ok) {
    const v = deploy.value as unknown as { data?: { contract_address?: unknown }; statusName?: unknown; from_address?: unknown };
    r.deployTx = { ok: true, statusName: v.statusName, contractAddress: v.data?.contract_address ?? null, deployer: v.from_address ?? null };
  } else r.deployTx = deploy;

  const read = (fn: string, args: unknown[], variant: "latest-nonfinal" | "latest-final") =>
    step(`${fn} @ ${variant}`, () =>
      client.readContract({ address: CONTRACT, functionName: fn, args: args as never, transactionHashVariant: variant as never }),
    );
  r.contractInfo = await read("get_contract_info", [], "latest-final");
  r.caseCountFinal = await read("get_case_count", [], "latest-final");
  r.caseCountNonFinal = await read("get_case_count", [], "latest-nonfinal");

  // The exact request, with a placeholder sender (only the _sender word depends on the real sender).
  const intent = buildWriteIntent({
    operationId: "stage-a-preflight",
    chain: studionetWriteParams(),
    sender: SIMULATION_SENDER,
    contractAddress: CONTRACT,
    method: "create_case",
    args: FICTIONAL_CASE_ARGS,
    expectedNonce: 0n,
  });
  const decoded = decodeAddTransactionV5(intent.calldata);
  r.intent = {
    chainId: intent.chainId,
    to: intent.consensusAddress,
    selector: intent.selector,
    calldataBytes: (intent.calldata.length - 2) / 2,
    decoded: decoded && {
      sender: decoded.sender,
      recipient: decoded.recipient,
      numOfInitialValidators: decoded.numOfInitialValidators,
      maxRotations: decoded.maxRotations,
      txDataBytes: (decoded.txData.length - 2) / 2,
      leaderOnlyRlpByte: decoded.txData.slice(-2),
    },
    txDataDecodedBySdk: decoded ? decodeInputData(decoded.txData, CONTRACT) : null,
    respondent: FICTIONAL_RESPONDENT,
  };

  r.simulation = await step("simulateWriteContract(create_case) [gen_call, no transaction]", () =>
    client.simulateWriteContract({
      account: { address: SIMULATION_SENDER } as never,
      address: CONTRACT,
      functionName: "create_case",
      args: FICTIONAL_CASE_ARGS as never,
    }),
  );
  r.estimateGas = await step("eth_estimateGas(to=sdk consensus, data=intent)", () =>
    rpc("eth_estimateGas", [{ from: SIMULATION_SENDER, to: intent.consensusAddress, data: intent.calldata, value: "0x0" }]),
  );

  r.checks = {
    chain: (r.chainId as { ok: boolean; value?: unknown }).ok && (r.chainId as { value?: unknown }).value === CHAIN_ID_HEX,
    gasless: (r.gasPrice as { value?: unknown }).value === "0x0",
    code: (r.code as { matches: boolean }).matches,
    deployAddress: String((r.deployTx as { contractAddress?: unknown }).contractAddress ?? "").toLowerCase() === CONTRACT.toLowerCase(),
    intentDecodes: decoded !== null && decoded.recipient.toLowerCase() === CONTRACT.toLowerCase(),
    simulationOk: (r.simulation as { ok: boolean }).ok,
  };
  r.requestLog = requestLog;
  r.elapsedMs = Date.now() - T0;
  writeFileSync(out, toJson(r));
  console.log(toJson({ checks: r.checks, elapsedMs: r.elapsedMs, requests: requestLog.length }));
}

main().catch((err: unknown) => {
  console.error("preflight aborted:", (err as Error).message);
  process.exitCode = 1;
});
