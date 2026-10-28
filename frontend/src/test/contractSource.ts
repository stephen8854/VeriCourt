/** Test helper: reads Python constants from contracts/vericourt.py without executing it. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Vitest runs with the frontend/ directory as the working directory.
const CONTRACT_PATH = resolve(process.cwd(), "..", "contracts", "vericourt.py");

export const contractSource: string = readFileSync(CONTRACT_PATH, "utf8");

/** Value of `NAME = "literal"`. */
export function pyString(name: string): string {
  const m = new RegExp(`^${name} = "([^"]*)"`, "m").exec(contractSource);
  if (m?.[1] === undefined) throw new Error(`constant ${name} not found`);
  return m[1];
}

/** Body of `NAME = ( ... )` up to the matching close paren at line start. */
function parenBody(name: string): string {
  const m = new RegExp(`^${name} = \\(\\n([\\s\\S]*?)^\\)`, "m").exec(contractSource);
  if (m?.[1] === undefined) throw new Error(`parenthesised constant ${name} not found`);
  return m[1];
}

/** Implicitly concatenated string literal: `NAME = ("a" "b")`. */
export function pyConcatString(name: string): string {
  return [...parenBody(name).matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]).join("");
}

/** Tuple of strings whose elements may each be split over several literals. */
export function pyStringTuple(name: string): string[] {
  const items: string[] = [];
  let current: string[] = [];
  for (const tok of parenBody(name).matchAll(/"((?:[^"\\]|\\.)*)"|,/g)) {
    if (tok[0] === ",") {
      if (current.length > 0) items.push(current.join(""));
      current = [];
    } else {
      current.push(tok[1] ?? "");
    }
  }
  if (current.length > 0) items.push(current.join(""));
  return items;
}

/** Tuple of names, e.g. `OUTCOMES = (OUTCOME_A, OUTCOME_B)` resolved to their string values. */
export function pyNameTuple(name: string): string[] {
  const m = new RegExp(`^${name} = \\(([^)]*)\\)`, "m").exec(contractSource);
  if (m?.[1] === undefined) throw new Error(`tuple ${name} not found`);
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .map((s) => (s.startsWith('"') ? s.slice(1, -1) : pyString(s)));
}
