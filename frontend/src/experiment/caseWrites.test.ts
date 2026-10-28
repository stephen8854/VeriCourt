/**
 * Phase 4.1: the four case-level writes through the same guarded path as
 * create_case: the REAL genlayer-js 1.1.8 writeContract, the guarded provider,
 * the durable session (storage + lock), monitoring and reconciliation. The
 * chain, wallet and storage are in memory. Every test checks how many wallet
 * requests were made.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CODE, CODE_SHA, CONNECTED, ENABLED_GATE, FAST_TIMING, txWithStatus } from "../test/experimentHarness";
import { CONTRACT, OTHER, PRE_SEND_READS, SENDER, TX_HASH, eventfulWallet, fakeRpc, fakeStorage } from "../test/writeHarness";
import { decodeAddTransactionV5 } from "../write/addTransaction";
import { DurableWriteSession, WriteRefused } from "../write/durableSession";
import { PENDING_KEY, PendingStore, parseRecord } from "../write/pendingStore";
import { memoryLock } from "../write/writeLock";
import { buildWriteIntent, studionetWriteParams } from "../write/intent";
import {
  PreflightFailed,
  monitorToFinality,
  processDeadlineSpec,
  reconcileUncertain,
  requestAssessmentSpec,
  statusMessage,
  submitEvidenceSpec,
  submitReplySpec,
  submitWrite,
  type ExperimentReader,
  type FlowDeps,
  type WriteSpec,
} from "./createCaseFlow";
import { createSdkWriteClient } from "./sdkExperiment";
import type { Hex } from "../write/bytes";
import type { SubmitEvidenceInput } from "../write/caseActions";

const CASE_ID = "VC-000005";
/** The fake device clock (ms) every flow starts at, and deadlines relative to it. */
const START_MS = 1_800_000_000_000;
const NOW_S = START_MS / 1000;
const HASH = "AB".repeat(32);

type Obj = Record<string, unknown>;

interface CaseState {
  case: Obj;
  evidence: Obj[];
}

function baseCase(over: Obj = {}): CaseState {
  return {
    case: {
      case_id: CASE_ID,
      claimant: SENDER,
      respondent: OTHER,
      status: "AWAITING_RESPONSE",
      response_state: "PENDING",
      reply: "",
      snapshot_locked: false,
      issues: [
        { issue_id: "I1", description: "first" },
        { issue_id: "I2", description: "second" },
      ],
      evidence_count: 0,
      claimant_evidence_count: 0,
      respondent_evidence_count: 0,
      assessment_attempts: 0,
      reply_deadline: NOW_S + 3600,
      ...over,
    },
    evidence: [],
  };
}

/** A minimal in-memory contract for one case: reads, simulations and a scripted transaction timeline. */
function caseStudio(initial: CaseState, opts: { timeline?: string[]; finalResult?: string; simulate?: (method: string, args: readonly unknown[]) => unknown; nonFinalDiffers?: boolean } = {}) {
  const timeline = opts.timeline ?? ["PENDING", "ACCEPTED", "FINALIZED"];
  let final = structuredClone(initial);
  let nonfinal = structuredClone(initial);
  if (opts.nonFinalDiffers) nonfinal.case.evidence_count = 99;
  let pending: ((s: CaseState) => void) | null = null;
  let polls = 0;
  const calls: string[] = [];
  const reader: ExperimentReader = {
    chainId: async () => "0xf22f",
    gasPrice: async () => "0x0",
    getContractCode: async () => CODE,
    getTransactionCount: async () => "0x0",
    simulateCreateCase: async () => {
      throw new Error("not used");
    },
    simulateWrite: async (_sender, _contract, method, args) => {
      calls.push(`simulate:${method}`);
      if (opts.simulate) return opts.simulate(method, args);
      return method === "submit_evidence" ? `E${(nonfinal.case.evidence_count as number) + 1}` : null;
    },
    getTransaction: async (hash: Hex) => {
      calls.push("getTransaction");
      if (pending === null || hash.toLowerCase() !== TX_HASH.toLowerCase()) return null;
      const status = timeline[Math.min(polls, timeline.length - 1)] ?? "PENDING";
      polls += 1;
      if (status === "FINALIZED" && (opts.finalResult ?? "MAJORITY_AGREE") === "MAJORITY_AGREE") {
        pending(final);
        pending(nonfinal);
        pending = null;
      }
      return txWithStatus(status, TX_HASH, status === "FINALIZED" ? (opts.finalResult ?? "MAJORITY_AGREE") : "MAJORITY_AGREE");
    },
    readContract: async (_address, method, args, variant) => {
      calls.push(`${method}@${variant}`);
      const s = variant === "latest-final" ? final : nonfinal;
      if (args[0] !== CASE_ID) throw new Error("gen_call failed: [EXPECTED] case not found");
      if (method === "get_case") return structuredClone(s.case);
      if (method === "get_case_evidence") return structuredClone(s.evidence);
      if (method === "get_assessment_status") {
        const attempts = s.case.assessment_attempts as number;
        const ready = s.case.status === "READY_FOR_ASSESSMENT";
        return { case_id: CASE_ID, status: s.case.status, has_assessment: s.case.status === "DECIDED", attempts, max_attempts: 2, remaining_attempts: ready ? 2 - attempts : 0, can_request: ready && attempts < 2, last_error: "", schema_version: "vericourt-assessment-v2" };
      }
      throw new Error(`unexpected read ${method}`);
    },
  };
  return {
    reader,
    calls,
    /** The wallet "broadcast" a transaction that will apply `mutate` at finality. */
    accept(mutate: (s: CaseState) => void) {
      pending = mutate;
    },
    /** Apply a change to final state directly (no known transaction). */
    applyFinal(mutate: (s: CaseState) => void) {
      mutate(final);
      mutate(nonfinal);
    },
    get final() {
      return final;
    },
    reset(s: CaseState) {
      final = structuredClone(s);
      nonfinal = structuredClone(s);
    },
  };
}

function deps(session: DurableWriteSession, wallet: ReturnType<typeof eventfulWallet>, reader: ExperimentReader): FlowDeps {
  vi.stubGlobal("fetch", fakeRpc(PRE_SEND_READS).fetch);
  let clock = START_MS;
  let ids = 0;
  return {
    session,
    reader,
    wallet,
    makeWriteClient: createSdkWriteClient,
    expectedCodeSha256: CODE_SHA,
    sha256Hex: async (text) => (text === CODE ? CODE_SHA : "different"),
    randomId: () => `op-${++ids}`,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    timing: FAST_TIMING,
  };
}

async function setup(initial: CaseState, mutate: (s: CaseState) => void, studioOpts: Parameters<typeof caseStudio>[1] = {}, walletReply?: () => { result: unknown }) {
  const storage = fakeStorage();
  const studio = caseStudio(initial, studioOpts);
  const wallet = eventfulWallet({
    send: () => {
      studio.accept(mutate);
      return walletReply?.() ?? { result: TX_HASH };
    },
  });
  const session = await DurableWriteSession.open(new PendingStore(storage), memoryLock());
  return { storage, studio, wallet, session, deps: deps(session, wallet, studio.reader) };
}

const submit = (d: FlowDeps, spec: WriteSpec, acknowledged = true) => submitWrite(d, { gate: ENABLED_GATE, wallet: CONNECTED, spec, acknowledged });

function stored(storage: ReturnType<typeof fakeStorage>) {
  const p = parseRecord(storage.data.get(PENDING_KEY) ?? "");
  if (!p.ok) throw new Error(p.reason);
  return p.record;
}

const EVIDENCE: SubmitEvidenceInput = {
  caseId: CASE_ID,
  evidenceType: "LINK",
  label: "Delivered build",
  description: "The build as delivered.",
  contentRef: "https://example.org/build",
  sha256: HASH,
  issueIds: ["I1"],
};

function addEvidence(s: CaseState, from = SENDER) {
  const n = s.evidence.length + 1;
  s.evidence.push({ evidence_id: `E${n}`, submitter: from, label: EVIDENCE.label, description: EVIDENCE.description, content_ref: EVIDENCE.contentRef, sha256: HASH.toLowerCase() });
  s.case.evidence_count = n;
  s.case.claimant_evidence_count = (s.case.claimant_evidence_count as number) + 1;
}

/** The wallet received exactly the calldata built from the reviewed spec (method and arguments). */
function expectSentCalldata(wallet: ReturnType<typeof eventfulWallet>, spec: WriteSpec) {
  const tx = wallet.sends[0]?.[0] as { data: Hex };
  expect(decodeAddTransactionV5(tx.data)).not.toBeNull();
  const intent = buildWriteIntent({ operationId: "x", chain: studionetWriteParams(), sender: SENDER, contractAddress: CONTRACT, method: spec.method, args: spec.args });
  expect(tx.data).toBe(intent.calldata);
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("submit_evidence", () => {
  it("one request, the exact reviewed arguments, finality, then a latest-final read shows the new item: verified", async () => {
    const { storage, wallet, session, deps: d } = await setup(baseCase(), addEvidence);
    const { outcome, simulatedCaseId } = await submit(d, submitEvidenceSpec(EVIDENCE));
    expect(simulatedCaseId).toBe("E1");
    expect(outcome).toMatchObject({ kind: "submitted", txHash: TX_HASH });
    expect(wallet.sends).toHaveLength(1);
    expectSentCalldata(wallet, submitEvidenceSpec(EVIDENCE));
    expect(submitEvidenceSpec(EVIDENCE).args[5]).toBe(HASH.toLowerCase());
    expect(stored(storage).expectedEffect).toMatchObject({ kind: "submit_evidence", baselineEvidenceCount: 0, sha256: HASH.toLowerCase() });

    const r = await monitorToFinality(d);
    expect(r).toEqual({ kind: "verified", caseId: CASE_ID });
    expect(session.state?.note).toMatch(/E1 in VC-000005 matches the intended evidence/);
    expect(statusMessage(session.current)?.headline).toBe("Evidence recorded and confirmed");
  });

  it.each<[string, CaseState, Parameters<typeof caseStudio>[1], RegExp]>([
    ["the sender is not a party", baseCase({ claimant: `0x${"77".repeat(20)}` }), {}, /not a party/],
    ["the record is locked", baseCase({ status: "READY_FOR_ASSESSMENT", snapshot_locked: true }), {}, /no longer accepts evidence/],
    ["the case has non-final changes", baseCase(), { nonFinalDiffers: true }, /not final yet/],
    ["the party quota is reached", baseCase({ claimant_evidence_count: 10, evidence_count: 10 }), {}, /limit of 10/],
    ["the simulation fails (e.g. deadline passed)", baseCase(), { simulate: () => { throw new Error("gen_call failed: [EXPECTED] evidence window has closed"); } }, /preflight check failed/],
    ["the simulation returns an unexpected id", baseCase(), { simulate: () => "E7" }, /next evidence ID/],
  ])("refused before any request when %s", async (_name, initial, studioOpts, message) => {
    const { storage, wallet, deps: d } = await setup(initial, addEvidence, studioOpts);
    await expect(submit(d, submitEvidenceSpec(EVIDENCE))).rejects.toThrow(message);
    expect(wallet.sends).toHaveLength(0);
    expect(storage.data.has(PENDING_KEY)).toBe(false);
  });

  it.each([
    ["after the deadline, even though StudioNet's lagging simulation would accept it", NOW_S - 60],
    ["less than 10 minutes before the deadline", NOW_S + 599],
  ])("refused %s", async (_n, deadline) => {
    const { wallet, deps: d } = await setup(baseCase({ reply_deadline: deadline }), addEvidence);
    await expect(submit(d, submitEvidenceSpec(EVIDENCE))).rejects.toThrow(/deadline has passed or is less than 10 minutes away/);
    expect(wallet.sends).toHaveLength(0);
  });

  it("an unknown issue is refused from the fresh case read", async () => {
    const { wallet, deps: d } = await setup(baseCase(), addEvidence);
    await expect(submit(d, submitEvidenceSpec({ ...EVIDENCE, issueIds: ["I4"] }))).rejects.toThrow(/unknown issue I4/);
    expect(wallet.sends).toHaveLength(0);
  });

  it("invalid input is refused before the lock (no reads, no request)", async () => {
    const { studio, wallet, deps: d } = await setup(baseCase(), addEvidence);
    await expect(submit(d, submitEvidenceSpec({ ...EVIDENCE, contentRef: "javascript:alert(1)" }))).rejects.toBeInstanceOf(PreflightFailed);
    expect(studio.calls).toEqual([]);
    expect(wallet.sends).toHaveLength(0);
  });

  it("two identical new items after the baseline: ambiguous, never success", async () => {
    const { session, deps: d } = await setup(baseCase(), (s) => {
      addEvidence(s);
      addEvidence(s);
    });
    await submit(d, submitEvidenceSpec(EVIDENCE));
    const r = await monitorToFinality(d);
    expect(r.kind).toBe("verification_unavailable");
    expect(session.state?.phase).toBe("finalized");
  });

  it("an identical item submitted before the write does not count as its effect (baseline)", async () => {
    const earlier = baseCase();
    addEvidence(earlier);
    const { session, deps: d, storage } = await setup(earlier, () => undefined);
    await submit(d, submitEvidenceSpec(EVIDENCE));
    expect(stored(storage).expectedEffect).toMatchObject({ baselineEvidenceCount: 1 });
    expect((await monitorToFinality(d)).kind).toBe("verification_mismatch");
    expect(session.state?.phase).toBe("verification_mismatch");
  });

  it("finalized, but no new item: verification mismatch", async () => {
    const { session, deps: d } = await setup(baseCase(), () => undefined);
    await submit(d, submitEvidenceSpec(EVIDENCE));
    expect((await monitorToFinality(d)).kind).toBe("verification_mismatch");
    expect(statusMessage(session.current)?.headline).toBe("Finalized, but the intended change was not found");
  });

  it("malformed wallet answer, then the item appears in final state: confirmed by state, never resent", async () => {
    const { studio, wallet, session, deps: d } = await setup(baseCase(), addEvidence, {}, () => ({ result: 42 }));
    expect((await submit(d, submitEvidenceSpec(EVIDENCE))).outcome).toMatchObject({ kind: "uncertain" });
    expect(session.blockedReason).toMatch(/unresolved/);
    expect((await reconcileUncertain(d)).kind).toBe("unresolved");
    studio.applyFinal(addEvidence);
    expect((await reconcileUncertain(d)).kind).toBe("effect_final");
    expect(session.state?.phase).toBe("confirmed_by_state");
    expect(statusMessage(session.current)?.headline).toBe("Evidence confirmed by contract state (limited evidence)");
    expect(wallet.sends).toHaveLength(1);
  });
});

describe("submit_reply", () => {
  const reply = (s: CaseState) => {
    Object.assign(s.case, { response_state: "SUBMITTED", reply: "My account.", status: "READY_FOR_ASSESSMENT", snapshot_locked: true });
  };

  it("the respondent's reply: verified", async () => {
    const { session, wallet, deps: d } = await setup(baseCase({ claimant: OTHER, respondent: SENDER }), reply);
    await submit(d, submitReplySpec({ caseId: CASE_ID, reply: "My account." }));
    expect(wallet.sends).toHaveLength(1);
    expectSentCalldata(wallet, submitReplySpec({ caseId: CASE_ID, reply: "My account." }));
    expect((await monitorToFinality(d)).kind).toBe("verified");
    expect(statusMessage(session.current)?.headline).toBe("Reply recorded and confirmed");
  });

  it("refused for the claimant, and when the case is no longer awaiting a reply", async () => {
    const a = await setup(baseCase(), reply);
    await expect(submit(a.deps, submitReplySpec({ caseId: CASE_ID, reply: "x" }))).rejects.toThrow(/only the respondent/);
    const b = await setup(baseCase({ claimant: OTHER, respondent: SENDER, response_state: "NO_RESPONSE_BY_DEADLINE", status: "READY_FOR_ASSESSMENT", snapshot_locked: true }), reply);
    await expect(submit(b.deps, submitReplySpec({ caseId: CASE_ID, reply: "x" }))).rejects.toThrow(/not awaiting a reply/);
    expect(a.wallet.sends.length + b.wallet.sends.length).toBe(0);
  });

  it("refused after the deadline by this device's clock (the simulation would still accept it)", async () => {
    const { wallet, deps: d } = await setup(baseCase({ claimant: OTHER, respondent: SENDER, reply_deadline: NOW_S - 60 }), reply);
    await expect(submit(d, submitReplySpec({ caseId: CASE_ID, reply: "x" }))).rejects.toThrow(/deadline has passed or is less than 10 minutes away/);
    expect(wallet.sends).toHaveLength(0);
  });

  it("a simulation that returns a value for a None method is refused", async () => {
    const { wallet, deps: d } = await setup(baseCase({ claimant: OTHER, respondent: SENDER }), reply, { simulate: () => "unexpected" });
    await expect(submit(d, submitReplySpec({ caseId: CASE_ID, reply: "x" }))).rejects.toThrow(/unexpected value/);
    expect(wallet.sends).toHaveLength(0);
  });
});

describe("process_reply_deadline", () => {
  const expire = (s: CaseState) => Object.assign(s.case, { response_state: "NO_RESPONSE_BY_DEADLINE", status: "READY_FOR_ASSESSMENT", snapshot_locked: true });

  const passed = () => baseCase({ reply_deadline: NOW_S - 3600 });
  /** StudioNet's simulation clock lags real time: its simulation still says the deadline has not passed. */
  const laggingSimulation = {
    simulate: (method: string) => {
      if (method === "process_reply_deadline") throw new Error("gen_call failed: [EXPECTED] reply deadline has not passed");
      return null;
    },
  };

  it("either party records the missed deadline: verified, without simulating (the simulation clock lags)", async () => {
    const { studio, session, wallet, deps: d } = await setup(passed(), expire, laggingSimulation);
    await submit(d, processDeadlineSpec(CASE_ID));
    expect(studio.calls.some((c) => c.startsWith("simulate"))).toBe(false);
    expect(wallet.sends).toHaveLength(1);
    expect((await monitorToFinality(d)).kind).toBe("verified");
    expect(statusMessage(session.current)?.headline).toBe("Missed deadline recorded and confirmed");
  });

  it.each([
    ["before the deadline", NOW_S + 3600],
    ["less than 10 minutes after it", NOW_S - 599],
  ])("refused %s by this device's clock, before any request", async (_n, deadline) => {
    const { wallet, storage, deps: d } = await setup(baseCase({ reply_deadline: deadline }), expire);
    await expect(submit(d, processDeadlineSpec(CASE_ID))).rejects.toThrow(/less than 10 minutes ago, or has not passed/);
    expect(wallet.sends).toHaveLength(0);
    expect(storage.data.has(PENDING_KEY)).toBe(false);
  });

  it("allowed from exactly 10 minutes after the deadline", async () => {
    const { wallet, deps: d } = await setup(baseCase({ reply_deadline: NOW_S - 600 }), expire);
    await submit(d, processDeadlineSpec(CASE_ID));
    expect(wallet.sends).toHaveLength(1);
  });

  it("an unreadable deadline is refused", async () => {
    const { wallet, deps: d } = await setup(baseCase({ reply_deadline: "soon" }), expire);
    await expect(submit(d, processDeadlineSpec(CASE_ID))).rejects.toThrow(/deadline could not be read/);
    expect(wallet.sends).toHaveLength(0);
  });
});

describe("request_assessment", () => {
  const ready = (over: Obj = {}) => baseCase({ status: "READY_FOR_ASSESSMENT", snapshot_locked: true, response_state: "NO_RESPONSE_BY_DEADLINE", ...over });
  const decide = (s: CaseState) => Object.assign(s.case, { status: "DECIDED", assessment_attempts: (s.case.assessment_attempts as number) + 1 });

  it("never simulates (that would run the model); verified when the attempt count rises", async () => {
    const { studio, session, storage, deps: d } = await setup(ready(), decide);
    await submit(d, requestAssessmentSpec(CASE_ID, { lastAttemptAcknowledged: false }));
    expect(studio.calls.some((c) => c.startsWith("simulate"))).toBe(false);
    expect(stored(storage).expectedEffect).toEqual({ kind: "request_assessment", caseId: CASE_ID, baselineAttempts: 0 });
    expect((await monitorToFinality(d)).kind).toBe("verified");
    expect(session.state?.note).toMatch(/now shows 1 attempt\(s\) \(was 0\); status DECIDED/);
    expect(statusMessage(session.current)?.body).toMatch(/Open the case to see whether an assessment was stored/);
  });

  it("the last remaining attempt needs its own acknowledgement", async () => {
    const { wallet, deps: d } = await setup(ready({ assessment_attempts: 1 }), decide);
    await expect(submit(d, requestAssessmentSpec(CASE_ID, { lastAttemptAcknowledged: false }))).rejects.toThrow(/last allowed attempt/);
    expect(wallet.sends).toHaveLength(0);
    await submit(d, requestAssessmentSpec(CASE_ID, { lastAttemptAcknowledged: true }));
    expect(wallet.sends).toHaveLength(1);
  });

  it("refused when the case is not ready", async () => {
    const { wallet, deps: d } = await setup(baseCase(), decide);
    await expect(submit(d, requestAssessmentSpec(CASE_ID, { lastAttemptAcknowledged: true }))).rejects.toThrow(/not ready/);
    expect(wallet.sends).toHaveLength(0);
  });

  it("a transaction finalized without agreement is reported as changing nothing and using no attempt", async () => {
    const { session, deps: d } = await setup(ready(), decide, { timeline: ["FINALIZED"], finalResult: "MAJORITY_DISAGREE" });
    await submit(d, requestAssessmentSpec(CASE_ID, { lastAttemptAcknowledged: false }));
    expect((await monitorToFinality(d)).kind).toBe("finalized_unsuccessful");
    const msg = statusMessage(session.current)!;
    expect(msg.headline).toBe("The transaction finalized without recording an assessment attempt");
    expect(msg.body).toMatch(/does not use an attempt/);
  });

  it("an unresolved earlier write blocks the next one in every method", async () => {
    const { deps: d } = await setup(ready(), decide, {}, () => ({ result: 42 }));
    await submit(d, requestAssessmentSpec(CASE_ID, { lastAttemptAcknowledged: false }));
    await expect(submit(d, processDeadlineSpec(CASE_ID))).rejects.toBeInstanceOf(WriteRefused);
  });
});
