import { describe, expect, it, vi } from "vitest";
import { PHASE_2_17C_NO_REPLY } from "../config/testDeployments";
import { fakeGateway, nodeSha256Hex } from "../test/fakeGateway";
import { categoriseError, ReadTimeoutError, withTimeout } from "./errors";
import { recordedNoReplyCaseReads } from "./expected";
import { runReadCheck, type ReadCheckOptions } from "./readCheck";

const OPTS: ReadCheckOptions = { timeoutMs: 1000, sha256Hex: nodeSha256Hex };
const run = (gateway: Parameters<typeof runReadCheck>[0], opts: Partial<ReadCheckOptions> = {}) =>
  runReadCheck(gateway, PHASE_2_17C_NO_REPLY, recordedNoReplyCaseReads(), { ...OPTS, ...opts });

describe("read-only check against an offline fake built from recorded data (NOT a live result)", () => {
  it("runs every step once, in order, and matches the recording", async () => {
    const { gateway, impl } = fakeGateway();
    const report = await run(gateway);
    expect(report.stoppedAt).toBeNull();
    expect(report.steps.every((s) => s.outcome === "ok")).toBe(true);
    expect(report.steps.map((s) => s.id)).toEqual([
      "rpc.chain",
      "deploy.tx",
      "deploy.code",
      "read.latest-nonfinal.get_contract_info",
      "read.latest-nonfinal.get_case_count",
      "case.exists",
      ...["latest-nonfinal", "latest-final"].flatMap((v) =>
        ["get_case", "get_case_status", "get_case_evidence", "get_case_history", "get_assessment_status", "get_assessment"].map(
          (m) => `read.${v}.${m}`,
        ),
      ),
      ...PHASE_2_17C_NO_REPLY.transactions.map((t) => `tx.${t.operation}`),
    ]);
    expect(impl.chainId).toHaveBeenCalledTimes(1);
    expect(impl.getContractCode).toHaveBeenCalledTimes(1);
    expect(impl.readContract).toHaveBeenCalledTimes(14);
    expect(impl.getTransaction).toHaveBeenCalledTimes(7); // deploy confirmation + six known transactions
    const readSteps = report.steps.filter((s) => s.id.startsWith("read.latest-"));
    expect(readSteps.filter((s) => s.matchesRecorded === true)).toHaveLength(12);
  });

  it("every read passes an explicit consistency mode", async () => {
    const { gateway, impl } = fakeGateway();
    await run(gateway);
    const variants = vi.mocked(impl.readContract).mock.calls.map((c) => c[3]);
    expect(new Set(variants)).toEqual(new Set(["latest-nonfinal", "latest-final"]));
  });

  it("stops before any contract read on the wrong chain", async () => {
    const { gateway, impl } = fakeGateway({ chainId: "0x1" });
    const report = await run(gateway);
    expect(report.stoppedAt).toBe("rpc.chain");
    expect(report.steps[0]).toMatchObject({ outcome: "mismatch" });
    expect(impl.readContract).not.toHaveBeenCalled();
    expect(impl.getContractCode).not.toHaveBeenCalled();
  });

  it("stops before contract reads when the deployed code does not match", async () => {
    const { gateway, impl } = fakeGateway({ code: "# some other contract" });
    const report = await run(gateway);
    expect(report.stoppedAt).toBe("deploy.code");
    expect(report.steps.at(-1)).toMatchObject({ outcome: "mismatch", matchesRecorded: false });
    expect(impl.readContract).not.toHaveBeenCalled();
  });

  it("stops when the deploy transaction names a different contract address", async () => {
    const { gateway, impl } = fakeGateway({ deployAddress: `0x${"99".repeat(20)}` });
    const report = await run(gateway);
    expect(report.stoppedAt).toBe("deploy.tx");
    expect(impl.readContract).not.toHaveBeenCalled();
  });

  it("a malformed response is reported as malformed, never as data", async () => {
    const { gateway } = fakeGateway({
      overrideRead: (m, v) => (m === "get_assessment" && v === "latest-final" ? Promise.resolve({ exists: true, outcome: 7 }) : undefined),
    });
    const report = await run(gateway);
    const step = report.steps.find((s) => s.id === "read.latest-final.get_assessment");
    expect(step).toMatchObject({ outcome: "malformed", decodedAndValid: false });
    expect(report.reads["latest-final"]?.get_assessment).toBeUndefined();
  });

  it("a differing value is a mismatch with the differing paths listed", async () => {
    const { gateway } = fakeGateway({
      overrideRead: (m, v) => {
        if (m !== "get_case_status" || v !== "latest-nonfinal") return undefined;
        const value = { ...(recordedNoReplyCaseReads().get_case_status as object), status: "READY_FOR_ASSESSMENT" };
        return Promise.resolve(value);
      },
    });
    const step = (await run(gateway)).steps.find((s) => s.id === "read.latest-nonfinal.get_case_status");
    expect(step).toMatchObject({ outcome: "mismatch", matchesRecorded: false, details: ["differs from recorded at $.status"] });
  });

  it("a hung request times out once and is not retried", async () => {
    const { gateway, impl } = fakeGateway({ overrideChain: () => new Promise(() => undefined) });
    const report = await run(gateway, { timeoutMs: 20 });
    expect(report.stoppedAt).toBe("rpc.chain");
    expect(report.steps[0]).toMatchObject({ outcome: "error", responseReceived: false, error: { category: "timeout" } });
    expect(impl.chainId).toHaveBeenCalledTimes(1);
  });

  it("a browser fetch failure (e.g. CORS) is categorised and not retried", async () => {
    const { gateway, impl } = fakeGateway({ overrideChain: () => Promise.reject(new TypeError("Failed to fetch")) });
    const report = await run(gateway);
    expect(report.steps[0]).toMatchObject({ responseReceived: false, error: { category: "network_or_cors" } });
    expect(impl.chainId).toHaveBeenCalledTimes(1);
  });

  it("a JSON-RPC error object is categorised as an RPC error", async () => {
    const { gateway } = fakeGateway({
      overrideRead: (m) => (m === "get_contract_info" ? Promise.reject({ code: -32000, message: "boom" }) : undefined),
    });
    const report = await run(gateway);
    expect(report.stoppedAt).toBe("read.latest-nonfinal.get_contract_info");
    expect(report.steps.at(-1)).toMatchObject({ responseReceived: true, error: { category: "rpc_error", message: "code -32000: boom" } });
  });

  it("a case beyond case_count is not read", async () => {
    const { gateway, impl } = fakeGateway({ overrideRead: (m) => (m === "get_case_count" ? Promise.resolve(0) : undefined) });
    const report = await run(gateway);
    expect(report.stoppedAt).toBe("case.exists");
    expect(vi.mocked(impl.readContract).mock.calls.map((c) => c[1])).toEqual(["get_contract_info", "get_case_count"]);
  });

  it("the gateway exposes no write method", () => {
    const { gateway } = fakeGateway();
    expect(() => (gateway as unknown as Record<string, unknown>).writeContract).toThrow(/only read-only methods/);
  });
});

describe("timeouts and error categories", () => {
  it("withTimeout rejects with ReadTimeoutError", async () => {
    await expect(withTimeout(new Promise(() => undefined), 10, "x")).rejects.toBeInstanceOf(ReadTimeoutError);
    await expect(withTimeout(Promise.resolve(1), 10, "x")).resolves.toBe(1);
  });

  it.each([
    [new TypeError("Failed to fetch"), "network_or_cors"],
    [Object.assign(new Error("An unknown RPC error occurred.\n\nDetails: Failed to fetch\nVersion: viem@2.57.7"), { name: "UnknownRpcError" }), "network_or_cors"],
    [new SyntaxError("Unexpected token <"), "unparseable_response"],
    [new Error("gen_call failed: reverted"), "rpc_error"],
    [{ code: 429, message: "rate limited" }, "rpc_error"],
    [new Error("decode exploded"), "sdk_error"],
    ["weird", "sdk_error"],
  ])("%s -> %s", (err, category) => {
    expect(categoriseError(err).category).toBe(category);
  });
});
