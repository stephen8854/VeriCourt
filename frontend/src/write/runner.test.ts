import { afterEach, describe, expect, it, vi } from "vitest";
import { TX_HASH, deferred, fakeSigner, fakeWallet, sdkLikeSendParams, sdkLikeSignRequest, testIntent } from "../test/writeHarness";
import { WriteGuard, type GuardSnapshot } from "./guard";
import { createGuardedLocalAccount } from "./guardedAccount";
import { createGuardedProvider } from "./guardedProvider";
import { reconcile, type ReconciliationEvidence } from "./reconcile";
import { deriveOutcome, runGuardedWrite } from "./runner";
import { WriteBlocked, WriteSession } from "./session";

afterEach(() => vi.useRealTimers());

const OTHER_HASH = `0x${"ef".repeat(32)}` as const;

describe("runGuardedWrite: bounded waiting", () => {
  it("times out before any request: not sent, and a late SDK request is refused", async () => {
    vi.useFakeTimers();
    const intent = testIntent();
    const guard = new WriteGuard(intent);
    const wallet = fakeWallet();
    const provider = createGuardedProvider(wallet, guard);
    const sdkStall = deferred<undefined>();
    const late = sdkStall.promise.then(() => provider.request({ method: "eth_sendTransaction", params: sdkLikeSendParams(intent) }));
    const running = runGuardedWrite(guard, () => late, { timeoutMs: 1_000, broadcastGuarded: false });
    await vi.advanceTimersByTimeAsync(1_000);
    const { outcome } = await running;
    expect(outcome).toEqual({ kind: "not_sent", reason: "the deadline passed before any transaction request; the guard is closed" });
    sdkStall.resolve(undefined);
    await expect(late).rejects.toThrow(/closed \(application deadline passed\)/);
    expect(wallet.sends).toHaveLength(0);
  });

  it("times out while the wallet prompt is open: uncertain; the late hash is still journaled", async () => {
    vi.useFakeTimers();
    const intent = testIntent();
    const guard = new WriteGuard(intent);
    const prompt = deferred<unknown>();
    const wallet = fakeWallet({ send: () => ({ pending: prompt.promise }) });
    const provider = createGuardedProvider(wallet, guard);
    let sdk: Promise<unknown> = Promise.resolve();
    const running = runGuardedWrite(
      guard,
      () => (sdk = provider.request({ method: "eth_sendTransaction", params: sdkLikeSendParams(intent) })),
      { timeoutMs: 1_000, broadcastGuarded: false },
    );
    await vi.advanceTimersByTimeAsync(1_000);
    const { outcome } = await running;
    expect(outcome).toEqual({ kind: "uncertain", reason: "timeout_while_wallet_open", knownHash: null });
    // The timeout did not cancel the prompt. The user approves later:
    prompt.resolve(TX_HASH);
    await sdk;
    expect(guard.snapshot().outbound).toMatchObject({ state: "hash", hash: TX_HASH, settledAfterDisarm: true });
  });

  it("refuses to run a guard twice (no retry through the same operation)", async () => {
    const guard = new WriteGuard(testIntent());
    await runGuardedWrite(guard, async () => { throw new Error("x"); }, { timeoutMs: 1_000, broadcastGuarded: false });
    await expect(runGuardedWrite(guard, async () => undefined, { timeoutMs: 1_000, broadcastGuarded: false })).rejects.toThrow(/already used/);
  });

  it("requires a positive timeout", async () => {
    await expect(runGuardedWrite(new WriteGuard(testIntent()), async () => undefined, { timeoutMs: 0, broadcastGuarded: false })).rejects.toThrow(/timeout/);
  });

  it("always leaves the guard disarmed", async () => {
    const guard = new WriteGuard(testIntent());
    await runGuardedWrite(guard, async () => "x", { timeoutMs: 1_000, broadcastGuarded: false });
    expect(guard.snapshot().armed).toBe(false);
  });
});

describe("deriveOutcome: the journal decides, the SDK result must agree", () => {
  async function walletSnap(reply: Parameters<typeof fakeWallet>[0]): Promise<GuardSnapshot> {
    const intent = testIntent();
    const guard = new WriteGuard(intent);
    await createGuardedProvider(fakeWallet(reply), guard)
      .request({ method: "eth_sendTransaction", params: sdkLikeSendParams(intent) })
      .catch(() => undefined);
    guard.disarm("operation finished");
    return guard.snapshot();
  }
  const opts = { broadcastGuarded: false };

  it("an SDK result that differs from the wallet's hash is uncertain", async () => {
    const snap = await walletSnap({});
    expect(deriveOutcome(snap, { status: "resolved", value: OTHER_HASH }, opts)).toEqual({ kind: "uncertain", reason: "sdk_result_mismatch", knownHash: TX_HASH });
  });

  it("an SDK result with no guarded request is flagged as a possible bypass", () => {
    const guard = new WriteGuard(testIntent());
    guard.disarm("operation finished");
    expect(deriveOutcome(guard.snapshot(), { status: "resolved", value: TX_HASH }, opts)).toMatchObject({
      kind: "uncertain",
      reason: "sdk_returned_without_guarded_request",
    });
  });

  it("a malformed wallet response is uncertain", async () => {
    const snap = await walletSnap({ send: () => ({ result: "0xnope" }) });
    expect(deriveOutcome(snap, { status: "rejected", error: new Error("x") }, opts)).toMatchObject({ kind: "uncertain", reason: "malformed_wallet_response" });
  });

  it("a signed transaction released without the broadcast guard is uncertain", async () => {
    const intent = testIntent();
    const guard = new WriteGuard(intent);
    await createGuardedLocalAccount(fakeSigner(intent.sender), guard).signTransaction(sdkLikeSignRequest(intent));
    guard.disarm("operation finished");
    expect(deriveOutcome(guard.snapshot(), { status: "timed_out" }, { broadcastGuarded: false })).toMatchObject({
      kind: "uncertain",
      reason: "released_without_broadcast_guard",
    });
    expect(deriveOutcome(guard.snapshot(), { status: "timed_out" }, { broadcastGuarded: true }).kind).toBe("not_sent");
  });
});

describe("reconcile: only positive evidence clears an uncertain write", () => {
  async function uncertainWalletSnap(): Promise<GuardSnapshot> {
    const intent = testIntent();
    const guard = new WriteGuard(intent);
    await createGuardedProvider(fakeWallet({ send: () => ({ error: { code: -32603 } }) }), guard)
      .request({ method: "eth_sendTransaction", params: sdkLikeSendParams(intent) })
      .catch(() => undefined);
    guard.disarm("operation finished");
    return guard.snapshot();
  }
  const base = (snapshot: GuardSnapshot): ReconciliationEvidence => ({
    snapshot,
    lookup: { kind: "not_checked" },
    nonce: { before: 3n, latest: 3n, pending: 3n },
    contractEffect: "absent",
    nonceTrackingVerified: false,
    broadcastGuarded: false,
  });

  it("an armed guard cannot be reconciled", () => {
    expect(reconcile(base(new WriteGuard(testIntent()).snapshot())).kind).toBe("unresolved");
  });

  it("no request ever left the guard: not sent", () => {
    const guard = new WriteGuard(testIntent());
    guard.disarm("x");
    expect(reconcile(base(guard.snapshot())).kind).toBe("not_sent");
  });

  it("an explicit error is NOT enough while StudioNet nonce behaviour is unverified", async () => {
    const result = reconcile(base(await uncertainWalletSnap()));
    expect(result.kind).toBe("unresolved");
    expect(result.kind === "unresolved" && result.reasons.join(" ")).toMatch(/nonce behaviour is not yet verified/);
  });

  it("an explicit error + verified unchanged nonce + absent effect: not sent", async () => {
    expect(reconcile({ ...base(await uncertainWalletSnap()), nonceTrackingVerified: true }).kind).toBe("not_sent");
  });

  it.each([
    ["the nonce advanced", { nonce: { before: 3n, latest: 4n, pending: 4n } }],
    ["the pending nonce advanced", { nonce: { before: 3n, latest: 3n, pending: 4n } }],
    ["the nonce is unknown", { nonce: { before: null, latest: 3n, pending: 3n } }],
    ["the effect could not be checked", { contractEffect: "unknown" as const }],
  ])("stays unresolved when %s", async (_name, override) => {
    expect(reconcile({ ...base(await uncertainWalletSnap()), nonceTrackingVerified: true, ...override }).kind).toBe("unresolved");
  });

  it("an effect seen only at latest-nonfinal stays unresolved: never resubmit", async () => {
    const r = reconcile({ ...base(await uncertainWalletSnap()), contractEffect: "observed_nonfinal" });
    expect(r.kind === "unresolved" && r.reasons[0]).toMatch(/do not resubmit/);
  });

  it("an effect final in contract state resolves as effect_final (sent; never repeat)", async () => {
    const r = reconcile({ ...base(await uncertainWalletSnap()), contractEffect: "observed_final", effectDetail: "VC-000003 matches" });
    expect(r).toEqual({ kind: "effect_final", basis: "the intended effect is final in contract state (VC-000003 matches)" });
  });

  it("a timeout with the prompt still open is never 'not sent', even with an unchanged nonce", async () => {
    const intent = testIntent();
    const guard = new WriteGuard(intent);
    void createGuardedProvider(fakeWallet({ send: () => ({ pending: new Promise(() => undefined) }) }), guard)
      .request({ method: "eth_sendTransaction", params: sdkLikeSendParams(intent) });
    await new Promise((r) => setTimeout(r, 0));
    guard.disarm("application deadline passed");
    expect(reconcile({ ...base(guard.snapshot()), nonceTrackingVerified: true }).kind).toBe("unresolved");
  });

  it("a late 4001 rejection proves not sent", async () => {
    const intent = testIntent();
    const guard = new WriteGuard(intent);
    const prompt = deferred<unknown>();
    const sending = createGuardedProvider(fakeWallet({ send: () => ({ pending: prompt.promise }) }), guard)
      .request({ method: "eth_sendTransaction", params: sdkLikeSendParams(intent) })
      .catch(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
    guard.disarm("application deadline passed");
    prompt.reject({ code: 4001 });
    await sending;
    expect(reconcile(base(guard.snapshot()))).toMatchObject({ kind: "not_sent", basis: expect.stringMatching(/4001/) });
  });

  it("a recorded hash found on chain: found; an unrecorded hash is not accepted", async () => {
    const intent = testIntent();
    const guard = new WriteGuard(intent);
    await createGuardedProvider(fakeWallet(), guard).request({ method: "eth_sendTransaction", params: sdkLikeSendParams(intent) });
    guard.disarm("x");
    expect(reconcile({ ...base(guard.snapshot()), lookup: { kind: "found", hash: TX_HASH } })).toMatchObject({ kind: "found", txHash: TX_HASH });
    expect(reconcile({ ...base(guard.snapshot()), lookup: { kind: "found", hash: OTHER_HASH } }).kind).toBe("unresolved");
  });
});

describe("WriteSession: one write at a time; uncertain blocks until reconciled", () => {
  it("a second operation cannot begin while one is in progress (double click)", () => {
    const session = new WriteSession();
    session.begin(testIntent());
    expect(() => session.begin(testIntent())).toThrow(WriteBlocked);
  });

  it("an uncertain write blocks every further write until reconciliation resolves it", async () => {
    const session = new WriteSession();
    const intent = testIntent();
    const guard = session.begin(intent);
    const provider = createGuardedProvider(fakeWallet({ send: () => ({ error: { code: -32603 } }) }), guard);
    const outcome = await session.run(() => provider.request({ method: "eth_sendTransaction", params: sdkLikeSendParams(intent) }), {
      timeoutMs: 1_000,
      broadcastGuarded: false,
    });
    expect(outcome.kind).toBe("uncertain");
    expect(session.state.phase).toBe("submission_uncertain");
    expect(() => session.begin(testIntent())).toThrow(WriteBlocked);
    expect(() => session.reset()).toThrow();

    const evidence = { lookup: { kind: "not_checked" } as const, nonce: { before: 0n, latest: 0n, pending: 0n }, contractEffect: "absent" as const, broadcastGuarded: false };
    expect(session.reconcile({ ...evidence, nonceTrackingVerified: false }).kind).toBe("unresolved");
    expect(session.state.phase).toBe("submission_uncertain");
    expect(() => session.begin(testIntent())).toThrow(WriteBlocked);

    expect(session.reconcile({ ...evidence, nonceTrackingVerified: true }).kind).toBe("not_sent");
    expect(session.state.phase).toBe("not_sent");
    session.reset();
    expect(() => session.begin(testIntent())).not.toThrow();
  });

  it("each operation gets a new guard; an old guard stays closed", async () => {
    const session = new WriteSession();
    const first = session.begin(testIntent());
    session.abandon("user cancelled");
    expect(session.state.phase).toBe("not_sent");
    session.reset();
    const second = session.begin(testIntent());
    expect(second).not.toBe(first);
    expect(first.isArmed).toBe(false);
    expect(second.isArmed).toBe(true);
  });

  it("a rejected write settles as rejected", async () => {
    const session = new WriteSession();
    const intent = testIntent();
    const guard = session.begin(intent);
    const provider = createGuardedProvider(fakeWallet({ send: () => ({ error: { code: 4001 } }) }), guard);
    await session.run(() => provider.request({ method: "eth_sendTransaction", params: sdkLikeSendParams(intent) }), { timeoutMs: 1_000, broadcastGuarded: false });
    expect(session.state.phase).toBe("rejected");
  });

  it("a submitted write blocks until final and verified", async () => {
    const session = new WriteSession();
    const intent = testIntent();
    const guard = session.begin(intent);
    const provider = createGuardedProvider(fakeWallet(), guard);
    await session.run(() => provider.request({ method: "eth_sendTransaction", params: sdkLikeSendParams(intent) }), { timeoutMs: 1_000, broadcastGuarded: false });
    expect(session.state).toMatchObject({ phase: "submitted", txHash: TX_HASH });
    session.apply({ type: "OBSERVED", category: "FINALIZED_SUCCESS" });
    expect(() => session.begin(testIntent())).toThrow(WriteBlocked);
    session.apply({ type: "VERIFIED" });
    expect(session.state.phase).toBe("verified");
  });
});
