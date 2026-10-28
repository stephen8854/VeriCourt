import { decodeInputData } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { describe, expect, it } from "vitest";
import recorded from "../fixtures/recorded/phase-2-8-assessment-tx.json";
import { CONTRACT, SENDER, testIntent } from "../test/writeHarness";
import { ADD_TRANSACTION_V5_SELECTOR, decodeAddTransactionV5, encodeAddTransactionV5 } from "./addTransaction";
import { RlpError, bytesToHex, hexToBytes, parseLegacySignedTransaction, rlpDecode, rlpEncode, type Hex } from "./bytes";
import { buildWriteIntent, encodeContractCall, studionetWriteParams } from "./intent";

const signed = recorded.sim_config.signed_rollup_transaction as Hex;

describe("RLP and legacy transaction parsing", () => {
  it("parses the recorded Phase 2.8 StudioNet transaction", () => {
    const tx = parseLegacySignedTransaction(signed);
    expect(tx.chainId).toBe(61999n);
    expect(tx.gasPrice).toBe(0n);
    expect(tx.value).toBe(0n);
    expect(tx.to).toBe("0x0000000000000000000000000000000000000000"); // genlayer-py sent to 0x0 (Phase 3.5 §2)
    expect(tx.data.slice(0, 10)).toBe(ADD_TRANSACTION_V5_SELECTOR);
  });

  it("re-encodes the recorded transaction byte for byte", () => {
    expect(bytesToHex(rlpEncode(rlpDecode(hexToBytes(signed))))).toBe(signed.toLowerCase());
  });

  it.each([
    ["trailing bytes", "0xc00000"],
    ["single byte wrapped in a string", "0x8105"],
    ["long form for a short string", "0xb80141"],
    ["truncated list", "0xc4800102"],
  ])("rejects %s", (_name, hex) => {
    expect(() => rlpDecode(hexToBytes(hex))).toThrow(RlpError);
  });

  it("rejects typed (non-legacy) transactions", () => {
    expect(() => parseLegacySignedTransaction("0x02c0")).toThrow(RlpError);
  });
});

describe("V5 addTransaction calldata", () => {
  const recordedData = parseLegacySignedTransaction(signed).data;

  it("decodes the recorded call and re-encodes it exactly", () => {
    const args = decodeAddTransactionV5(recordedData);
    expect(args).not.toBeNull();
    expect(args!.sender.toLowerCase()).toBe(recorded.from_address.toLowerCase());
    expect(args!.recipient.toLowerCase()).toBe(recorded.to_address.toLowerCase());
    expect(args!.numOfInitialValidators).toBe(5n);
    expect(args!.maxRotations).toBe(3n);
    expect(encodeAddTransactionV5(args!)).toBe(recordedData.toLowerCase());
  });

  it("the recorded _txData is the request_assessment call the contract executed", () => {
    const decoded = decodeInputData(decodeAddTransactionV5(recordedData)!.txData, recorded.to_address as Hex);
    expect(decoded).toMatchObject({ type: "call", leaderOnly: false });
    expect(decoded && "callData" in decoded ? decoded.callData : null).toEqual(
      new Map<string, unknown>([["args", ["VC-000001"]], ["method", "request_assessment"]]),
    );
  });

  it("genlayer-js encodes leaderOnly=false differently from the recorded genlayer-py write", () => {
    // Same GenVM calldata; only the RLP item for leaderOnly differs:
    // genlayer-js serializes `false` as the byte 0x00, genlayer-py sent the empty string (0x80).
    // Whether StudioNet accepts the genlayer-js form is UNVERIFIED until Stage A.
    const js = encodeContractCall("request_assessment", ["VC-000001"]);
    const py = decodeAddTransactionV5(recordedData)!.txData;
    expect(js.slice(0, -2)).toBe(py.slice(0, -2));
    expect(js.slice(-2)).toBe("00");
    expect(py.slice(-2)).toBe("80");
    // The SDK's own decoder reads both as leaderOnly=false.
    expect(decodeInputData(js, CONTRACT)).toMatchObject({ type: "call", leaderOnly: false });
  });

  it.each([
    ["wrong selector", (d: string) => `0xdeadbeef${d.slice(10)}`],
    ["truncated", (d: string) => d.slice(0, d.length - 64)],
    ["non-zero address padding", (d: string) => `${d.slice(0, 10)}ff${d.slice(12)}`],
    ["wrong bytes offset", (d: string) => `${d.slice(0, 10 + 4 * 64)}${"0".repeat(62)}c0${d.slice(10 + 5 * 64)}`],
    ["dirty tail padding", (d: string) => `${d.slice(0, d.length - 2)}01`],
  ])("rejects calldata with %s", (_name, mutate) => {
    expect(decodeAddTransactionV5(mutate(recordedData.toLowerCase()))).toBeNull();
  });
});

describe("write intents", () => {
  it("uses the SDK's own studionet parameters, including its static consensus address", () => {
    const p = studionetWriteParams();
    expect(p).toEqual({
      chainId: 61999,
      consensusAddress: studionet.consensusMainContract?.address,
      numOfInitialValidators: 5n,
      maxRotations: 3n,
    });
    // Recorded so a dependency change cannot silently move the target (Phase 3.5 §2: unresolved vs 0x0).
    expect(p.consensusAddress).toBe("0xb7278A61aa25c888815aFC32Ad3cC52fF24fE575");
  });

  it("binds sender, recipient, method and arguments into the exact calldata", () => {
    const intent = testIntent({ method: "create_case", args: ["0x" + "2b".repeat(20), "SOFTWARE", "Fictional"] });
    const args = decodeAddTransactionV5(intent.calldata)!;
    expect(args.sender).toBe(SENDER.toLowerCase());
    expect(args.recipient).toBe(CONTRACT.toLowerCase());
    expect(intent.selector).toBe(ADD_TRANSACTION_V5_SELECTOR);
    expect(intent.expectedNonce).toBeNull();
    expect(Object.isFrozen(intent)).toBe(true);
  });

  it.each([
    ["a bad operation id", { operationId: "op 1; DROP" }],
    ["a non-address sender", { sender: "0x1234" as Hex }],
    ["a view method", { method: "get_case" as never }],
  ])("refuses %s", (_name, override) => {
    expect(() =>
      buildWriteIntent({
        operationId: "op-1",
        chain: studionetWriteParams(),
        sender: SENDER,
        contractAddress: CONTRACT,
        method: "request_assessment",
        args: ["VC-1"],
        ...override,
      }),
    ).toThrow();
  });
});
