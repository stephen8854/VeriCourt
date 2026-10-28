import { describe, expect, it } from "vitest";
import { MOCK_ACCOUNT as A, MOCK_ACCOUNT_2 as B } from "../test/mockProvider";
import { initialWalletState, walletReducer, walletStatusView, type WalletEvent, type WalletState } from "./walletState";

const STUDIO = "0xf22f";
const run = (events: WalletEvent[], start: WalletState = initialWalletState(true)) => events.reduce(walletReducer, start);
const passive = (op: number, chainId: unknown, accounts: unknown): WalletEvent[] => [
  { type: "READ_START", op, source: "passive" },
  { type: "READ_OK", op, source: "passive", raw: { chainId, accounts } },
];
const connect = (op: number, chainId: unknown, accounts: unknown): WalletEvent[] => [
  { type: "READ_START", op, source: "connect" },
  { type: "READ_OK", op, source: "connect", raw: { chainId, accounts } },
];
const connected = (chainId = STUDIO, account = A) => run(connect(1, chainId, [account]));

describe("initial states", () => {
  it("no provider is terminal for this page load", () => {
    const s = initialWalletState(false);
    expect(s.phase).toBe("no_provider");
    expect(walletReducer(s, { type: "READ_START", op: 1, source: "connect" })).toBe(s);
    expect(walletStatusView(s).headline).toBe("No compatible wallet detected");
  });

  it("empty eth_accounts: detected, not connected", () => {
    const s = run(passive(1, STUDIO, []));
    expect(s).toMatchObject({ phase: "not_connected", account: null, chainId: 61999 });
    expect(walletStatusView(s).headline).toBe("Wallet detected, not connected");
  });

  it("an already-shared account is shown after a passive read", () => {
    expect(run(passive(1, STUDIO, [A]))).toMatchObject({ phase: "connected", account: A });
  });
});

describe("explicit connection", () => {
  it("pending, then connected on StudioNet", () => {
    const pending = run([{ type: "READ_START", op: 1, source: "connect" }]);
    expect(walletStatusView(pending).headline).toBe("Waiting for your wallet…");
    const s = connected();
    expect(s).toMatchObject({ phase: "connected", account: A, chainId: 61999 });
    expect(walletStatusView(s)).toMatchObject({ headline: "Connected to StudioNet", readyForStudioNet: true, chainMatches: true });
  });

  it("connected on another chain is never ready for StudioNet", () => {
    const view = walletStatusView(connected("0x1"));
    expect(view).toMatchObject({ headline: "Connected, wrong network", tone: "warn", readyForStudioNet: false, chainMatches: false });
  });

  it("user rejection", () => {
    const s = run([{ type: "READ_START", op: 1, source: "connect" }, { type: "READ_FAILED", op: 1, source: "connect", error: { code: 4001 } }]);
    expect(s).toMatchObject({ phase: "rejected", account: null });
    expect(s.message).toMatch(/declined/);
  });

  it("provider error during the request", () => {
    const s = run([{ type: "READ_START", op: 1, source: "connect" }, { type: "READ_FAILED", op: 1, source: "connect", error: new Error("RPC down") }]);
    expect(s).toMatchObject({ phase: "provider_error", message: "RPC down" });
  });

  it("wallet shares no account", () => {
    expect(run(connect(1, STUDIO, []))).toMatchObject({ phase: "not_connected", message: "The wallet did not share any account." });
  });
});

describe("malformed data is never displayed", () => {
  it.each([[["0x123"]], ["0xabc"], [[A, 42]], [null]])("accounts %j", (accounts) => {
    const s = run(connect(1, STUDIO, accounts));
    expect(s).toMatchObject({ phase: "provider_error", account: null });
    expect(s.message).toMatch(/malformed account list/);
  });

  it.each([[61999], ["61999"], ["0xZZ"], [null]])("chain id %j", (chainId) => {
    const s = run(connect(1, chainId, [A]));
    expect(s).toMatchObject({ phase: "provider_error", account: null, chainId: null });
    expect(s.message).toMatch(/malformed chain ID/);
  });

  it("a passive read failure is a provider error", () => {
    const s = run([{ type: "READ_START", op: 1, source: "passive" }, { type: "READ_FAILED", op: 1, source: "passive", error: new Error("no") }]);
    expect(s.phase).toBe("provider_error");
  });
});

describe("events", () => {
  it("account change updates the account immediately and bumps the epoch", () => {
    const before = connected();
    const s = walletReducer(before, { type: "ACCOUNTS_CHANGED", op: 2, raw: [B] });
    expect(s).toMatchObject({ phase: "connected", account: B, lastChange: "account" });
    expect(s.accountEpoch).toBe(before.accountEpoch + 1);
  });

  it("chain change to another network marks the wallet incompatible immediately", () => {
    const before = connected();
    const s = walletReducer(before, { type: "CHAIN_CHANGED", op: 2, raw: "0x1" });
    expect(s).toMatchObject({ phase: "connected", chainId: 1, lastChange: "chain" });
    expect(walletStatusView(s).readyForStudioNet).toBe(false);
    expect(s.accountEpoch).toBe(before.accountEpoch + 1);
    // The confirming re-read with the same op is applied.
    expect(walletReducer(s, { type: "CHAIN_REREAD", op: 2, raw: STUDIO }).chainId).toBe(61999);
  });

  it("malformed event payloads become provider errors", () => {
    expect(walletReducer(connected(), { type: "CHAIN_CHANGED", op: 2, raw: 61999 }).phase).toBe("provider_error");
    expect(walletReducer(connected(), { type: "ACCOUNTS_CHANGED", op: 2, raw: "nope" }).phase).toBe("provider_error");
  });

  it("empty account list after connection: disconnected, account cleared", () => {
    const s = walletReducer(connected(), { type: "ACCOUNTS_CHANGED", op: 2, raw: [] });
    expect(s).toMatchObject({ phase: "disconnected", account: null, chainId: null });
    expect(walletStatusView(s).headline).toBe("Wallet disconnected");
  });

  it("empty account list on a later passive read also disconnects", () => {
    expect(run(passive(2, STUDIO, []), connected())).toMatchObject({ phase: "disconnected", account: null });
  });

  it("an account arriving before any chain was read waits for the chain", () => {
    const s = walletReducer(initialWalletState(true), { type: "ACCOUNTS_CHANGED", op: 1, raw: [A] });
    expect(s).toMatchObject({ phase: "checking", account: null });
  });

  it("provider disconnect event clears the account", () => {
    expect(walletReducer(connected(), { type: "PROVIDER_DISCONNECT", op: 2 })).toMatchObject({ phase: "provider_error", account: null });
  });
});

describe("stale results are ignored", () => {
  it("a slow passive read cannot overwrite a newer connection", () => {
    let s = run([{ type: "READ_START", op: 1, source: "passive" }]);
    s = run(connect(2, STUDIO, [A]), s);
    s = walletReducer(s, { type: "READ_OK", op: 1, source: "passive", raw: { chainId: "0x1", accounts: [] } });
    expect(s).toMatchObject({ phase: "connected", account: A, chainId: 61999 });
  });

  it("an event supersedes an in-flight read", () => {
    let s = run([{ type: "READ_START", op: 1, source: "passive" }]);
    s = walletReducer(s, { type: "CHAIN_CHANGED", op: 2, raw: "0x1" });
    s = walletReducer(s, { type: "READ_OK", op: 1, source: "passive", raw: { chainId: STUDIO, accounts: [A] } });
    expect(s.account).toBeNull();
    expect(s.chainId).toBe(1);
  });
});

describe("forget (app-side only)", () => {
  it("clears the account and ignores later passive reads and account events until the user connects again", () => {
    let s = walletReducer(connected(), { type: "FORGET", op: 2 });
    expect(s).toMatchObject({ phase: "not_connected", account: null, forgotten: true });
    s = run(passive(3, STUDIO, [A]), s);
    expect(s.account).toBeNull();
    s = walletReducer(s, { type: "ACCOUNTS_CHANGED", op: 4, raw: [B] });
    expect(s.account).toBeNull();
    s = run(connect(5, STUDIO, [A]), s);
    expect(s).toMatchObject({ phase: "connected", account: A, forgotten: false });
  });
});
