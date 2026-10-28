import { describe, expect, it } from "vitest";
import { OTHER, SENDER, TX_HASH, deferred, fakeWallet, sdkLikeSendParams, testIntent } from "../test/writeHarness";
import { GUARD_REFUSED_CODE, GuardRefusal, WriteGuard } from "./guard";
import { GuardMalformedResponse, createGuardedProvider } from "./guardedProvider";

function setup(walletOptions: Parameters<typeof fakeWallet>[0] = {}, intent = testIntent()) {
  const wallet = fakeWallet(walletOptions);
  const guard = new WriteGuard(intent);
  const provider = createGuardedProvider(wallet, guard);
  const send = (params: unknown = sdkLikeSendParams(intent)) =>
    provider.request({ method: "eth_sendTransaction", params: params as unknown[] });
  return { wallet, guard, provider, send, intent };
}

describe("guarded provider: the one permitted request", () => {
  it("forwards a matching request once and records the hash", async () => {
    const { wallet, guard, send } = setup();
    await expect(send()).resolves.toBe(TX_HASH);
    expect(wallet.sends).toHaveLength(1);
    expect(wallet.methods()).toEqual(["eth_chainId", "eth_accounts", "eth_sendTransaction"]);
    const snap = guard.snapshot();
    expect(snap.requestsForwarded).toBe(1);
    expect(snap.outbound).toMatchObject({ channel: "wallet", state: "hash", hash: TX_HASH, settledAfterDisarm: false });
  });

  it("forwards a copy of the checked params, not the caller's object", async () => {
    const { wallet, send, intent } = setup();
    const params = sdkLikeSendParams(intent);
    await send(params);
    expect(wallet.sends[0]![0]).toEqual(params[0]);
    expect(wallet.sends[0]![0]).not.toBe(params[0]);
  });

  it("passes passive reads through without using the permit", async () => {
    const { guard, provider } = setup();
    await expect(provider.request({ method: "eth_chainId" })).resolves.toBe("0xf22f");
    await expect(provider.request({ method: "eth_accounts" })).resolves.toEqual([SENDER]);
    expect(guard.isArmed).toBe(true);
  });
});

describe("guarded provider: duplicates and late requests", () => {
  it("refuses a second sequential request without contacting the wallet", async () => {
    const { wallet, guard, send } = setup();
    await send();
    const second = send();
    await expect(second).rejects.toBeInstanceOf(GuardRefusal);
    await expect(second).rejects.toMatchObject({ code: GUARD_REFUSED_CODE });
    expect(wallet.sends).toHaveLength(1);
    expect(guard.snapshot()).toMatchObject({ requestsForwarded: 1, refusals: 1 });
  });

  it("a concurrent duplicate (double click) is refused and closes the operation before anything is sent", async () => {
    const { wallet, guard, send } = setup();
    const first = send();
    const second = send();
    await expect(second).rejects.toBeInstanceOf(GuardRefusal);
    // Fail closed: the first request was still in its pre-send checks, so it is not forwarded either.
    await expect(first).rejects.toThrow(/closed before the request was forwarded/);
    expect(wallet.sends).toHaveLength(0);
    expect(guard.snapshot()).toMatchObject({ requestsForwarded: 0, refusals: 2 });
  });

  it("a duplicate arriving after the first request was forwarded cannot reach the wallet", async () => {
    const pending = deferred<unknown>();
    const { wallet, send } = setup({ send: () => ({ pending: pending.promise }) });
    const first = send();
    await new Promise((r) => setTimeout(r, 0));
    expect(wallet.sends).toHaveLength(1);
    await expect(send()).rejects.toBeInstanceOf(GuardRefusal);
    pending.resolve(TX_HASH);
    await expect(first).resolves.toBe(TX_HASH);
    expect(wallet.sends).toHaveLength(1);
  });

  it("refuses a late request after a timeout disarmed the guard", async () => {
    const { wallet, guard, send } = setup();
    guard.disarm("application deadline passed");
    await expect(send()).rejects.toThrow(/closed \(application deadline passed\)/);
    expect(wallet.methods()).toEqual([]);
  });

  it("does not forward when the guard is disarmed during the pre-send wallet reads", async () => {
    const gate = deferred<unknown>();
    const wallet = fakeWallet();
    const intent = testIntent();
    const guard = new WriteGuard(intent);
    const slow = {
      request: async (args: { method: string; params?: unknown[] }) => {
        if (args.method === "eth_chainId") await gate.promise;
        return wallet.request(args);
      },
    };
    const provider = createGuardedProvider(slow, guard);
    const sending = provider.request({ method: "eth_sendTransaction", params: sdkLikeSendParams(intent) });
    guard.disarm("application deadline passed");
    gate.resolve(undefined);
    await expect(sending).rejects.toBeInstanceOf(GuardRefusal);
    expect(wallet.sends).toHaveLength(0);
    expect(guard.snapshot().requestsForwarded).toBe(0);
  });

  it("records a late wallet result that arrives after the guard was disarmed", async () => {
    const pending = deferred<unknown>();
    const { guard, send } = setup({ send: () => ({ pending: pending.promise }) });
    const sending = send();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    guard.disarm("application deadline passed");
    expect(guard.snapshot().outbound?.state).toBe("in_flight");
    pending.resolve(TX_HASH);
    await sending;
    expect(guard.snapshot().outbound).toMatchObject({ state: "hash", hash: TX_HASH, settledAfterDisarm: true });
  });
});

describe("guarded provider: wallet responses", () => {
  it("records a 4001 rejection and rethrows it", async () => {
    const { guard, send } = setup({ send: () => ({ error: { code: 4001, message: "User rejected" } }) });
    await expect(send()).rejects.toMatchObject({ code: 4001 });
    expect(guard.snapshot().outbound).toMatchObject({ state: "rejected", errorCode: 4001 });
  });

  it("records any other wallet error as 'error' (sending not ruled out)", async () => {
    const { guard, send } = setup({ send: () => ({ error: { code: -32603, message: "Internal error" } }) });
    await expect(send()).rejects.toMatchObject({ code: -32603 });
    expect(guard.snapshot().outbound).toMatchObject({ state: "error", errorCode: -32603 });
  });

  it.each([["a short hash", "0x1234"], ["an object", { hash: TX_HASH }], ["undefined", undefined], ["an unprefixed hash", "cd".repeat(32)]])(
    "treats %s as malformed and throws",
    async (_name, result) => {
      const { guard, send } = setup({ send: () => ({ result }) });
      await expect(send()).rejects.toBeInstanceOf(GuardMalformedResponse);
      expect(guard.snapshot().outbound?.state).toBe("malformed");
    },
  );
});

describe("guarded provider: request checks (refused before the wallet sees anything)", () => {
  const intent = testIntent();
  const otherContractIntent = testIntent({ args: ["VC-OTHER"] });
  const cases: [string, unknown, RegExp][] = [
    ["an unexpected target (`to`)", sdkLikeSendParams(intent, { to: "0x0000000000000000000000000000000000000000" }), /`to` is not the expected consensus contract/],
    ["an unexpected selector (V6 fallback style)", sdkLikeSendParams(intent, { data: `0x12345678${intent.calldata.slice(10)}` }), /unexpected selector 0x12345678/],
    ["the wrong sender in `from`", sdkLikeSendParams(intent, { from: OTHER }), /`from` is not the approved account/],
    ["a different call", sdkLikeSendParams(intent, { data: otherContractIntent.calldata }), /not the approved request_assessment call/],
    ["a chainId parameter for another chain", sdkLikeSendParams(intent, { chainId: "0x1" }), /`chainId` parameter/],
    ["a non-zero value", sdkLikeSendParams(intent, { value: "0x1" }), /`value` must be zero/],
    ["a non-zero gas price", sdkLikeSendParams(intent, { gasPrice: "0x3b9aca00" }), /gasless/],
    ["two transaction objects", [...sdkLikeSendParams(intent), ...sdkLikeSendParams(intent)], /one transaction object/],
    ["an empty params array", [], /one transaction object/],
  ];

  it.each(cases)("refuses %s", async (_name, params, reason) => {
    const { wallet, guard, send } = setup({}, intent);
    await expect(send(params)).rejects.toThrow(reason);
    expect(wallet.methods()).toEqual([]);
    expect(guard.snapshot()).toMatchObject({ requestsForwarded: 0, refusals: 1, armed: false });
  });

  it("refuses when the wallet is on the wrong chain", async () => {
    const { wallet, send } = setup({ chainId: "0x1" });
    await expect(send()).rejects.toThrow(/not on the expected chain/);
    expect(wallet.sends).toHaveLength(0);
  });

  it.each([["another account", [OTHER, SENDER]], ["no account", []], ["malformed accounts", "x"]])(
    "refuses when the wallet's selected account is %s",
    async (_name, accounts) => {
      const { wallet, send } = setup({ accounts });
      await expect(send()).rejects.toThrow(/selected account is not the approved account/);
      expect(wallet.sends).toHaveLength(0);
    },
  );

  it("refuses a nonce other than the pre-checked one", async () => {
    const pinned = testIntent({ expectedNonce: 4n });
    const { wallet, send } = setup({}, pinned);
    await expect(send(sdkLikeSendParams(pinned, { nonce: "0x5" }))).rejects.toThrow(/pre-checked nonce/);
    expect(wallet.sends).toHaveLength(0);
  });

  it("a refused request closes the operation: a corrected retry is also refused", async () => {
    const { wallet, send, intent: i } = setup();
    await expect(send(sdkLikeSendParams(i, { to: SENDER }))).rejects.toBeInstanceOf(GuardRefusal);
    await expect(send()).rejects.toThrow(/closed/);
    expect(wallet.sends).toHaveLength(0);
  });

  it.each(["eth_requestAccounts", "eth_signTransaction", "personal_sign", "eth_sign", "eth_signTypedData_v4", "wallet_switchEthereumChain", "wallet_addEthereumChain", "eth_sendRawTransaction"])(
    "refuses %s",
    async (method) => {
      const { wallet, provider } = setup();
      await expect(provider.request({ method })).rejects.toBeInstanceOf(GuardRefusal);
      expect(wallet.methods()).toEqual([]);
    },
  );
});

describe("journal hygiene", () => {
  it("records no request bodies, only public metadata", async () => {
    const { guard, send, intent } = setup({ send: () => ({ error: { code: 4001, message: "secret-looking text" } }) });
    await send().catch(() => undefined);
    const text = JSON.stringify(guard.snapshot(), (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
    expect(text).not.toContain(intent.calldata.slice(12, 200));
    expect(text).not.toContain("secret-looking text");
  });

  it("refusal messages avoid the SDK's fallback trigger phrases", async () => {
    // genlayer-js 1.1.8 isAddTransactionAbiMismatchError (dist/index.js 1069).
    const triggers = ["invalid pointer", "could not decode", "invalid arrayify value", "types/value length mismatch"];
    const { send, intent } = setup();
    const errors: unknown[] = [];
    for (const params of [sdkLikeSendParams(intent, { to: SENDER }), sdkLikeSendParams(intent)]) {
      await send(params).catch((e: unknown) => errors.push(e));
    }
    for (const e of errors) {
      const text = `${(e as Error).message} ${JSON.stringify(e)}`.toLowerCase();
      for (const t of triggers) expect(text).not.toContain(t);
    }
  });
});
