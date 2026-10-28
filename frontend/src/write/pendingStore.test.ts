import { describe, expect, it } from "vitest";
import { TX_HASH, fakeStorage, fakeWallet, sdkLikeSendParams, testIntent } from "../test/writeHarness";
import { WriteGuard, type GuardSnapshot } from "./guard";
import { createGuardedProvider } from "./guardedProvider";
import { PENDING_KEY, PendingStore, blockReason, parseRecord, recoverAfterReload, type PendingRecord } from "./pendingStore";

const NOW = "2026-10-18T00:00:00.000Z";

function record(overrides: Partial<PendingRecord> = {}): PendingRecord {
  const intent = testIntent({ method: "create_case", args: ["0x" + "2b".repeat(20)] });
  return {
    version: 1,
    operationId: "op-1",
    createdAt: NOW,
    updatedAt: NOW,
    chainId: 61999,
    contract: intent.contractAddress,
    sender: intent.sender,
    consensusAddress: intent.consensusAddress,
    method: "create_case",
    expectedEffect: { title: "FICTIONAL", respondent: "0x" + "2b".repeat(20) },
    baselinePartyCaseCount: 0,
    nonceBefore: "0",
    tx: { phase: "awaiting_wallet", txHash: null, note: null },
    guard: null,
    recoveredAfterReload: false,
    reconciliations: [],
    ...overrides,
  };
}

async function snapshotAfter(reply: Parameters<typeof fakeWallet>[0], settle = true): Promise<GuardSnapshot> {
  const intent = testIntent();
  const guard = new WriteGuard(intent);
  const sending = createGuardedProvider(fakeWallet(reply), guard)
    .request({ method: "eth_sendTransaction", params: sdkLikeSendParams(intent) })
    .catch(() => undefined);
  if (settle) await sending;
  else await new Promise((r) => setTimeout(r, 0));
  return guard.snapshot();
}

describe("PendingStore", () => {
  it("round-trips a record through storage, with read-back verification", () => {
    const storage = fakeStorage();
    const store = new PendingStore(storage);
    expect(store.load()).toEqual({ kind: "none" });
    store.save(record());
    expect(store.load()).toEqual({ kind: "record", record: record() });
    expect(storage.data.has(PENDING_KEY)).toBe(true);
  });

  it("unavailable or throwing storage is reported, never treated as 'nothing pending'", () => {
    expect(new PendingStore(null).load().kind).toBe("storage_unavailable");
    const storage = fakeStorage();
    storage.fail.get = true;
    expect(new PendingStore(storage).load().kind).toBe("storage_unavailable");
    expect(PendingStore.fromWindow({ get localStorage(): never { throw new Error("denied"); } }).load().kind).toBe("storage_unavailable");
  });

  it("a failed save throws (so a write-ahead cannot silently fail)", () => {
    const storage = fakeStorage();
    storage.fail.set = true;
    expect(() => new PendingStore(storage).save(record())).toThrow(/could not be saved/);
  });

  it("probe detects non-writable storage without touching the record", () => {
    const storage = fakeStorage();
    const store = new PendingStore(storage);
    store.save(record());
    expect(store.probe()).toBe(true);
    storage.fail.set = true;
    expect(store.probe()).toBe(false);
    expect(store.load().kind).toBe("record");
  });

  it.each([
    ["not JSON", "{"],
    ["wrong version", JSON.stringify({ ...record(), version: 2 })],
    ["unknown phase", JSON.stringify({ ...record(), tx: { phase: "done", txHash: null, note: null } })],
    ["bad hash", JSON.stringify({ ...record(), tx: { phase: "submitted", txHash: "0x12", note: null } })],
    ["bad method", JSON.stringify({ ...record(), method: "drain" })],
    ["bad address", JSON.stringify({ ...record(), sender: "me" })],
    ["bad nonce", JSON.stringify({ ...record(), nonceBefore: "-1" })],
    ["inconsistent guard", JSON.stringify({ ...record(), guard: { operationId: "op-1", armed: false, disarmReason: null, requestsForwarded: 1, refusals: 0, outbound: null, journal: [] } })],
  ])("an unparseable record (%s) is 'unreadable' and blocks writes", (_name, text) => {
    const storage = fakeStorage();
    storage.data.set(PENDING_KEY, text);
    const load = new PendingStore(storage).load();
    expect(load.kind).toBe("unreadable");
    expect(blockReason(load)).toMatch(/cannot be read.*outcome is unknown/);
  });

  it("parses a record that carries a real guard snapshot", async () => {
    const r = record({ guard: await snapshotAfter({}) });
    expect(parseRecord(JSON.stringify(r))).toEqual({ ok: true, record: r });
  });

  it("stores no calldata, signature or key material", async () => {
    const text = JSON.stringify(record({ guard: await snapshotAfter({}) }));
    expect(text).not.toContain(testIntent().calldata.slice(12, 120));
    expect(text).not.toMatch(/privateKey|mnemonic|signedTransaction":"0x/);
  });
});

describe("blockReason", () => {
  it("unavailable storage and unreadable records block, with a reason", () => {
    expect(blockReason({ kind: "storage_unavailable", reason: "browser storage could not be read" })).toMatch(/Writes are blocked: browser storage could not be read/);
    expect(blockReason({ kind: "unreadable", reason: "not valid JSON" })).toMatch(/Writes are blocked/);
    const storage = fakeStorage();
    storage.fail.get = true;
    expect(blockReason(new PendingStore(storage).load())).toMatch(/could not be read/);
  });

  it("only settled records allow a new write", () => {
    expect(blockReason({ kind: "none" })).toBeNull();
    for (const phase of ["rejected", "not_sent", "verified", "confirmed_by_state", "finalized_unsuccessful", "verification_mismatch"] as const) {
      expect(blockReason({ kind: "record", record: record({ tx: { phase, txHash: null, note: null } }) })).toBeNull();
    }
    for (const phase of ["submission_uncertain", "submitted", "pending", "accepted", "finalized", "timed_out_unknown", "read_failure", "awaiting_wallet"] as const) {
      expect(blockReason({ kind: "record", record: record({ tx: { phase, txHash: null, note: null } }) })).toMatch(/unresolved/);
    }
  });
});

describe("recoverAfterReload (the page went away mid-operation)", () => {
  it("no request was forwarded: provably not sent", () => {
    const r = recoverAfterReload(record({ tx: { phase: "preparing", txHash: null, note: null } }), NOW);
    expect(r.tx.phase).toBe("not_sent");
    expect(r.recoveredAfterReload).toBe(true);
  });

  it("a forwarded request with no result: uncertain (a reload is never failure)", async () => {
    const r = recoverAfterReload(record({ guard: await snapshotAfter({ send: () => ({ pending: new Promise(() => undefined) }) }, false) }), NOW);
    expect(r.tx.phase).toBe("submission_uncertain");
    expect(r.tx.note).toMatch(/may have been sent/);
    expect(r.guard?.armed).toBe(false);
  });

  it("a wallet hash was recorded: submitted (keeps blocking until finality)", async () => {
    const r = recoverAfterReload(record({ guard: await snapshotAfter({}) }), NOW);
    expect(r.tx).toMatchObject({ phase: "submitted", txHash: TX_HASH });
    expect(blockReason({ kind: "record", record: r })).toMatch(/unresolved/);
  });

  it("a 4001 was recorded: rejected", async () => {
    const r = recoverAfterReload(record({ guard: await snapshotAfter({ send: () => ({ error: { code: 4001 } }) }) }), NOW);
    expect(r.tx.phase).toBe("rejected");
  });

  it.each([
    ["an error", { send: () => ({ error: { code: -32603 } }) }],
    ["a malformed result", { send: () => ({ result: "0xzz" }) }],
  ])("%s after forwarding: uncertain", async (_name, reply) => {
    expect(recoverAfterReload(record({ guard: await snapshotAfter(reply) }), NOW).tx.phase).toBe("submission_uncertain");
  });

  it("phases that do not depend on the live page are unchanged", () => {
    const r = record({ tx: { phase: "submission_uncertain", txHash: null, note: "x" } });
    expect(recoverAfterReload(r, NOW)).toBe(r);
  });
});
