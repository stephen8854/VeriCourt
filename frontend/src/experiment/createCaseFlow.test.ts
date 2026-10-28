/**
 * End-to-end tests of the Phase 3.5C write flow: the REAL genlayer-js 1.1.8
 * writeContract, the guarded provider, the durable session (storage + lock),
 * status monitoring and reconciliation. Everything external is in memory: the
 * wallet is a fake, the RPC is an in-memory responder, storage is a Map.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateWriteGate } from "../config/writeGate";
import { CONNECTED, ENABLED_GATE, fakeStudio, makeDeps, txWithStatus } from "../test/experimentHarness";
import { CONTRACT, OTHER, SENDER, TX_HASH, deferred, eventfulWallet, fakeStorage } from "../test/writeHarness";
import { decodeAddTransactionV5 } from "../write/addTransaction";
import { DurableWriteSession, WriteOutcomeNotRecorded, WriteRefused } from "../write/durableSession";
import { PENDING_KEY, PendingStore, parseRecord } from "../write/pendingStore";
import { memoryLock } from "../write/writeLock";
import { fictionalCase } from "./ExperimentWritePanel";
import {
  PreflightFailed,
  flowBlockers,
  monitorToFinality,
  reconcileUncertain,
  statusMessage,
  submitCreateCase,
  type FlowPreconditions,
} from "./createCaseFlow";

const INPUT = fictionalCase("2026-10-18T00:00:00");
const PRE: FlowPreconditions = { gate: ENABLED_GATE, wallet: CONNECTED, input: INPUT, acknowledged: true };

function stored(storage: ReturnType<typeof fakeStorage>) {
  const p = parseRecord(storage.data.get(PENDING_KEY) ?? "");
  if (!p.ok) throw new Error(p.reason);
  return p.record;
}

async function setup(opts: { studio?: Parameters<typeof fakeStudio>[0]; wallet?: Parameters<typeof eventfulWallet>[0]; storage?: ReturnType<typeof fakeStorage>; lock?: ReturnType<typeof memoryLock> } = {}) {
  const storage = opts.storage ?? fakeStorage();
  const lock = opts.lock ?? memoryLock();
  const studio = fakeStudio(opts.studio);
  const wallet = eventfulWallet({
    send: () => {
      studio.accept(INPUT);
      return { result: TX_HASH };
    },
    ...opts.wallet,
  });
  const session = await DurableWriteSession.open(new PendingStore(storage), lock);
  const { deps, rpc, advance } = makeDeps(session, wallet, studio);
  return { storage, lock, studio, wallet, session, deps, rpc, advance };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("happy path", () => {
  it("one wallet request, then finality, then a latest-final read confirms the case: verified", async () => {
    const { storage, studio, wallet, session, deps, rpc } = await setup();
    const { outcome, simulatedCaseId } = await submitCreateCase(deps, PRE);
    expect(simulatedCaseId).toBe("VC-000003");
    expect(outcome).toMatchObject({ kind: "submitted", txHash: TX_HASH });
    expect(wallet.sends).toHaveLength(1);
    expect(rpc.methods()).toEqual(["eth_getTransactionCount", "eth_estimateGas", "eth_gasPrice"]);

    const result = await monitorToFinality(deps);
    expect(result.kind).toBe("verified");
    expect(session.state?.phase).toBe("verified");
    expect(stored(storage).tx.note).toMatch(new RegExp(`Transaction ${TX_HASH} finalized and a latest-final read shows VC-\\d{6}`));
    expect(studio.calls.filter((c) => c === "getTransaction")).toHaveLength(3);
    const msg = statusMessage(session.current);
    expect(msg).toMatchObject({ tone: "ok", headline: "Case created and confirmed" });
  });

  it("the request the wallet receives is exactly the one the guard checked (sender, contract, nonce, calldata)", async () => {
    const { wallet, deps } = await setup({ studio: { nonce: 7 } });
    vi.stubGlobal("fetch", (await import("../test/writeHarness")).fakeRpc({
      eth_getTransactionCount: () => ({ result: "0x7" }),
      eth_estimateGas: () => ({ result: "0x7a120" }),
      eth_gasPrice: () => ({ result: "0x0" }),
    }).fetch);
    await submitCreateCase(deps, PRE);
    const sent = wallet.sends[0]![0] as Record<string, string>;
    expect(sent).toMatchObject({ from: SENDER, nonce: "0x7", chainId: "0xf22f", gasPrice: "0x0", value: "0x0" });
    const args = decodeAddTransactionV5(sent.data)!;
    expect(args.sender).toBe(SENDER.toLowerCase());
    expect(args.recipient).toBe(CONTRACT.toLowerCase());
  });

  it("a nonce that differs between preflight and the SDK's own read is refused before the wallet", async () => {
    const { wallet, deps } = await setup({ studio: { nonce: 7 } }); // SDK's in-memory RPC reports nonce 0
    const { outcome } = await submitCreateCase(deps, PRE);
    expect(outcome.kind).toBe("not_sent");
    expect(wallet.sends).toHaveLength(0);
  });
});

describe("preconditions (nothing is requested or recorded)", () => {
  it.each<[string, Partial<FlowPreconditions>, RegExp]>([
    ["the gate is off", { gate: evaluateWriteGate({ mode: "production", ack: undefined, contract: undefined, hostname: "example.com" }) }, /Writes are off/],
    ["the wallet is not explicitly connected", { wallet: { ...CONNECTED, explicitConnection: false } }, /Press Connect/],
    ["the wallet is not connected", { wallet: { ...CONNECTED, phase: "not_connected", account: null } }, /Connect your wallet/],
    ["the wallet is on another chain", { wallet: { ...CONNECTED, chainId: 1 } }, /chain ID 61999/],
    ["the case fields are invalid", { input: { ...INPUT, title: "abc" } }, /Case details/],
    ["the respondent is the sender", { input: { ...INPUT, respondent: SENDER } }, /different addresses/],
    ["the user did not acknowledge", { acknowledged: false }, /acknowledgement/],
  ])("refuses when %s", async (_name, patch, reason) => {
    const { storage, wallet, deps } = await setup();
    await expect(submitCreateCase(deps, { ...PRE, ...patch })).rejects.toThrow(reason);
    expect(wallet.methods()).toEqual([]);
    expect(storage.data.has(PENDING_KEY)).toBe(false);
  });

  it("flowBlockers lists every unmet condition", () => {
    const b = flowBlockers({ gate: ENABLED_GATE, wallet: { phase: "not_connected", account: null, chainId: null, explicitConnection: false }, input: INPUT, acknowledged: false });
    expect(b.join(" ")).toMatch(/Connect your wallet.*StudioNet.*acknowledgement/);
  });
});

describe("fresh preflight under the cross-tab lock", () => {
  it.each<[string, Parameters<typeof fakeStudio>[0], RegExp]>([
    ["the RPC is another chain", { overrides: { chainId: async () => "0x1" } }, /RPC is not StudioNet/],
    ["gas is not free", { overrides: { gasPrice: async () => "0x1" } }, /gas price is not 0/],
    ["the contract code differs", { overrides: { getContractCode: async () => "something else" } }, /code does not match/],
    ["the simulation fails", { overrides: { simulateCreateCase: async () => { throw new Error("UserError"); } } }, /preflight check failed/],
    ["a read times out", { overrides: { getTransactionCount: () => new Promise(() => undefined) } }, /no response within/],
  ])("refuses, with nothing recorded or sent, when %s", async (_name, studioOpts, reason) => {
    const { storage, wallet, deps, lock } = await setup({ studio: studioOpts });
    await expect(submitCreateCase(deps, PRE)).rejects.toThrow(reason);
    expect(wallet.sends).toHaveLength(0);
    expect(storage.data.has(PENDING_KEY)).toBe(false);
    expect(lock.held()).toBe(false);
  });

  it("refuses when the account already has a pending transaction (latest != pending nonce)", async () => {
    let n = 0;
    const { wallet, deps, storage } = await setup({ studio: { overrides: { getTransactionCount: async () => (++n === 1 ? "0x3" : "0x4") } } });
    await expect(submitCreateCase(deps, PRE)).rejects.toThrow(/pending transaction/);
    expect(wallet.sends).toHaveLength(0);
    expect(storage.data.has(PENDING_KEY)).toBe(false);
  });

  it("refuses when the wallet's own account differs from the connected one", async () => {
    const { wallet, deps } = await setup({ wallet: { accounts: [OTHER] } });
    await expect(submitCreateCase(deps, PRE)).rejects.toThrow(/selected account is not the connected account/);
    expect(wallet.sends).toHaveLength(0);
  });

  it("the preflight runs while the lock is held: another tab cannot start meanwhile", async () => {
    const lock = memoryLock();
    const storage = fakeStorage();
    let otherTab: Promise<unknown> | null = null;
    const { deps, wallet } = await setup({
      storage,
      lock,
      studio: {
        overrides: {
          chainId: async () => {
            const b = await DurableWriteSession.open(new PendingStore(storage), lock);
            otherTab = b.begin({ ...(await import("../test/writeHarness")).testIntent({ operationId: "other-tab" }) }, { expectedEffect: null, baselinePartyCaseCount: null, nonceBefore: null });
            return "0xf22f";
          },
        },
      },
    });
    await submitCreateCase(deps, PRE);
    await expect(otherTab).rejects.toThrow(/another tab/);
    expect(wallet.sends).toHaveLength(1);
  });
});

describe("failure modes during the write", () => {
  it("wallet rejection: rejected, one prompt only", async () => {
    const { wallet, session, deps } = await setup({ wallet: { send: () => ({ error: { code: 4001, message: "User rejected" } }) } });
    expect((await submitCreateCase(deps, PRE)).outcome.kind).toBe("rejected");
    expect(wallet.sends).toHaveLength(1);
    expect(statusMessage(session.current)?.headline).toBe("You rejected the request");
  });

  it("the SDK's V6 fallback never reaches the wallet; outcome uncertain; blocked", async () => {
    const { wallet, session, deps } = await setup({ wallet: { send: () => ({ error: { code: -32603, message: "execution reverted: could not decode" } }) } });
    expect((await submitCreateCase(deps, PRE)).outcome.kind).toBe("uncertain");
    expect(wallet.sends).toHaveLength(1);
    expect(session.current?.guard?.refusals).toBe(1);
    await expect(submitCreateCase(deps, PRE)).rejects.toBeInstanceOf(WriteRefused);
  });

  it("disconnect before the forward: not sent", async () => {
    const gate = deferred<undefined>();
    const { wallet, deps } = await setup();
    const slow = {
      ...wallet,
      request: async (a: { method: string; params?: unknown[] }) => {
        if (a.method === "eth_chainId" && (deps.wallet as unknown as { armed?: boolean }).armed) await gate.promise;
        return wallet.request(a);
      },
    };
    deps.wallet = slow;
    // Arm the stall only for the guard's own pre-send read (after the preflight).
    const realBegin = deps.session.beginWithPreflight.bind(deps.session);
    deps.session.beginWithPreflight = async (pf) => {
      const g = await realBegin(pf);
      (slow as unknown as { armed: boolean }).armed = true;
      setTimeout(() => {
        wallet.emit("disconnect");
        gate.resolve(undefined);
      }, 0);
      return g;
    };
    const { outcome } = await submitCreateCase(deps, PRE);
    expect(outcome.kind).toBe("not_sent");
    expect(wallet.sends).toHaveLength(0);
  });

  it("an account change after the forward cannot withdraw it; the result is still followed", async () => {
    const prompt = deferred<unknown>();
    const { wallet, session, deps, studio } = await setup({ wallet: { send: () => ({ pending: prompt.promise }) } });
    const run = submitCreateCase(deps, PRE);
    await vi.waitFor(() => expect(wallet.sends).toHaveLength(1));
    wallet.emit("accountsChanged", [OTHER]);
    studio.accept(INPUT);
    prompt.resolve(TX_HASH);
    expect((await run).outcome.kind).toBe("submitted");
    expect(session.current?.guard?.journal.some((e) => /account changed/.test(e.detail))).toBe(true);
    expect((await monitorToFinality(deps)).kind).toBe("verified");
  });

  it("malformed wallet response: uncertain; a reload keeps it blocked; never auto-cleared", async () => {
    const storage = fakeStorage();
    const { session, deps } = await setup({ storage, wallet: { send: () => ({ result: "not-a-hash" }) } });
    expect((await submitCreateCase(deps, PRE)).outcome).toMatchObject({ kind: "uncertain", reason: "malformed_wallet_response" });
    const reloaded = await DurableWriteSession.open(new PendingStore(storage), memoryLock());
    expect(reloaded.state?.phase).toBe("submission_uncertain");
    expect(() => reloaded.reset()).toThrow();
    expect(statusMessage(reloaded.current)?.recovery.join(" ")).toMatch(/Do not try the write again/);
    expect(session.blockedReason).toMatch(/unresolved/);
  });

  it("double click: a second submission while the first runs is refused; one wallet request", async () => {
    const prompt = deferred<unknown>();
    const studioRef: { accept?: () => void } = {};
    const { wallet, deps, studio } = await setup({
      wallet: {
        send: () => {
          studioRef.accept?.();
          return { pending: prompt.promise };
        },
      },
    });
    studioRef.accept = () => studio.accept(INPUT);
    const first = submitCreateCase(deps, PRE);
    const second = submitCreateCase(deps, PRE);
    await expect(second).rejects.toBeInstanceOf(WriteRefused);
    await vi.waitFor(() => expect(wallet.sends).toHaveLength(1));
    prompt.resolve(TX_HASH);
    expect((await first).outcome.kind).toBe("submitted");
    expect(wallet.sends).toHaveLength(1);
  });

  it("timeout with the prompt open: uncertain (not failed); the late hash then reconciles, and monitoring verifies", async () => {
    const prompt = deferred<unknown>();
    const { wallet, session, deps, studio } = await setup({ wallet: { send: () => ({ pending: prompt.promise }) } });
    deps.timing = { ...deps.timing, submitTimeoutMs: 50 };
    expect((await submitCreateCase(deps, PRE)).outcome).toMatchObject({ kind: "uncertain", reason: "timeout_while_wallet_open" });
    expect(statusMessage(session.current)?.body).toMatch(/not proof that the write failed/);
    studio.accept(INPUT);
    prompt.resolve(TX_HASH);
    await vi.waitFor(() => expect(session.current?.guard?.outbound?.hash).toBe(TX_HASH));
    expect((await reconcileUncertain(deps)).kind).toBe("found");
    expect((await monitorToFinality(deps)).kind).toBe("verified");
    expect(wallet.sends).toHaveLength(1);
  });

  it("the write-ahead save fails: nothing is sent", async () => {
    const storage = fakeStorage();
    storage.fail.setOnlyWhen = (v) => v.includes('"state":"in_flight"');
    const { wallet, deps } = await setup({ storage });
    expect((await submitCreateCase(deps, PRE)).outcome.kind).toBe("not_sent");
    expect(wallet.sends).toHaveLength(0);
  });

  it("the record is removed from storage mid-operation: the tab refuses any further write, even with storage empty", async () => {
    const storage = fakeStorage();
    const { wallet, session, deps } = await setup({
      storage,
      wallet: {
        send: () => {
          storage.data.delete(PENDING_KEY); // e.g. someone cleared site data too early
          return { result: TX_HASH };
        },
      },
    });
    await expect(submitCreateCase(deps, PRE)).rejects.toBeInstanceOf(WriteOutcomeNotRecorded);
    expect(storage.data.has(PENDING_KEY)).toBe(false); // nothing on disk would block…
    await expect(submitCreateCase(deps, PRE)).rejects.toThrow(/blocked in this tab/); // …but this tab does
    expect(session.blockedReason).toMatch(/blocked in this tab/);
    expect(wallet.sends).toHaveLength(1);
  });

  it("storage fails after the send: the outcome is reported unrecorded, the tab is blocked, a reload shows uncertain", async () => {
    const storage = fakeStorage();
    const { wallet, session, deps } = await setup({
      storage,
      wallet: {
        send: () => {
          storage.fail.set = true; // every later save fails
          return { result: TX_HASH };
        },
      },
    });
    await expect(submitCreateCase(deps, PRE)).rejects.toBeInstanceOf(WriteOutcomeNotRecorded);
    expect(wallet.sends).toHaveLength(1);
    expect(session.blockedReason).toMatch(/blocked in this tab/);
    storage.fail.set = false;
    const reloaded = await DurableWriteSession.open(new PendingStore(storage), memoryLock());
    expect(reloaded.state?.phase).toBe("submission_uncertain"); // last saved: forwarded, no result
  });
});

describe("monitoring and reconciliation (read-only)", () => {
  it("finality deadline passes: timed_out_unknown (uncertain, not failed); resumes after reconciliation", async () => {
    const { session, deps } = await setup({ studio: { timeline: ["PENDING"] } });
    await submitCreateCase(deps, PRE);
    deps.timing = { ...deps.timing, finalityDeadlineMs: 25_000 };
    expect((await monitorToFinality(deps)).kind).toBe("timed_out");
    expect(session.state?.phase).toBe("timed_out_unknown");
    expect(statusMessage(session.current)?.headline).toBe("The outcome is not known yet");
    expect((await reconcileUncertain(deps)).kind).toBe("found");
    expect(session.state?.phase).toBe("submitted");
  });

  it("repeated read failures: read_failure (uncertain)", async () => {
    const { session, deps } = await setup({ studio: { overrides: {} } });
    await submitCreateCase(deps, PRE);
    deps.reader = { ...deps.reader, getTransaction: async () => { throw new Error("rpc down"); } };
    expect((await monitorToFinality(deps)).kind).toBe("read_failure");
    expect(session.state?.phase).toBe("read_failure");
  });

  it("finalized with validator disagreement: finalized_unsuccessful, never success", async () => {
    const { session, deps } = await setup({ studio: { timeline: ["FINALIZED"], finalResult: "MAJORITY_DISAGREE", createsCase: false } });
    await submitCreateCase(deps, PRE);
    expect((await monitorToFinality(deps)).kind).toBe("finalized_unsuccessful");
    expect(session.state?.phase).toBe("finalized_unsuccessful");
  });

  it("finalized but no matching case at latest-final: verification_mismatch, never success", async () => {
    const { session, deps } = await setup({ studio: { createsCase: false } });
    await submitCreateCase(deps, PRE);
    expect((await monitorToFinality(deps)).kind).toBe("verification_mismatch");
    expect(session.state?.phase).toBe("verification_mismatch");
  });

  it("the confirming read fails: stays finalized (blocking), and a later resume verifies", async () => {
    const { session, deps } = await setup();
    await submitCreateCase(deps, PRE);
    const realRead = deps.reader.readContract;
    deps.reader = { ...deps.reader, readContract: async () => { throw new Error("rpc down"); } };
    expect((await monitorToFinality(deps)).kind).toBe("verification_unavailable");
    expect(session.state?.phase).toBe("finalized");
    expect(session.blockedReason).toMatch(/unresolved/);
    deps.reader = { ...deps.reader, readContract: realRead };
    expect((await monitorToFinality(deps)).kind).toBe("verified");
  });

  it("two matching cases after the baseline: not verified (ambiguous evidence), stays finalized", async () => {
    const { session, deps, studio } = await setup();
    await submitCreateCase(deps, PRE);
    // Two cases after the baseline match the intent (the fake will not add a third with the same title).
    for (const id of ["VC-000098", "VC-000099"]) studio.finalCases.push({ case_id: id, claimant: SENDER, respondent: INPUT.respondent, title: INPUT.title });
    const r = await monitorToFinality(deps);
    expect(r).toMatchObject({ kind: "verification_unavailable", detail: expect.stringMatching(/more than one matching case/) });
    expect(session.state?.phase).toBe("finalized");
  });

  it("a reload during monitoring resumes from the stored record", async () => {
    const storage = fakeStorage();
    const { deps, studio, wallet } = await setup({ storage });
    await submitCreateCase(deps, PRE);
    const reloaded = await DurableWriteSession.open(new PendingStore(storage), memoryLock());
    expect(reloaded.state?.phase).toBe("submitted");
    const { deps: deps2 } = makeDeps(reloaded, wallet, studio);
    expect((await monitorToFinality(deps2)).kind).toBe("verified");
  });

  it("an accepted transaction later reported as disputed is treated as unknown (read_failure), not success", async () => {
    const { session, deps } = await setup({ studio: { timeline: ["ACCEPTED", "ACCEPTED"] } });
    await submitCreateCase(deps, PRE);
    let n = 0;
    const real = deps.reader.getTransaction;
    deps.reader = { ...deps.reader, getTransaction: async (h) => (++n === 2 ? txWithStatus("ACCEPTED", TX_HASH, "MAJORITY_DISAGREE") : real(h)) };
    expect((await monitorToFinality(deps)).kind).toBe("read_failure");
    expect(session.state?.phase).toBe("read_failure");
  });

  it("no transaction ID, but the intended case is final in contract state: confirmed_by_state (limited evidence)", async () => {
    const { session, deps, studio } = await setup({ wallet: { send: () => ({ result: "garbage" }) } });
    await submitCreateCase(deps, PRE);
    studio.finalizeCaseOnly(INPUT);
    expect((await reconcileUncertain(deps)).kind).toBe("effect_final");
    expect(session.state).toMatchObject({ phase: "confirmed_by_state", txHash: null });
    const msg = statusMessage(session.current)!;
    expect(msg.headline).toBe("Case confirmed by contract state (limited evidence)");
    expect(msg.body).toMatch(/transaction itself was never identified/);
  });

  it("no positive evidence: the block stays (never auto-cleared)", async () => {
    const { session, deps } = await setup({ wallet: { send: () => ({ result: "garbage" }) } });
    await submitCreateCase(deps, PRE);
    expect((await reconcileUncertain(deps)).kind).toBe("unresolved");
    expect((await reconcileUncertain(deps)).kind).toBe("unresolved");
    expect(session.state?.phase).toBe("submission_uncertain");
    expect(session.current?.reconciliations).toHaveLength(2);
    await expect(submitCreateCase(deps, PRE)).rejects.toThrow(/unresolved/);
  });
});

describe("the experiment module's own request surface", () => {
  it("never names eth_sendTransaction or signing methods, and only reads eth_chainId / eth_accounts from the wallet", () => {
    const dir = join(process.cwd(), "src", "experiment");
    for (const f of ["createCaseFlow.ts", "sdkExperiment.ts", "ExperimentWritePanel.tsx"]) {
      // Code only: comments may name the methods they explain.
      const text = readFileSync(join(dir, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(text, f).not.toMatch(/eth_sendTransaction|eth_sign|personal_sign|signTypedData|wallet_switch|wallet_add|window\.ethereum/);
      for (const m of text.matchAll(/wallet\.request\(\{\s*method:\s*"([^"]+)"/g)) expect(["eth_chainId", "eth_accounts"]).toContain(m[1]);
    }
  });

  it("PreflightFailed is distinct from a refusal by the session", () => {
    expect(new PreflightFailed("x")).toBeInstanceOf(Error);
  });
});
