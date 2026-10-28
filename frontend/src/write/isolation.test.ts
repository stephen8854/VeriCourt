import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { CONTRACT_WRITES_ENABLED } from "../config/network";

const SRC = join(process.cwd(), "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/**
 * The only src/write modules UI code may import: pure, no SDK, no guard
 * runtime, no wallet calls. (createCase: input + display; pendingStore: read
 * the safety status; methods: the method list.)
 */
const UI_ALLOWED = new Set(["createCase", "pendingStore", "methods"]);

/** Value imports these UI-allowed modules may make (type-only imports are erased and are allowed). */
const RUNTIME_DEPS_ALLOWED = /^(\.\.\/contract\/enums|\.\.\/tx\/state|\.\/methods)$/;

describe("the guarded write path is not connected to the application", () => {
  it("writes stay disabled", () => {
    expect(CONTRACT_WRITES_ENABLED).toBe(false);
  });

  it("outside src/write and src/experiment, only the pure UI-allowed modules are imported", () => {
    const offending: string[] = [];
    for (const f of sourceFiles(SRC)) {
      const rel = relative(SRC, f);
      if (rel.startsWith("write") || rel.startsWith("test") || rel.startsWith("experiment")) continue;
      for (const m of readFileSync(f, "utf8").matchAll(/from\s+["'](?:\.\.?\/)+write\/([A-Za-z]+)["']/g)) {
        if (!UI_ALLOWED.has(m[1]!)) offending.push(`${rel} -> write/${m[1]!}`);
      }
    }
    expect(offending).toEqual([]);
  });

  it("the UI-allowed modules have no runtime dependency on the SDK, guard, wallet or network", () => {
    for (const name of UI_ALLOWED) {
      const text = readFileSync(join(SRC, "write", `${name}.ts`), "utf8");
      for (const m of text.matchAll(/^import\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']/gm)) {
        if (m[1]) continue; // type-only import
        expect(m[2], `${name}.ts imports ${m[2]}`).toMatch(RUNTIME_DEPS_ALLOWED);
      }
      expect(text).not.toMatch(/genlayer-js|viem|\.request\(|fetch\(/);
    }
  });

  it("src/experiment is reached only through the one gated dynamic import in WritePreview", () => {
    const refs: string[] = [];
    for (const f of sourceFiles(SRC)) {
      const rel = relative(SRC, f);
      if (rel.startsWith("experiment") || rel.startsWith("test")) continue; // test helpers drive it directly
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(/["'](?:\.\.?\/)+experiment\/[^"']*["']/g)) refs.push(`${rel}: ${m[0]}`);
    }
    expect(refs).toEqual([`${join("pages", "WritePreview.tsx")}: "../experiment/ExperimentWritePanel"`]);
    const page = readFileSync(join(SRC, "pages", "WritePreview.tsx"), "utf8");
    // The literal comparison Vite folds to false in ordinary builds, guarding a lazy (dynamic) import only.
    expect(page).toMatch(/import\.meta\.env\.MODE === "write-experiment"\s*\?\s*lazy\(\(\) => import\("\.\.\/experiment\/ExperimentWritePanel"\)/);
    expect(page).not.toMatch(/^import[^;]*experiment/m);
  });

  it("no page or component calls a write method of the guard path", () => {
    for (const f of sourceFiles(SRC).filter((p) => /[\\/](pages|components|app)[\\/]/.test(p))) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/writeContract|eth_sendTransaction|DurableWriteSession|runGuardedWrite|createGuardedProvider/);
    }
  });

  it("the read-only case views (src/cases, case pages) make no wallet request and no write", () => {
    const files = sourceFiles(join(SRC, "cases")).concat(["CaseDetail.tsx", "CaseReport.tsx", "Dashboard.tsx"].map((n) => join(SRC, "pages", n)));
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/eth_requestAccounts|eth_sendTransaction|writeContract|simulateWriteContract|\.request\(|DurableWriteSession|createGuardedProvider/);
      expect(text, f).not.toMatch(/["'](?:\.\.?\/)+experiment\//);
    }
  });

  it("src/write never generates keys, and only pendingStore touches browser storage", () => {
    for (const f of sourceFiles(join(SRC, "write"))) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/generatePrivateKey|privateKeyToAccount|createAccount\(|mnemonic|import\.meta\.env/);
      if (!f.endsWith("pendingStore.ts")) expect(text, f).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    }
  });
});
