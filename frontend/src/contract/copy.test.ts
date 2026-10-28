import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BEFORE_YOU_SUBMIT_BODY,
  BEFORE_YOU_SUBMIT_LEAD,
  CONSENSUS_NOT_TRUTH,
  EXTERNAL_LINKS_CAN_CHANGE,
  FILE_HASH_NOTE,
  MISSING_RESPONSE_NOTE,
  REPORT_LABEL,
} from "./copy";

const ROOT = join(process.cwd(), "..");
const brief = readFileSync(join(ROOT, "VeriCourt_Claude_Code_Build_Brief.md"), "utf8");
const spec = readFileSync(join(ROOT, "VeriCourt_Product_Protocol_Design_Spec.md"), "utf8");

describe("mandatory copy is verbatim from the brief and spec", () => {
  it("'Before you submit' matches brief §10 and spec §13 exactly", () => {
    const quoted = `> **${BEFORE_YOU_SUBMIT_LEAD}** ${BEFORE_YOU_SUBMIT_BODY}`;
    expect(brief).toContain(quoted);
    expect(spec).toContain(quoted);
  });

  it.each([
    ["external links", EXTERNAL_LINKS_CAN_CHANGE, brief],
    ["consensus", CONSENSUS_NOT_TRUTH, brief],
    ["file hash (spec wording)", FILE_HASH_NOTE, spec],
    ["missing response (spec wording)", MISSING_RESPONSE_NOTE, spec],
  ])("%s", (_name, text, doc) => {
    expect(doc).toContain(text);
  });

  it("the report label matches the brief and spec", () => {
    expect(brief).toContain(`“${REPORT_LABEL}”`);
    expect(spec).toContain(`“${REPORT_LABEL}”`);
  });
});
