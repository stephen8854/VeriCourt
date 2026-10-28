import { createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONTRACT,
  OTHER,
  PRE_SEND_READS,
  SENDER,
  TX_HASH,
  deferred,
  eventfulWallet,
  fakeRpc,
  fakeStorage,
  sdkLikeSendParams,
  testIntent,
} from "../test/writeHarness";
import type { Hex } from "./bytes";
import { createCaseArgs, type CreateCaseInput } from "./createCase";
import { DurableWriteSession, WriteRefused, type BeginContext } from "./durableSession";
import { createGuardedProvider } from "./guardedProvider";
import { PENDING_KEY, PendingStore, parseRecord, type PendingRecord } from "./pendingStore";
import type { ReconciliationReader } from "./reconcileReader";
import { memoryLock, webLocks } from "./writeLock";

const CASE: CreateCaseInput = {
  respondent: OTHER,
  category: "OTHER",
  title: "FICTIONAL - durable session test",
  agreementSummary: "FICTIONAL",
  expectedDeliverable: "FICTIONAL",
  claim: "FICTIONAL",
  requestedRemedy: "FICTIONAL",
  issues: ["FICTIONAL issue"],
  replyWindowSeconds: 3600,
};
const CTX: BeginContext = { expectedEffect: { title: CASE.title, respondent: CASE.respondent }, baselinePartyCaseCount: 0, nonceBefore: 0n };
const RUN = { timeoutMs: 5_000, broadcastGuarded: false };

let opCounter = 0;
const intentFor = () => testIntent({ operationId: `op-${++opCounter}`, method: "create_case", args: createCaseArgs(CASE) });

function stored(storage: ReturnType<typeof fakeStorage>): PendingRecord {
  const parsed = parseRecord(storage.data.get(PENDING_KEY) ?? "");
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.record;
}

/**
 * One "tab": a session over shared storage. Each call gets its own lock unless
 * one is passed: a reloaded page's lock is released, so a fresh lock models a
 * reload, and a shared lock models two live tabs.
 */
function tab(storage: ReturnType<typeof fakeStorage>, lock = memoryLock()) {
  return DurableWriteSession.open(new PendingStore(storage), lock);
}

async function start(session: DurableWriteSession, wallet: ReturnType<typeof eventfulWallet>) {
  const intent = intentFor();
  const guard = await session.begin(intent, CTX);
  const provider = createGuardedProvider(wallet, guard);
  const submit = () => provider.request({ method: "eth_sendTransaction", params: sdkLikeSendParams(intent) });
  return { intent, guard, provider, submit };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("write-ahead persistence", () => {
  it("the record says 'forwarded' in storage before the wallet receives the request", async () => {
    const storage = fakeStorage();
    let atSend: PendingRecord | null = null;
    const wallet = eventfulWallet({
      send: () => {
        atSend = stored(storage);
        return { result: TX_HASH };
      },
    });
    const s = await tab(storage);
    const { submit } = await start(s, wallet);
    expect(stored(storage).tx.phase).toBe("preparing"); // written by begin(), before any wallet call
    await s.run(submit, { ...RUN, wallet });
    expect(atSend).not.toBeNull();
    expect(atSend!.tx.phase).toBe("awaiting_wallet");
    expect(atSend!.guard?.outbound?.state).toBe("in_flight");
    expect(stored(storage).tx).toMatchObject({ phase: "submitted", txHash: TX_HASH });
  });

  it("if the forward cannot be saved, the wallet is never asked and nothing is sent", async () => {
    const storage = fakeStorage();
    storage.fail.setOnlyWhen = (v) => v.includes('"state":"in_flight"');
    const wallet = eventfulWallet();
    const s = await tab(storage);
    const { submit } = await start(s, wallet);
    const outcome = await s.run(submit, { ...RUN, wallet });
    expect(wallet.sends).toHaveLength(0);
    expect(outcome.kind).toBe("not_sent");
    expect(stored(storage).tx.phase).toBe("not_sent");
  });

  it("begin() refuses when storage is unavailable, unreadable, or not writable", async () => {
    const lock = memoryLock();
    await expect((await DurableWriteSession.open(new PendingStore(null), lock)).begin(intentFor(), CTX)).rejects.toThrow(/storage/);
    const corrupt = fakeStorage();
    corrupt.data.set(PENDING_KEY, "{not json");
    await expect((await tab(corrupt)).begin(intentFor(), CTX)).rejects.toThrow(/cannot be read/);
    const readOnly = fakeStorage();
    readOnly.fail.set = true;
    await expect((await tab(readOnly)).begin(intentFor(), CTX)).rejects.toThrow(/not writable/);
  });

  it("begin() refuses without a cross-tab lock (no Web Locks)", async () => {
    await expect((await DurableWriteSession.open(new PendingStore(fakeStorage()), null)).begin(intentFor(), CTX)).rejects.toThrow(/Web Locks/);
  });
});

describe("browser reloads", () => {
  it("reload while the wallet prompt is open: uncertain, and it stays blocked in every later load", async () => {
    const storage = fakeStorage();
    const wallet = eventfulWallet({ send: () => ({ pending: new Promise(() => undefined) }) });
    const s = await tab(storage);
    const { submit } = await start(s, wallet);
    void s.run(submit, { ...RUN, timeoutMs: 60_000, wallet });
    await new Promise((r) => setTimeout(r, 0));
    expect(wallet.sends).toHaveLength(1);

    // The page reloads: a fresh session over the same storage.
    const after = await tab(storage);
    expect(after.state?.phase).toBe("submission_uncertain");
    expect(after.current?.recoveredAfterReload).toBe(true);
    expect(after.blockedReason).toMatch(/unresolved/);
    await expect(after.begin(intentFor(), CTX)).rejects.toBeInstanceOf(WriteRefused);
    expect(() => after.reset()).toThrow(/cannot be cleared/);
    // And again after another reload.
    expect((await tab(storage)).blockedReason).toMatch(/unresolved/);
  });

  it("reload before any wallet request: not sent, and the lane can be cleared", async () => {
    const storage = fakeStorage();
    const s = await tab(storage);
    await s.begin(intentFor(), CTX);
    const after = await tab(storage);
    expect(after.state?.phase).toBe("not_sent");
    after.reset();
    expect(after.blockedReason).toBeNull();
  });

  it("reload after the wallet returned a hash: submitted, still blocking until final", async () => {
    const storage = fakeStorage();
    const gate = deferred<unknown>();
    const wallet = eventfulWallet({ send: () => ({ result: TX_HASH }) });
    const s = await tab(storage);
    const { submit } = await start(s, wallet);
    // The SDK never returns (simulated by stalling after the provider resolves).
    void s.run(() => submit().then(() => gate.promise), { ...RUN, timeoutMs: 60_000, wallet });
    await new Promise((r) => setTimeout(r, 0));
    const after = await tab(storage);
    expect(after.state).toMatchObject({ phase: "submitted", txHash: TX_HASH });
    expect(after.blockedReason).toMatch(/unresolved/);
  });
});

describe("double clicks, tabs and concurrent operations", () => {
  it("a second begin in the same tab is refused", async () => {
    const s = await tab(fakeStorage());
    await s.begin(intentFor(), CTX);
    await expect(s.begin(intentFor(), CTX)).rejects.toThrow(/in progress/);
  });

  it("two tabs: the second cannot start while the first holds the lock, nor afterwards while it is unresolved", async () => {
    const storage = fakeStorage();
    const lock = memoryLock();
    const a = await tab(storage, lock);
    const b = await tab(storage, lock);
    const wallet = eventfulWallet({ send: () => ({ error: { code: -32603 } }) });
    const { submit } = await start(a, wallet);
    // Simulate B racing: it read "no record" before A wrote one, so only the lock stops it.
    await expect(b.begin(intentFor(), CTX)).rejects.toThrow(/another tab|unresolved/);
    await a.run(submit, { ...RUN, wallet });
    expect(lock.held()).toBe(false);
    b.refresh();
    await expect(b.begin(intentFor(), CTX)).rejects.toThrow(/unresolved/);
  });

  it("operation ids must be unique", async () => {
    const storage = fakeStorage();
    const id = `op-unique-${++opCounter}`;
    const make = () => testIntent({ operationId: id, method: "create_case", args: createCaseArgs(CASE) });
    await (await tab(storage)).begin(make(), CTX);
    const after = await tab(storage); // reload: not_sent, record kept until reset
    expect(after.state?.phase).toBe("not_sent");
    await expect(after.begin(make(), CTX)).rejects.toThrow(/unique/);
  });

  it("opening a second live tab never 'recovers' (overwrites) the first tab's running operation", async () => {
    const storage = fakeStorage();
    const lock = memoryLock();
    const prompt = deferred<unknown>();
    const wallet = eventfulWallet({ send: () => ({ pending: prompt.promise }) });
    const a = await tab(storage, lock);
    const { submit } = await start(a, wallet);
    const running = a.run(submit, { ...RUN, wallet });
    await new Promise((r) => setTimeout(r, 0));
    const b = await tab(storage, lock); // tab B opens while A's prompt is open
    expect(b.state?.phase).toBe("awaiting_wallet"); // shown as unresolved, not rewritten
    expect(stored(storage).tx.phase).toBe("awaiting_wallet");
    await expect(b.begin(intentFor(), CTX)).rejects.toThrow(/another tab/);
    prompt.resolve(TX_HASH);
    expect(await running).toMatchObject({ kind: "submitted", txHash: TX_HASH });
    expect(stored(storage).tx).toMatchObject({ phase: "submitted", txHash: TX_HASH });
  });
});

describe("wallet account or chain changes during an operation", () => {
  it("an account change before the forward stops the request", async () => {
    const storage = fakeStorage();
    const gate = deferred<undefined>();
    const wallet = eventfulWallet();
    const slowChain = {
      ...wallet,
      request: async (args: { method: string; params?: unknown[] }) => {
        if (args.method === "eth_chainId") await gate.promise;
        return wallet.request(args);
      },
    };
    const s = await tab(storage);
    const intent = intentFor();
    const guard = await s.begin(intent, CTX);
    const provider = createGuardedProvider(slowChain, guard);
    const running = s.run(() => provider.request({ method: "eth_sendTransaction", params: sdkLikeSendParams(intent) }), { ...RUN, wallet: slowChain });
    await new Promise((r) => setTimeout(r, 0));
    wallet.emit("accountsChanged", [OTHER]);
    gate.resolve(undefined);
    const outcome = await running;
    expect(wallet.sends).toHaveLength(0);
    expect(outcome.kind).toBe("not_sent");
    expect(stored(storage).guard?.disarmReason).toMatch(/account changed/);
  });

  it("a chain change after the forward cannot withdraw it: the result is still recorded", async () => {
    const storage = fakeStorage();
    const prompt = deferred<unknown>();
    const wallet = eventfulWallet({ send: () => ({ pending: prompt.promise }) });
    const s = await tab(storage);
    const { submit } = await start(s, wallet);
    const running = s.run(submit, { ...RUN, wallet });
    await new Promise((r) => setTimeout(r, 0));
    wallet.emit("chainChanged", "0x1");
    prompt.resolve(TX_HASH);
    const outcome = await running;
    expect(outcome).toMatchObject({ kind: "submitted", txHash: TX_HASH });
    expect(stored(storage).guard?.journal.some((e) => e.event === "disarmed" && /network changed/.test(e.detail))).toBe(true);
    expect(wallet.listenerCount()).toBe(0); // the watcher unsubscribed
  });

  it("a wallet that cannot report changes is not used", async () => {
    const storage = fakeStorage();
    const wallet = eventfulWallet();
    const noEvents = { request: wallet.request };
    const s = await tab(storage);
    const intent = intentFor();
    const guard = await s.begin(intent, CTX);
    const provider = createGuardedProvider(noEvents, guard);
    const outcome = await s.run(() => provider.request({ method: "eth_sendTransaction", params: sdkLikeSendParams(intent) }), { ...RUN, wallet: noEvents });
    expect(outcome.kind).toBe("not_sent");
    expect(wallet.methods()).toEqual([]);
  });
});

describe("timeouts, late and malformed responses", () => {
  it("timeout with the prompt open is uncertain (not failed); a late hash is persisted and reconciles to found", async () => {
    vi.useFakeTimers();
    const storage = fakeStorage();
    const prompt = deferred<unknown>();
    const wallet = eventfulWallet({ send: () => ({ pending: prompt.promise }) });
    const s = await tab(storage);
    const { submit } = await start(s, wallet);
    const running = s.run(submit, { ...RUN, timeoutMs: 1_000, wallet });
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await running).kind).toBe("uncertain");
    expect(stored(storage).tx.phase).toBe("submission_uncertain");

    prompt.resolve(TX_HASH); // the user approves after the UI gave up
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    expect(stored(storage).guard?.outbound).toMatchObject({ state: "hash", hash: TX_HASH, settledAfterDisarm: true });

    const reader = fakeReader({ txs: { [TX_HASH]: { hash: TX_HASH } } });
    const result = await s.reconcile(reader);
    expect(result).toMatchObject({ kind: "found", txHash: TX_HASH });
    expect(stored(storage).tx).toMatchObject({ phase: "submitted", txHash: TX_HASH });
    expect(wallet.sends).toHaveLength(1);
  });

  it("a malformed wallet response is uncertain and persisted", async () => {
    const storage = fakeStorage();
    const wallet = eventfulWallet({ send: () => ({ result: { not: "a hash" } }) });
    const s = await tab(storage);
    const { submit } = await start(s, wallet);
    expect(await s.run(submit, { ...RUN, wallet })).toMatchObject({ kind: "uncertain", reason: "malformed_wallet_response" });
    expect((await tab(storage)).blockedReason).toMatch(/unresolved/);
  });

  it("the real SDK's V6 fallback cannot reach the wallet; the write stays blocked", async () => {
    const storage = fakeStorage();
    const wallet = eventfulWallet({ send: () => ({ error: { code: -32603, message: "execution reverted: could not decode" } }) });
    vi.stubGlobal("fetch", fakeRpc(PRE_SEND_READS).fetch);
    const s = await tab(storage);
    const intent = intentFor();
    const guard = await s.begin(intent, CTX);
    type Config = NonNullable<Parameters<typeof createClient>[0]>;
    const client = createClient({ chain: studionet, account: SENDER, provider: createGuardedProvider(wallet, guard) } as unknown as Config);
    const outcome = await s.run(
      () => client.writeContract({ address: CONTRACT, functionName: "create_case", args: createCaseArgs(CASE) as never, value: 0n }),
      { ...RUN, wallet },
    );
    expect(wallet.sends).toHaveLength(1);
    expect(stored(storage).guard?.refusals).toBe(1);
    expect(outcome.kind).toBe("uncertain");
    expect((await tab(storage)).blockedReason).toMatch(/unresolved/);
  });

  it("a late callback from an old operation cannot change a newer record", async () => {
    const storage = fakeStorage();
    const s = await tab(storage);
    const old = await s.begin(intentFor(), CTX);
    const reloaded = await tab(storage); // old page "gone": not_sent
    reloaded.reset();
    await reloaded.begin(intentFor(), CTX);
    const before = storage.data.get(PENDING_KEY);
    old.disarm("late event from the old page");
    expect(storage.data.get(PENDING_KEY)).toBe(before); // the newer record is untouched
    expect(old.persistFailures).toBe(1); // the old observer refused to write
  });

  it("a late result in one tab merges into the stored record instead of overwriting another tab's changes", async () => {
    vi.useFakeTimers();
    const storage = fakeStorage();
    const lock = memoryLock();
    const prompt = deferred<unknown>();
    const wallet = eventfulWallet({ send: () => ({ pending: prompt.promise }) });
    const a = await tab(storage, lock);
    const { submit } = await start(a, wallet);
    const running = a.run(submit, { ...RUN, timeoutMs: 1_000, wallet });
    await vi.advanceTimersByTimeAsync(1_000);
    await running;
    vi.useRealTimers();
    // Tab B records a reconciliation attempt on the same (uncertain) record.
    const b = await tab(storage, lock);
    await b.reconcile(fakeReader({ final: [] }));
    expect(stored(storage).reconciliations).toHaveLength(1);
    // Then tab A receives the late wallet hash.
    prompt.resolve(TX_HASH);
    await new Promise((r) => setTimeout(r, 0));
    const merged = stored(storage);
    expect(merged.guard?.outbound?.hash).toBe(TX_HASH);
    expect(merged.reconciliations).toHaveLength(1); // B's note survived
  });
});

// ---------------------------------------------------------------------------
// Reconciliation (read-only)
// ---------------------------------------------------------------------------

interface Case {
  case_id: string;
  claimant: string;
  respondent: string;
  title: string;
}

function fakeReader(opts: { txs?: Record<string, unknown>; final?: Case[]; nonFinal?: Case[]; fail?: boolean; nonce?: string } = {}) {
  const calls: string[] = [];
  const reader: ReconciliationReader = {
    async getTransaction(hash: Hex) {
      calls.push("getTransaction");
      if (opts.fail) throw new Error("rpc down");
      return opts.txs?.[hash] ?? null;
    },
    async getTransactionCount() {
      calls.push("getTransactionCount");
      if (opts.fail) throw new Error("rpc down");
      return opts.nonce ?? "0x0";
    },
    async readContract(_address, method, args, variant) {
      calls.push(`${method}@${variant}`);
      if (opts.fail) throw new Error("rpc down");
      const cases = (variant === "latest-final" ? opts.final : opts.nonFinal ?? opts.final) ?? [];
      if (method === "get_party_case_ids") {
        const offset = Number(args[1]);
        return { case_ids: cases.slice(offset).map((c) => c.case_id), total: cases.length };
      }
      if (method === "get_case") return cases.find((c) => c.case_id === args[0]) ?? null;
      throw new Error(`unexpected read ${method}`);
    },
  };
  return Object.assign(reader, { calls });
}

const MATCH: Case = { case_id: "VC-000003", claimant: SENDER, respondent: OTHER, title: CASE.title };

async function uncertainLane() {
  const storage = fakeStorage();
  const wallet = eventfulWallet({ send: () => ({ error: { code: -32603 } }) });
  const s = await tab(storage);
  const { submit } = await start(s, wallet);
  await s.run(submit, { ...RUN, wallet });
  expect(s.state?.phase).toBe("submission_uncertain");
  return { storage, wallet, s };
}

describe("read-only reconciliation", () => {
  it("the intended case final in contract state: confirmed_by_state, never repeated, then clearable", async () => {
    const { storage, wallet, s } = await uncertainLane();
    const reader = fakeReader({ final: [MATCH] });
    const result = await s.reconcile(reader);
    expect(result.kind).toBe("effect_final");
    expect(stored(storage).tx.phase).toBe("confirmed_by_state");
    expect(stored(storage).reconciliations.at(-1)).toMatchObject({ kind: "effect_final" });
    expect(reader.calls.every((c) => /^(getTransaction|getTransactionCount|get_party_case_ids|get_case)/.test(c))).toBe(true);
    expect(wallet.sends).toHaveLength(1);
    s.reset();
    expect(s.blockedReason).toBeNull();
  });

  it("seen only at latest-nonfinal: unresolved, still blocked", async () => {
    const { s } = await uncertainLane();
    const result = await s.reconcile(fakeReader({ final: [], nonFinal: [MATCH] }));
    expect(result.kind).toBe("unresolved");
    expect(s.blockedReason).toMatch(/unresolved/);
  });

  it("absent everywhere: still unresolved (absence is not proof while nonces are unverified)", async () => {
    const { storage, s } = await uncertainLane();
    const result = await s.reconcile(fakeReader({ final: [] }));
    expect(result.kind).toBe("unresolved");
    expect(stored(storage).tx.phase).toBe("submission_uncertain");
    expect(stored(storage).reconciliations).toHaveLength(1);
  });

  it("a different case (other title or respondent) is not taken as the effect", async () => {
    const { s } = await uncertainLane();
    const result = await s.reconcile(fakeReader({ final: [{ ...MATCH, title: "something else" }, { ...MATCH, respondent: SENDER }] }));
    expect(result.kind).toBe("unresolved");
  });

  it("read failures are unresolved, never 'not sent'", async () => {
    const { s } = await uncertainLane();
    expect((await s.reconcile(fakeReader({ fail: true }))).kind).toBe("unresolved");
    expect(s.blockedReason).toMatch(/unresolved/);
  });

  it("reconciling a record that is not uncertain is refused", async () => {
    const s = await tab(fakeStorage());
    await expect(s.reconcile(fakeReader())).rejects.toThrow(/nothing uncertain/);
  });
});

describe("Web Locks adapter", () => {
  it("grants one holder at a time and reports 'unavailable' without waiting", async () => {
    let held = false;
    const fakeNavigator = {
      locks: {
        request(_name: string, opts: { ifAvailable: boolean }, cb: (lock: unknown) => Promise<void> | void) {
          expect(opts.ifAvailable).toBe(true);
          if (held) return Promise.resolve(cb(null));
          held = true;
          return Promise.resolve(cb({})).then(() => {
            held = false;
          });
        },
      },
    };
    const lock = webLocks(fakeNavigator)!;
    const first = await lock.tryAcquire();
    expect(first).not.toBeNull();
    expect(await lock.tryAcquire()).toBeNull();
    first!();
    await new Promise((r) => setTimeout(r, 0));
    expect(await lock.tryAcquire()).not.toBeNull();
  });

  it("no navigator.locks: no lock (writes refused)", () => {
    expect(webLocks({})).toBeNull();
    expect(webLocks(undefined)).toBeNull();
  });
});
