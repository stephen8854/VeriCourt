import { describe, expect, it } from "vitest";
import { initialWalletState, walletReducer } from "../wallet/walletState";
import { PHASE_2_17C_NO_REPLY } from "./testDeployments";
import { EXPERIMENT_CONTRACTS, WRITE_EXPERIMENT_ACK, WRITE_EXPERIMENT_MODE, evaluateWriteGate, type WriteGateInput } from "./writeGate";

const OK: WriteGateInput = { mode: WRITE_EXPERIMENT_MODE, ack: WRITE_EXPERIMENT_ACK, contract: PHASE_2_17C_NO_REPLY.address, hostname: "127.0.0.1" };

describe("write experiment gate", () => {
  it("enables only when every condition holds", () => {
    expect(evaluateWriteGate(OK)).toEqual({ enabled: true, contract: PHASE_2_17C_NO_REPLY.address });
    for (const host of ["localhost", "[::1]"]) expect(evaluateWriteGate({ ...OK, hostname: host }).enabled).toBe(true);
  });

  it("the ordinary production build is disabled", () => {
    const g = evaluateWriteGate({ mode: "production", ack: undefined, contract: undefined, hostname: "vericourt.example" });
    expect(g.enabled).toBe(false);
    expect(g.enabled === false && g.reasons).toHaveLength(4);
  });

  it.each<[string, Partial<WriteGateInput>, RegExp]>([
    ["ordinary mode", { mode: "production" }, /not a write-experiment build/],
    ["development mode", { mode: "development" }, /not a write-experiment build/],
    ["no acknowledgement", { ack: undefined }, /acknowledgement phrase/],
    ["a near-miss acknowledgement", { ack: WRITE_EXPERIMENT_ACK.toLowerCase() }, /acknowledgement phrase/],
    ["acknowledgement with spaces", { ack: ` ${WRITE_EXPERIMENT_ACK}` }, /acknowledgement phrase/],
    ["no contract", { contract: undefined }, /not a known throwaway test deployment/],
    ["an arbitrary contract", { contract: `0x${"12".repeat(20)}` }, /not a known throwaway test deployment/],
    ["a deployed host", { hostname: "vericourt.example" }, /not served from this machine/],
    ["a LAN address", { hostname: "192.168.1.20" }, /not served from this machine/],
    ["no host", { hostname: undefined }, /not served from this machine/],
    ["the ordinary flag flipped", { ordinaryWritesFlag: true }, /must stay false/],
  ])("stays disabled with %s", (_name, patch, reason) => {
    const g = evaluateWriteGate({ ...OK, ...patch });
    expect(g.enabled).toBe(false);
    expect(g.enabled === false && g.reasons.join("; ")).toMatch(reason);
  });

  it("accepts the test contract in any letter case but reports the canonical address", () => {
    expect(evaluateWriteGate({ ...OK, contract: PHASE_2_17C_NO_REPLY.address.toLowerCase() })).toEqual({ enabled: true, contract: PHASE_2_17C_NO_REPLY.address });
  });

  it("only throwaway test deployments are writable", () => {
    expect(EXPERIMENT_CONTRACTS).toEqual([PHASE_2_17C_NO_REPLY.address]);
  });

  it("the test run itself is not an experiment build", () => {
    expect(import.meta.env.MODE).not.toBe(WRITE_EXPERIMENT_MODE);
  });
});

describe("explicit wallet connection (required for writes)", () => {
  const A = `0x${"1a".repeat(20)}`;
  const B = `0x${"2b".repeat(20)}`;
  const raw = (accounts: string[]) => ({ chainId: "0xf22f", accounts });

  it("a passive read on load does not count", () => {
    const s = walletReducer(walletReducer(initialWalletState(true), { type: "READ_START", op: 1, source: "passive" }), { type: "READ_OK", op: 1, source: "passive", raw: raw([A]) });
    expect(s).toMatchObject({ phase: "connected", account: A, explicitConnection: false });
  });

  it("Connect grants it; a later passive re-check of the same account keeps it", () => {
    let s = walletReducer(walletReducer(initialWalletState(true), { type: "READ_START", op: 1, source: "connect" }), { type: "READ_OK", op: 1, source: "connect", raw: raw([A]) });
    expect(s.explicitConnection).toBe(true);
    s = walletReducer(walletReducer(s, { type: "READ_START", op: 2, source: "passive" }), { type: "READ_OK", op: 2, source: "passive", raw: raw([A]) });
    expect(s.explicitConnection).toBe(true);
    expect(walletReducer(s, { type: "CHAIN_CHANGED", op: 3, raw: "0xf22f" }).explicitConnection).toBe(true);
  });

  it.each([
    ["switching account in the wallet", { type: "ACCOUNTS_CHANGED", op: 9, raw: [B] }],
    ["the wallet disconnecting", { type: "PROVIDER_DISCONNECT", op: 9 }],
    ["Forget", { type: "FORGET", op: 9 }],
    ["the account list emptying", { type: "ACCOUNTS_CHANGED", op: 9, raw: [] }],
  ] as const)("is lost on %s", (_name, event) => {
    const s = walletReducer(walletReducer(initialWalletState(true), { type: "READ_START", op: 1, source: "connect" }), { type: "READ_OK", op: 1, source: "connect", raw: raw([A]) });
    expect(walletReducer(s, event).explicitConnection).toBe(false);
  });

  // Phase 3.6 live-test finding: many wallets emit accountsChanged / chainChanged WHILE
  // eth_requestAccounts is resolving. The event supersedes the Connect read, which used
  // to discard the Connect result, so the grant was never recorded.
  type Ev = Parameters<typeof walletReducer>[1];
  const run = (events: Ev[]) => events.reduce(walletReducer, initialWalletState(true));
  const MIXED = "0x16fD571ae717F92b5e43597d813267C8d15f105A"; // EIP-55 checksummed, mixed case
  const connectStart: Ev = { type: "READ_START", op: 1, source: "connect" };
  const connectResult = (accounts = [A]): Ev => ({ type: "READ_OK", op: 1, source: "connect", raw: raw(accounts) });
  const passive = (op: number, accounts = [A]): Ev[] => [
    { type: "READ_START", op, source: "passive" },
    { type: "READ_OK", op, source: "passive", raw: raw(accounts) },
  ];

  it.each<[string, Ev[]]>([
    [
      "accountsChanged during Connect (chain unknown), Connect result, then the follow-up passive read",
      [connectStart, { type: "ACCOUNTS_CHANGED", op: 2, raw: [A] }, connectResult(), ...passive(3)],
    ],
    [
      "accountsChanged during Connect (chain unknown), follow-up passive read, then the Connect result",
      [connectStart, { type: "ACCOUNTS_CHANGED", op: 2, raw: [A] }, ...passive(3), connectResult()],
    ],
    [
      "accountsChanged during Connect when the chain is already known",
      [{ type: "CHAIN_CHANGED", op: 0, raw: "0xf22f" }, connectStart, { type: "ACCOUNTS_CHANGED", op: 2, raw: [A] }, connectResult()],
    ],
    [
      "chainChanged during Connect, then the follow-up passive read",
      [connectStart, { type: "CHAIN_CHANGED", op: 2, raw: "0xf22f" }, connectResult(), ...passive(3)],
    ],
    [
      // As seen live: the wallet showed the operator's address in lowercase.
      "Connect returns the checksummed address but the wallet reports it in lowercase",
      [connectStart, { type: "ACCOUNTS_CHANGED", op: 2, raw: [MIXED.toLowerCase()] }, connectResult([MIXED]), ...passive(3, [MIXED.toLowerCase()])],
    ],
    [
      "Connect returns lowercase but the wallet then reports the checksummed address",
      [{ type: "CHAIN_CHANGED", op: 0, raw: "0xf22f" }, connectStart, { type: "ACCOUNTS_CHANGED", op: 2, raw: [MIXED] }, connectResult([MIXED.toLowerCase()])],
    ],
  ])("is granted when %s", (_name, events) => {
    const s = run(events);
    expect(s.phase).toBe("connected");
    expect(s.explicitConnection).toBe(true);
  });

  it.each<[string, Ev[]]>([
    ["only a passive read happened", [...passive(1)]],
    [
      "an event switched to a DIFFERENT account during Connect",
      [{ type: "CHAIN_CHANGED", op: 0, raw: "0xf22f" }, connectStart, { type: "ACCOUNTS_CHANGED", op: 2, raw: [B] }, connectResult([A])],
    ],
    [
      "Connect returned A but the wallet now shows B",
      [connectStart, { type: "ACCOUNTS_CHANGED", op: 2, raw: [B] }, connectResult([A]), ...passive(3, [B])],
    ],
    [
      "the user switched away to B and back to A after Connect",
      [connectStart, connectResult(), { type: "ACCOUNTS_CHANGED", op: 2, raw: [B] }, { type: "ACCOUNTS_CHANGED", op: 3, raw: [A] }],
    ],
    [
      "Connect returned a malformed account list",
      [connectStart, { type: "ACCOUNTS_CHANGED", op: 2, raw: [A] }, connectResult(["0x123"]), ...passive(3)],
    ],
    [
      "Forget came after the Connect result",
      [connectStart, connectResult(), { type: "FORGET", op: 2 }, ...passive(3)],
    ],
    [
      "the wallet disconnected after the Connect result",
      [connectStart, connectResult(), { type: "PROVIDER_DISCONNECT", op: 2 }, ...passive(3)],
    ],
  ])("is NOT granted when %s", (_name, events) => {
    expect(run(events).explicitConnection).toBe(false);
  });

  it("a Connect result arriving after Forget records no grant", () => {
    const s = run([connectStart, { type: "FORGET", op: 2 }, connectResult()]);
    expect(s.connectGrant).toBeNull();
    expect(s.explicitConnection).toBe(false);
  });

  it("a fresh page (reload) starts without it", () => {
    expect(initialWalletState(true).explicitConnection).toBe(false);
  });
});
