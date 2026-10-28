import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { REVIEWED_CONTRACT_CODE_SHA256 } from "./contract";
import { PHASE_2_17C_NO_REPLY } from "./testDeployments";

describe("reviewed contract hash", () => {
  it("is the SHA-256 of contracts/vericourt.py and of the test deployment", () => {
    const source = readFileSync(resolve(process.cwd(), "..", "contracts", "vericourt.py"));
    expect(createHash("sha256").update(source).digest("hex")).toBe(REVIEWED_CONTRACT_CODE_SHA256);
    expect(PHASE_2_17C_NO_REPLY.expectedCodeSha256).toBe(REVIEWED_CONTRACT_CODE_SHA256);
  });
});
