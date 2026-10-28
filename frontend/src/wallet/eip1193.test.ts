import { describe, expect, it } from "vitest";
import { MOCK_ACCOUNT, mockProvider } from "../test/mockProvider";
import {
  ALLOWED_WALLET_METHODS,
  classifyProviderError,
  getInjectedProvider,
  interpretAccounts,
  interpretChainId,
  isExpectedChain,
  readWalletRaw,
  requestWalletRaw,
  shortAddress,
  subscribeToWallet,
} from "./eip1193";

describe("provider detection", () => {
  it("never assumes window.ethereum exists", () => {
    expect(getInjectedProvider({})).toBeNull();
    expect(getInjectedProvider(undefined)).toBeNull();
    expect(getInjectedProvider({ ethereum: null })).toBeNull();
    expect(getInjectedProvider({ ethereum: {} })).toBeNull();
    expect(getInjectedProvider({ ethereum: { request: "not a function" } })).toBeNull();
    const throwing = Object.defineProperty({}, "ethereum", {
      get() {
        throw new Error("blocked");
      },
    });
    expect(getInjectedProvider(throwing)).toBeNull();
    const p = mockProvider();
    expect(getInjectedProvider({ ethereum: p })).toBe(p);
  });
});

describe("validation", () => {
  it.each([
    ["0xf22f", { ok: true, chainId: 61999 }],
    ["0xF22F", { ok: true, chainId: 61999 }],
    ["0x1", { ok: true, chainId: 1 }],
  ])("chain id %s is valid", (raw, expected) => {
    expect(interpretChainId(raw)).toEqual(expected);
  });

  it.each([[61999], ["61999"], ["0x"], ["0xZZ"], ["f22f"], [null], [undefined], [{}], ["0x0"], [`0x${"f".repeat(20)}`]])(
    "chain id %j is malformed",
    (raw) => {
      expect(interpretChainId(raw).ok).toBe(false);
    },
  );

  it("unsupported (valid but different) chains are not StudioNet", () => {
    expect(isExpectedChain(61999)).toBe(true);
    expect(isExpectedChain(1)).toBe(false);
  });

  it("accounts: only an array of addresses is accepted; nothing is silently dropped", () => {
    expect(interpretAccounts([])).toEqual({ ok: true, accounts: [] });
    expect(interpretAccounts([MOCK_ACCOUNT])).toEqual({ ok: true, accounts: [MOCK_ACCOUNT] });
    expect(interpretAccounts([MOCK_ACCOUNT, "0x123"]).ok).toBe(false);
    expect(interpretAccounts(["not an address"]).ok).toBe(false);
    expect(interpretAccounts(MOCK_ACCOUNT).ok).toBe(false);
    expect(interpretAccounts(null).ok).toBe(false);
    expect(interpretAccounts([`${MOCK_ACCOUNT}00`]).ok).toBe(false);
  });

  it("malformed values are clipped for display", () => {
    const result = interpretChainId("x".repeat(500));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.raw.length).toBeLessThanOrEqual(61);
  });

  it("shortens addresses for display", () => {
    expect(shortAddress(MOCK_ACCOUNT)).toBe("0x1a1a…1a1a");
  });
});

describe("provider calls", () => {
  it("passive read uses eth_chainId and eth_accounts only; explicit request uses eth_requestAccounts", async () => {
    const p = mockProvider("0x1", []);
    expect(await readWalletRaw(p)).toEqual({ chainId: "0x1", accounts: [] });
    expect(p.methods()).toEqual(["eth_chainId", "eth_accounts"]);
    expect(await requestWalletRaw(p)).toEqual({ chainId: "0x1", accounts: [MOCK_ACCOUNT] });
    expect(p.methods()).toEqual(["eth_chainId", "eth_accounts", "eth_requestAccounts", "eth_chainId"]);
    for (const m of p.methods()) expect(ALLOWED_WALLET_METHODS).toContain(m);
  });

  it("classifies provider errors", () => {
    expect(classifyProviderError({ code: 4001 }).kind).toBe("rejected");
    expect(classifyProviderError({ code: -32002 }).kind).toBe("pending");
    expect(classifyProviderError(new Error("boom"))).toEqual({ kind: "other", message: "boom" });
    expect(classifyProviderError(undefined).message).toBe("The wallet returned an error.");
  });
});

describe("event subscription", () => {
  it("registers one listener per event and removes exactly those", () => {
    const p = mockProvider();
    const sub = subscribeToWallet(p, { onAccountsChanged: () => undefined, onChainChanged: () => undefined, onDisconnect: () => undefined });
    expect(sub.supported).toBe(true);
    for (const e of ["accountsChanged", "chainChanged", "disconnect"]) expect(p.listenerCount(e)).toBe(1);
    sub.unsubscribe();
    sub.unsubscribe(); // idempotent
    for (const e of ["accountsChanged", "chainChanged", "disconnect"]) expect(p.listenerCount(e)).toBe(0);
    expect(p.removeListener).toHaveBeenCalledTimes(3);
  });

  it("forwards payloads", () => {
    const p = mockProvider();
    const seen: unknown[] = [];
    subscribeToWallet(p, { onAccountsChanged: (a) => seen.push(a), onChainChanged: (c) => seen.push(c), onDisconnect: () => seen.push("disc") });
    p.emit("accountsChanged", [MOCK_ACCOUNT]);
    p.emit("chainChanged", "0x1");
    p.emit("disconnect", { code: 4900 });
    expect(seen).toEqual([[MOCK_ACCOUNT], "0x1", "disc"]);
  });

  it("reports providers without event support instead of inventing behaviour", () => {
    const sub = subscribeToWallet({ request: async () => null }, { onAccountsChanged: () => undefined, onChainChanged: () => undefined, onDisconnect: () => undefined });
    expect(sub.supported).toBe(false);
    expect(() => sub.unsubscribe()).not.toThrow();
  });
});
