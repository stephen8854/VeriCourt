/**
 * Phase 3.5A Stage A: ONE guarded create_case write through genlayer-js 1.1.8
 * (local-account path), then read-only monitoring. Run only with explicit approval.
 *
 * Safety:
 * - The test key is created inside this process, used only to build the
 *   guarded signer, never printed, logged, returned or written. Every output
 *   is checked for its digits before it is printed or saved. The process exits
 *   afterwards; nothing is reused.
 * - WriteSession + WriteGuard: at most one signTransaction and one
 *   eth_sendRawTransaction (guarded fetch), each checked byte-for-byte against
 *   the approved intent. No retry on any outcome.
 * - Submission deadline 240 s; finality deadline 30 min; every read 20 s.
 * - Uncertain outcome: read-only reconciliation only, then stop.
 *
 * Usage (from frontend/): node <bundle> <output-json-path>
 */
import { writeFileSync } from "node:fs";
import { createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { keccak256 } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { classifyTransaction } from "../../src/tx/classify";
import type { Hex } from "../../src/write/bytes";
import { createGuardedLocalAccount } from "../../src/write/guardedAccount";
import { READ_METHODS, createGuardedFetch } from "../../src/write/guardedFetch";
import { buildWriteIntent, studionetWriteParams } from "../../src/write/intent";
import { knownHashes } from "../../src/write/reconcile";
import { WriteSession } from "../../src/write/session";
import {
  CHAIN_ID_HEX, CONTRACT, EXPECTED_CODE_SHA256, FICTIONAL_CASE_ARGS, FICTIONAL_RESPONDENT, RPC_URL, T0,
  assertSecretAbsent, boundedFetch, requestLog, step, toJson,
} from "./shared";

const SUBMIT_DEADLINE_MS = 240_000;
const FINALITY_DEADLINE_MS = 30 * 60_000;
const POLL_INTERVAL_MS = 10_000;

type ClientConfig = NonNullable<Parameters<typeof createClient>[0]>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const elapsed = () => Date.now() - T0;

async function main() {
  const out = process.argv[2];
  if (!out) throw new Error("usage: write <output-json>");

  // --- Key: in memory only. `secret` is used for the signer and for output checks, nothing else.
  const secret = generatePrivateKey();
  const local = privateKeyToAccount(secret);
  const sender = local.address as Hex;
  const emit = (text: string) => {
    assertSecretAbsent(text, secret);
    return text;
  };

  const bounded = boundedFetch(globalThis.fetch.bind(globalThis), new Set([...READ_METHODS, "eth_sendRawTransaction"]), {
    noAbort: new Set(["eth_sendRawTransaction"]),
  });
  globalThis.fetch = bounded;
  const reader = createClient({ chain: studionet } as unknown as ClientConfig);
  const rpc = (method: string, params: unknown[] = []) => reader.request({ method, params } as never) as Promise<unknown>;
  const readContract = (fn: string, args: unknown[], variant: "latest-final" | "latest-nonfinal") =>
    reader.readContract({ address: CONTRACT, functionName: fn, args: args as never, transactionHashVariant: variant as never });

  const r: Record<string, unknown> = { startedAt: new Date(T0).toISOString(), sender, contract: CONTRACT, respondent: FICTIONAL_RESPONDENT };
  const save = () => {
    r.requestLog = requestLog;
    r.elapsedMs = elapsed();
    writeFileSync(out, emit(toJson(r)));
  };
  const abort = (reason: string) => {
    r.aborted = reason;
    save();
    console.log(emit(toJson({ aborted: reason })));
  };

  // --- 1. Prechecks (read-only). Any failure: no write.
  const pre: Record<string, unknown> = {};
  r.prechecks = pre;
  const chainId = await step("eth_chainId", () => rpc("eth_chainId"));
  pre.chainId = chainId;
  if (!chainId.ok || chainId.value !== CHAIN_ID_HEX) return abort("chain id is not StudioNet 61999");
  const gasPrice = await step("eth_gasPrice", () => rpc("eth_gasPrice"));
  pre.gasPrice = gasPrice;
  if (!gasPrice.ok || gasPrice.value !== "0x0") return abort("eth_gasPrice is not 0x0");
  const nonceLatest = await step("nonce latest", () => rpc("eth_getTransactionCount", [sender, "latest"]));
  const noncePending = await step("nonce pending", () => rpc("eth_getTransactionCount", [sender, "pending"]));
  pre.nonce = { latest: nonceLatest, pending: noncePending };
  if (!nonceLatest.ok || !noncePending.ok || nonceLatest.value !== "0x0" || noncePending.value !== "0x0") return abort("fresh account nonce is not 0");
  const code = await step("gen_getContractCode", () => reader.getContractCode(CONTRACT));
  const { createHash } = await import("node:crypto");
  const sha = code.ok ? createHash("sha256").update(code.value, "utf8").digest("hex") : null;
  pre.codeSha256 = sha;
  if (sha !== EXPECTED_CODE_SHA256) return abort("deployed code hash mismatch");
  const countFinal = await step("get_case_count final", () => readContract("get_case_count", [], "latest-final"));
  const countNonFinal = await step("get_case_count nonfinal", () => readContract("get_case_count", [], "latest-nonfinal"));
  pre.caseCount = { final: countFinal, nonFinal: countNonFinal };
  if (!countFinal.ok || !countNonFinal.ok || typeof countFinal.value !== "number" || countFinal.value !== countNonFinal.value) {
    return abort("case count unreadable, or a non-final change is pending");
  }
  const baseline = countFinal.value;
  const expectedCaseId = `VC-${String(baseline + 1).padStart(6, "0")}`;
  const simulation = await step("simulate create_case", () =>
    reader.simulateWriteContract({ account: { address: sender } as never, address: CONTRACT, functionName: "create_case", args: FICTIONAL_CASE_ARGS as never }),
  );
  pre.simulation = simulation;
  if (!simulation.ok || simulation.value !== expectedCaseId) return abort(`simulation did not return ${expectedCaseId}`);
  r.expectedCaseId = expectedCaseId;

  // --- 2. The single guarded write.
  const intent = buildWriteIntent({
    operationId: "stage-a-create-case",
    chain: studionetWriteParams(),
    sender,
    contractAddress: CONTRACT,
    method: "create_case",
    args: FICTIONAL_CASE_ARGS,
    expectedNonce: 0n,
  });
  r.intent = { to: intent.consensusAddress, selector: intent.selector, calldata: intent.calldata, txDataLeaderOnlyByte: intent.txData.slice(-2) };
  const session = new WriteSession();
  const guard = session.begin(intent);
  const account = createGuardedLocalAccount(
    { address: sender, signTransaction: (req) => local.signTransaction(req as never) as Promise<Hex> },
    guard,
    { hashSignedTransaction: (s) => keccak256(s) },
  );
  globalThis.fetch = createGuardedFetch(bounded, guard, { rpcUrl: RPC_URL });
  const writer = createClient({ chain: studionet, account } as unknown as ClientConfig);

  const submitStarted = elapsed();
  const outcome = await session.run(
    () => writer.writeContract({ address: CONTRACT, functionName: "create_case", args: FICTIONAL_CASE_ARGS as never, value: 0n }),
    { timeoutMs: SUBMIT_DEADLINE_MS, broadcastGuarded: true },
  );
  const snapshot = guard.snapshot();
  r.submission = {
    startedMs: submitStarted,
    finishedMs: elapsed(),
    outcome,
    phase: session.state.phase,
    journal: snapshot.journal,
    requestsForwarded: snapshot.requestsForwarded,
    refusals: snapshot.refusals,
    signedTransaction: snapshot.outbound?.signedTransaction ?? null,
    precomputedHash: snapshot.outbound?.hash ?? null,
    broadcast: snapshot.outbound?.broadcast ?? null,
    rawBroadcastCount: requestLog.filter((e) => e.method === "eth_sendRawTransaction").length,
  };
  save();
  console.log(emit(toJson({ submission: { outcome, phase: session.state.phase, rawBroadcastCount: (r.submission as { rawBroadcastCount: number }).rawBroadcastCount } })));

  // From here on: reads only. Writes are over whatever happened.
  const nonceAfter = async () => ({
    latest: await step("nonce latest", () => rpc("eth_getTransactionCount", [sender, "latest"])),
    pending: await step("nonce pending", () => rpc("eth_getTransactionCount", [sender, "pending"])),
  });

  if (outcome.kind !== "submitted") {
    // --- 3a. Read-only reconciliation, then stop.
    const hashes = knownHashes(snapshot);
    const lookups = [];
    for (const h of hashes) lookups.push(await step(`getTransaction ${h}`, () => reader.getTransaction({ hash: h as never })));
    r.reconciliation = {
      knownHashes: hashes,
      lookups,
      nonce: await nonceAfter(),
      partyCases: await step("get_party_case_ids", () => readContract("get_party_case_ids", [sender, 0n, 10n], "latest-nonfinal")),
      caseCountNonFinal: await step("get_case_count nonfinal", () => readContract("get_case_count", [], "latest-nonfinal")),
    };
    save();
    console.log(emit(toJson({ stopped: "outcome was not submitted; read-only reconciliation recorded" })));
    return;
  }

  // --- 3b. Monitor to finality (reads only).
  const txHash = outcome.txHash;
  const timeline: { atMs: number; category: string; statusName: string | null; resultName: string | null; final: boolean }[] = [];
  let lastTx: unknown = null;
  let finalView = null;
  const deadline = Date.now() + FINALITY_DEADLINE_MS;
  while (Date.now() < deadline) {
    const got = await step("getTransaction", () => reader.getTransaction({ hash: txHash as never }));
    if (got.ok && got.value) {
      lastTx = got.value;
      const view = classifyTransaction(got.value);
      const prev = timeline.at(-1);
      if (!prev || prev.category !== view.category || prev.statusName !== view.statusName) {
        timeline.push({ atMs: elapsed(), category: view.category, statusName: view.statusName, resultName: view.resultName, final: view.final });
        console.log(emit(`${Math.round(elapsed() / 1000)}s ${view.statusName ?? "?"} ${view.category}`));
      }
      if (view.final) {
        finalView = view;
        break;
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
  r.lifecycle = { txHash, timeline, finalView, finalityDeadlineMs: FINALITY_DEADLINE_MS };

  const tx = lastTx as Record<string, unknown> | null;
  const signed = snapshot.outbound?.signedTransaction ?? null;
  const storedSigned = (tx?.sim_config as { signed_rollup_transaction?: unknown } | undefined)?.signed_rollup_transaction ?? null;
  r.correlation = {
    rpcReturnedHash: snapshot.outbound?.broadcast?.hash ?? null,
    keccakOfSignedBytes: snapshot.outbound?.hash ?? null,
    genlayerHash: tx?.hash ?? null,
    genlayerTxId: tx?.tx_id ?? tx?.txId ?? null,
    storedSignedEqualsOurs: typeof storedSigned === "string" && typeof signed === "string" ? storedSigned.toLowerCase() === signed.toLowerCase() : null,
    sdkReturned: outcome.sdkResult ?? null,
    sdkNote: outcome.note,
    storedFrom: tx?.from_address ?? null,
    storedTo: tx?.to_address ?? null,
    storedRecipient: tx?.recipient ?? null,
  };
  r.nonceAfter = await nonceAfter();

  if (finalView?.category === "FINALIZED_SUCCESS") {
    session.apply({ type: "OBSERVED", category: "FINALIZED_SUCCESS", final: true });
    const count = await step("get_case_count final", () => readContract("get_case_count", [], "latest-final"));
    const kase = await step("get_case final", () => readContract("get_case", [expectedCaseId], "latest-final"));
    const party = await step("get_party_case_ids final", () => readContract("get_party_case_ids", [sender, 0n, 10n], "latest-final"));
    const c = (kase.ok ? kase.value : null) as Record<string, unknown> | null;
    const matches =
      count.ok && count.value === baseline + 1 && c !== null &&
      String(c.claimant).toLowerCase() === sender.toLowerCase() &&
      String(c.respondent).toLowerCase() === FICTIONAL_RESPONDENT.toLowerCase() &&
      c.title === FICTIONAL_CASE_ARGS[2] && c.category === "OTHER";
    r.postFinality = { count, case: kase, partyCaseIds: party, matchesIntent: matches };
    session.apply(matches ? { type: "VERIFIED" } : { type: "VERIFICATION_MISMATCH", message: "latest-final read does not match the intent" });
  } else if (finalView) {
    session.apply({ type: "OBSERVED", category: finalView.category, final: true });
  }
  r.finalPhase = session.state.phase;
  r.finalTx = tx;
  save();
  console.log(emit(toJson({ finalPhase: r.finalPhase, correlation: r.correlation, elapsedMs: elapsed(), requests: requestLog.length })));
}

main().catch((err: unknown) => {
  // Never print a stack or object: only the error name, to keep secrets out of output.
  console.error("stage A aborted:", (err as Error).name);
  process.exitCode = 1;
});
