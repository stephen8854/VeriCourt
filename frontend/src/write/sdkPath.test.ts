/**
 * Drives the REAL genlayer-js 1.1.8 `writeContract` through the guards.
 * Network: none. The global `fetch` the SDK transport calls is replaced by an
 * in-memory JSON-RPC responder (setup.ts makes any real network use throw).
 * Keys: none. The wallet is a fake; the signer returns dummy-signature bytes.
 */
import { createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONTRACT,
  PRE_SEND_READS,
  RPC_URL,
  SENDER,
  TX_HASH,
  fakeRpc,
  fakeSigner,
  fakeWallet,
  testIntent,
} from "../test/writeHarness";
import { ADD_TRANSACTION_V5_SELECTOR } from "./addTransaction";
import { WriteGuard } from "./guard";
import { createGuardedLocalAccount } from "./guardedAccount";
import { createGuardedFetch } from "./guardedFetch";
import { createGuardedProvider } from "./guardedProvider";
import { runGuardedWrite } from "./runner";

type ClientChain = NonNullable<NonNullable<Parameters<typeof createClient>[0]>["chain"]>;
type ClientConfig = NonNullable<Parameters<typeof createClient>[0]>;
const chain = studionet as unknown as ClientChain;
const ARGS = ["VC-FICTIONAL-1"];

// The SDK logs its own warnings on failure paths; keep test output readable.
beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

function walletWrite(walletOptions: Parameters<typeof fakeWallet>[0] = {}) {
  const intent = testIntent({ args: ARGS });
  const guard = new WriteGuard(intent);
  const wallet = fakeWallet(walletOptions);
  const rpc = fakeRpc(PRE_SEND_READS);
  vi.stubGlobal("fetch", rpc.fetch);
  const client = createClient({ chain, account: SENDER, provider: createGuardedProvider(wallet, guard) } as unknown as ClientConfig);
  const submit = () => client.writeContract({ address: CONTRACT, functionName: "request_assessment", args: ARGS, value: 0n });
  return { intent, guard, wallet, rpc, submit };
}

describe("real SDK, wallet path (Stage B shape)", () => {
  it("the SDK's request matches the intent byte for byte and is forwarded once", async () => {
    const { intent, guard, wallet, rpc, submit } = walletWrite();
    const { outcome, snapshot } = await runGuardedWrite(guard, submit, { timeoutMs: 5_000, broadcastGuarded: false });
    expect(outcome).toEqual({ kind: "submitted", txHash: TX_HASH, sdkResult: TX_HASH, note: null });
    expect(wallet.sends).toHaveLength(1);
    const sent = wallet.sends[0]![0] as Record<string, string>;
    expect(sent.data).toBe(intent.calldata);
    expect(sent.data?.slice(0, 10)).toBe(ADD_TRANSACTION_V5_SELECTOR);
    expect(sent.to).toBe(studionet.consensusMainContract?.address);
    expect(sent).toMatchObject({ from: SENDER, chainId: "0xf22f", gasPrice: "0x0", type: "0x0", value: "0x0", nonce: "0x0" });
    // eth_chainId and eth_accounts were the guard's own pre-send reads; the SDK did not check the chain itself.
    expect(wallet.methods()).toEqual(["eth_chainId", "eth_accounts", "eth_sendTransaction"]);
    expect(rpc.methods()).toEqual(["eth_getTransactionCount", "eth_estimateGas", "eth_gasPrice"]);
    expect(snapshot).toMatchObject({ requestsForwarded: 1, refusals: 0, armed: false });
  });

  it("the SDK's V6 fallback never reaches the wallet", async () => {
    // A wallet error containing a phrase genlayer-js treats as an ABI mismatch makes it
    // re-encode with V6 and call eth_sendTransaction again (dist/index.js 1191-1198).
    const { guard, wallet, rpc, submit } = walletWrite({
      send: () => ({ error: { code: -32603, message: "execution reverted: could not decode" } }),
    });
    const { outcome, snapshot } = await runGuardedWrite(guard, submit, { timeoutMs: 5_000, broadcastGuarded: false });
    expect(wallet.sends).toHaveLength(1);
    // The fallback did happen inside the SDK: it estimated gas again, then was refused by the guard.
    expect(rpc.methods()).toEqual(["eth_getTransactionCount", "eth_estimateGas", "eth_gasPrice", "eth_estimateGas", "eth_gasPrice"]);
    const refused = snapshot.journal.filter((e) => e.event === "refused");
    expect(refused).toHaveLength(1);
    expect(refused[0]!.detail).toMatch(/already made its one transaction request; refused request selector 0x/);
    expect(refused[0]!.detail).not.toContain(ADD_TRANSACTION_V5_SELECTOR);
    // The first request left the guard and failed with a non-rejection error: sending is not ruled out.
    expect(outcome).toEqual({ kind: "uncertain", reason: "wallet_error_after_forward", knownHash: null });
  });

  it("a user rejection is reported as rejected and does not trigger a second prompt", async () => {
    const { guard, wallet, submit } = walletWrite({ send: () => ({ error: { code: 4001, message: "User rejected the request." } }) });
    const { outcome } = await runGuardedWrite(guard, submit, { timeoutMs: 5_000, broadcastGuarded: false });
    expect(outcome).toEqual({ kind: "rejected" });
    expect(wallet.sends).toHaveLength(1);
  });

  it("a wallet on the wrong chain is refused before any prompt (the SDK skips this check on Studio)", async () => {
    const { guard, wallet, submit } = walletWrite({ chainId: "0x1" });
    const { outcome } = await runGuardedWrite(guard, submit, { timeoutMs: 5_000, broadcastGuarded: false });
    expect(outcome.kind).toBe("not_sent");
    expect(wallet.sends).toHaveLength(0);
  });

  it("a different function or argument from the SDK is refused", async () => {
    const intent = testIntent({ args: ARGS });
    const guard = new WriteGuard(intent);
    const wallet = fakeWallet();
    vi.stubGlobal("fetch", fakeRpc(PRE_SEND_READS).fetch);
    const client = createClient({ chain, account: SENDER, provider: createGuardedProvider(wallet, guard) } as unknown as ClientConfig);
    const { outcome } = await runGuardedWrite(
      guard,
      () => client.writeContract({ address: CONTRACT, functionName: "request_assessment", args: ["VC-SOMETHING-ELSE"], value: 0n }),
      { timeoutMs: 5_000, broadcastGuarded: false },
    );
    expect(outcome.kind).toBe("not_sent");
    expect(wallet.sends).toHaveLength(0);
  });
});

function signerWrite(rpcOverrides: Parameters<typeof fakeRpc>[0] = {}, signerBehaviour: Parameters<typeof fakeSigner>[1] = "ok") {
  const intent = testIntent({ args: ARGS });
  const guard = new WriteGuard(intent);
  const signer = fakeSigner(SENDER, signerBehaviour);
  const account = createGuardedLocalAccount(signer, guard);
  const rpc = fakeRpc({
    ...PRE_SEND_READS,
    eth_sendRawTransaction: () => ({ result: TX_HASH }),
    eth_blockNumber: () => ({ result: "0x10" }),
    eth_getTransactionReceipt: () => ({ result: receipt() }),
    ...rpcOverrides,
  });
  vi.stubGlobal("fetch", createGuardedFetch(rpc.fetch, guard, { rpcUrl: RPC_URL }));
  const client = createClient({ chain, account } as unknown as ClientConfig);
  const submit = () => client.writeContract({ address: CONTRACT, functionName: "request_assessment", args: ARGS, value: 0n });
  return { intent, guard, signer, rpc, submit };
}

/** A successful EVM receipt with no logs: what StudioNet returns here is unknown (Stage A). */
function receipt() {
  return {
    blockHash: `0x${"11".repeat(32)}`,
    blockNumber: "0x10",
    contractAddress: null,
    cumulativeGasUsed: "0x0",
    effectiveGasPrice: "0x0",
    from: SENDER,
    gasUsed: "0x0",
    logs: [],
    logsBloom: `0x${"00".repeat(256)}`,
    status: "0x1",
    to: studionet.consensusMainContract?.address,
    transactionHash: TX_HASH,
    transactionIndex: "0x0",
    type: "0x0",
  };
}

describe("real SDK, local-account path (Stage A shape)", () => {
  it("signs once, broadcasts once, and reports the RPC hash even when the SDK then throws", async () => {
    const { intent, guard, signer, rpc, submit } = signerWrite();
    const { outcome, snapshot } = await runGuardedWrite(guard, submit, { timeoutMs: 20_000, broadcastGuarded: true });
    expect(signer.calls).toHaveLength(1);
    expect(signer.calls[0]).toMatchObject({ to: studionet.consensusMainContract?.address, data: intent.calldata, gasPrice: 0n, chainId: 61999, type: "legacy" });
    expect(rpc.methods().filter((m) => m === "eth_sendRawTransaction")).toHaveLength(1);
    expect(snapshot.outbound?.broadcast).toMatchObject({ state: "hash", hash: TX_HASH });
    // With no NewTransaction/CreatedTransaction log the SDK throws after sending (dist/index.js 1140-1145).
    expect(outcome).toMatchObject({ kind: "submitted", txHash: TX_HASH, sdkResult: null });
    expect((outcome as { note: string }).note).toMatch(/SDK threw after the broadcast/);
  }, 30_000);

  it("the SDK's V6 fallback cannot produce a second signed transaction", async () => {
    const { guard, signer, rpc, submit } = signerWrite({
      eth_sendRawTransaction: () => ({ error: { code: -32000, message: "could not decode input" } }),
    });
    const { outcome, snapshot } = await runGuardedWrite(guard, submit, { timeoutMs: 5_000, broadcastGuarded: true });
    expect(signer.calls).toHaveLength(1);
    expect(rpc.methods().filter((m) => m === "eth_sendRawTransaction")).toHaveLength(1);
    expect(snapshot.journal.filter((e) => e.event === "refused")).toHaveLength(1);
    expect(snapshot.journal.find((e) => e.event === "refused")?.method).toBe("signTransaction");
    expect(outcome).toEqual({ kind: "uncertain", reason: "broadcast_rpc_error", knownHash: null });
  });

  it("a non-zero gas price from the RPC stops the write before signing", async () => {
    const { signer, rpc, guard, submit } = signerWrite({ eth_gasPrice: () => ({ result: "0x3b9aca00" }) });
    const { outcome } = await runGuardedWrite(guard, submit, { timeoutMs: 5_000, broadcastGuarded: true });
    expect(outcome.kind).toBe("not_sent");
    expect(signer.calls).toHaveLength(0);
    expect(rpc.methods()).not.toContain("eth_sendRawTransaction");
  });

  it("a nonce read failure stops the write before anything is signed", async () => {
    const { signer, guard, submit } = signerWrite({ eth_getTransactionCount: () => ({ error: { code: -32000, message: "unavailable" } }) });
    const { outcome } = await runGuardedWrite(guard, submit, { timeoutMs: 5_000, broadcastGuarded: true });
    expect(outcome.kind).toBe("not_sent");
    expect(signer.calls).toHaveLength(0);
  });
});
