import { describe, expect, it, vi } from "vitest";
import { OTHER, RPC_URL, TX_HASH, deferred, fakeRpc, fakeSerialize, fakeSigner, sdkLikeSignRequest, testIntent } from "../test/writeHarness";
import type { Hex } from "./bytes";
import { GuardRefusal, WriteGuard } from "./guard";
import { createGuardedLocalAccount } from "./guardedAccount";
import { READ_METHODS, createGuardedFetch } from "./guardedFetch";

function setup(behaviour: Parameters<typeof fakeSigner>[1] = "ok", intent = testIntent()) {
  const signer = fakeSigner(intent.sender, behaviour);
  const guard = new WriteGuard(intent);
  const account = createGuardedLocalAccount(signer, guard);
  return { signer, guard, account, intent };
}

describe("guarded local account", () => {
  it("signs the approved request once and records the released bytes", async () => {
    const { signer, guard, account, intent } = setup();
    const bytes = await account.signTransaction(sdkLikeSignRequest(intent));
    expect(signer.calls).toHaveLength(1);
    expect(guard.snapshot().outbound).toMatchObject({ channel: "signer", state: "signed", signedTransaction: bytes, hash: null });
  });

  it("never passes the SDK's account object (or anything extra) to the signer", async () => {
    const { signer, account, intent } = setup();
    await account.signTransaction({ ...sdkLikeSignRequest(intent), extra: "x" });
    expect(Object.keys(signer.calls[0]!).sort()).toEqual(["chainId", "data", "gas", "gasPrice", "nonce", "to", "type", "value"]);
  });

  it("exposes only public fields and refusing stubs", async () => {
    const { account, signer } = setup();
    expect(Object.keys(account).sort()).toEqual(["address", "sign", "signMessage", "signTransaction", "signTypedData", "source", "type"]);
    expect(Object.isFrozen(account)).toBe(true);
    await expect(account.signMessage()).rejects.toBeInstanceOf(GuardRefusal);
    await expect(account.signTypedData()).rejects.toBeInstanceOf(GuardRefusal);
    expect(signer.calls).toHaveLength(0);
  });

  it("records the transaction hash when a hasher is supplied", async () => {
    const intent = testIntent();
    const guard = new WriteGuard(intent);
    const hasher = vi.fn((): Hex => TX_HASH);
    const account = createGuardedLocalAccount(fakeSigner(intent.sender), guard, { hashSignedTransaction: hasher });
    const bytes = await account.signTransaction(sdkLikeSignRequest(intent));
    expect(hasher).toHaveBeenCalledExactlyOnceWith(bytes);
    expect(guard.snapshot().outbound?.hash).toBe(TX_HASH);
  });

  it("refuses to wrap a signer for a different sender", () => {
    expect(() => createGuardedLocalAccount(fakeSigner(OTHER), new WriteGuard(testIntent()))).toThrow(/not the intent's sender/);
  });

  it("refuses a second signature (the SDK's V6 fallback) without calling the signer", async () => {
    const { signer, guard, account, intent } = setup();
    await account.signTransaction(sdkLikeSignRequest(intent));
    const v6Like = sdkLikeSignRequest(intent, { data: `0xabcdef01${intent.calldata.slice(10)}00` });
    await expect(account.signTransaction(v6Like)).rejects.toThrow(/already made its one transaction request; refused request selector 0xabcdef01/);
    expect(signer.calls).toHaveLength(1);
    expect(guard.snapshot()).toMatchObject({ requestsForwarded: 1, refusals: 1 });
  });

  const intent = testIntent();
  it.each([
    ["an unexpected target", sdkLikeSignRequest(intent, { to: "0x0000000000000000000000000000000000000000" }), /`to`/],
    ["an unexpected selector", sdkLikeSignRequest(intent, { data: `0x12345678${intent.calldata.slice(10)}` }), /unexpected selector/],
    ["the wrong chain", sdkLikeSignRequest(intent, { chainId: 1 }), /`chainId`/],
    ["a non-legacy type", sdkLikeSignRequest(intent, { type: "eip1559" }), /legacy/],
    ["a non-zero gas price", sdkLikeSignRequest(intent, { gasPrice: 1n }), /gasless/],
    ["a non-zero value", sdkLikeSignRequest(intent, { value: 1n }), /`value`/],
    ["absurd gas", sdkLikeSignRequest(intent, { gas: 10n ** 12n }), /`gas`/],
    ["no nonce", sdkLikeSignRequest(intent, { nonce: undefined }), /`nonce`/],
  ])("refuses %s before signing", async (_name, request, reason) => {
    const { signer, guard, account } = setup("ok", intent);
    await expect(account.signTransaction(request)).rejects.toThrow(reason);
    expect(signer.calls).toHaveLength(0);
    expect(guard.snapshot().requestsForwarded).toBe(0);
  });

  it("refuses a different sender's call data", async () => {
    const theirs = testIntent({ sender: OTHER });
    const { signer, account } = setup("ok", intent);
    await expect(account.signTransaction(sdkLikeSignRequest(intent, { data: theirs.calldata }))).rejects.toThrow(/_sender/);
    expect(signer.calls).toHaveLength(0);
  });

  it("withholds signed bytes that differ from the approved request", async () => {
    const { guard, account, intent: i } = setup("tamper");
    await expect(account.signTransaction(sdkLikeSignRequest(i))).rejects.toThrow(/signed nonce differs; the bytes were withheld/);
    expect(guard.snapshot().outbound).toMatchObject({ state: "withheld", signedTransaction: null });
  });

  it("records a signer failure as nothing released", async () => {
    const { guard, account, intent: i } = setup("throw");
    await expect(account.signTransaction(sdkLikeSignRequest(i))).rejects.toThrow(/nothing was released/);
    expect(guard.snapshot().outbound).toMatchObject({ state: "error", errorCode: "SIGNER" });
  });

  it("withholds the bytes if the operation closes while signing", async () => {
    const gate = deferred<undefined>();
    const i = testIntent();
    const guard = new WriteGuard(i);
    const account = createGuardedLocalAccount(
      { address: i.sender, signTransaction: async (r) => { await gate.promise; return fakeSerialize(r); } },
      guard,
    );
    const signing = account.signTransaction(sdkLikeSignRequest(i));
    guard.disarm("application deadline passed");
    gate.resolve(undefined);
    await expect(signing).rejects.toThrow(/closed while signing/);
    expect(guard.snapshot().outbound?.state).toBe("withheld");
  });
});

describe("guarded fetch (broadcast layer)", () => {
  const body = (method: string, params: unknown[] = []) => ({ method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });

  async function signedSetup(rpcReply: { result: unknown } | { error: unknown } = { result: TX_HASH }) {
    const { guard, account, intent } = setup();
    const bytes = await account.signTransaction(sdkLikeSignRequest(intent));
    const rpc = fakeRpc({ eth_sendRawTransaction: () => rpcReply, eth_chainId: () => ({ result: "0xf22f" }) });
    const guarded = createGuardedFetch(rpc.fetch, guard, { rpcUrl: RPC_URL });
    return { guard, bytes, rpc, guarded };
  }

  it("broadcasts the signed bytes once and records the RPC hash", async () => {
    const { guard, bytes, rpc, guarded } = await signedSetup();
    const res = await guarded(RPC_URL, body("eth_sendRawTransaction", [bytes]));
    expect(((await res.json()) as { result: unknown }).result).toBe(TX_HASH);
    expect(guard.snapshot().outbound?.broadcast).toMatchObject({ state: "hash", hash: TX_HASH });
    await expect(guarded(RPC_URL, body("eth_sendRawTransaction", [bytes]))).rejects.toThrow(/already broadcast once/);
    expect(rpc.methods()).toEqual(["eth_sendRawTransaction"]);
  });

  it("refuses to broadcast bytes this operation did not sign", async () => {
    const { rpc, guarded } = await signedSetup();
    await expect(guarded(RPC_URL, body("eth_sendRawTransaction", ["0xc0"]))).rejects.toThrow(/differ from the transaction this operation signed/);
    expect(rpc.methods()).toEqual([]);
  });

  it("refuses a broadcast when nothing was signed", async () => {
    const guard = new WriteGuard(testIntent());
    const rpc = fakeRpc({});
    const guarded = createGuardedFetch(rpc.fetch, guard, { rpcUrl: RPC_URL });
    await expect(guarded(RPC_URL, body("eth_sendRawTransaction", ["0xc0"]))).rejects.toThrow(/no transaction signed/);
    expect(rpc.methods()).toEqual([]);
  });

  it("refuses a broadcast after the operation was closed (signed but never sent)", async () => {
    const { guard, bytes, rpc, guarded } = await signedSetup();
    guard.disarm("application deadline passed");
    await expect(guarded(RPC_URL, body("eth_sendRawTransaction", [bytes]))).rejects.toThrow(/closed/);
    expect(rpc.methods()).toEqual([]);
  });

  it("records an explicit RPC error response", async () => {
    const { guard, bytes, guarded } = await signedSetup({ error: { code: -32000, message: "nonce too low" } });
    await guarded(RPC_URL, body("eth_sendRawTransaction", [bytes]));
    expect(guard.snapshot().outbound?.broadcast).toMatchObject({ state: "rpc_error", errorCode: -32000 });
  });

  it("records a transport failure (no response) and rethrows it", async () => {
    const { guard, account, intent } = setup();
    const bytes = await account.signTransaction(sdkLikeSignRequest(intent));
    const guarded = createGuardedFetch(async () => { throw new TypeError("fetch failed"); }, guard, { rpcUrl: RPC_URL });
    await expect(guarded(RPC_URL, body("eth_sendRawTransaction", [bytes]))).rejects.toThrow("fetch failed");
    expect(guard.snapshot().outbound?.broadcast?.state).toBe("transport_error");
  });

  it("records a malformed RPC reply", async () => {
    const { guard, bytes, guarded } = await signedSetup({ result: "0x12" });
    await guarded(RPC_URL, body("eth_sendRawTransaction", [bytes]));
    expect(guard.snapshot().outbound?.broadcast?.state).toBe("malformed");
  });

  it("passes allowlisted reads through and keeps the permit", async () => {
    const { guard, rpc, guarded } = await signedSetup();
    await guarded(RPC_URL, body("eth_chainId"));
    expect(rpc.methods()).toEqual(["eth_chainId"]);
    expect(guard.snapshot().refusals).toBe(0);
  });

  it.each(["eth_sendTransaction", "sim_fundAccount", "sim_cancelTransaction", "eth_sign", "personal_sign"])("refuses %s", async (method) => {
    const { rpc, guarded } = await signedSetup();
    await expect(guarded(RPC_URL, body(method))).rejects.toBeInstanceOf(GuardRefusal);
    expect(rpc.methods()).toEqual([]);
  });

  it("refuses other URLs, batches and non-POST requests", async () => {
    const { rpc, guarded } = await signedSetup();
    await expect(guarded("https://example.invalid/", body("eth_chainId"))).rejects.toThrow(/other than the configured RPC/);
    await expect(guarded(RPC_URL, { method: "POST", body: JSON.stringify([{ method: "eth_chainId" }]) })).rejects.toThrow(/batch/);
    await expect(guarded(RPC_URL, { method: "GET" })).rejects.toThrow(/POST/);
    expect(rpc.methods()).toEqual([]);
  });

  it("the read allowlist contains no sending or signing method", () => {
    for (const m of READ_METHODS) expect(m).not.toMatch(/send|sign|fund|cancel|sim_/i);
  });
});
