/**
 * Phase 4.0B read-only case views, rendered against the recorded StudioNet
 * read-back of VC-000001 through a strict fake gateway (read-only methods
 * only). No network: the test setup fails any fetch.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { resetContractCheckCache } from "../cases/caseReads";
import { PHASE_2_17C_NO_REPLY } from "../config/testDeployments";
import { BEFORE_YOU_SUBMIT_BODY, MANDATORY_SENTENCES, REPORT_LABEL } from "../contract/copy";
import { NOTICE_NO_RESPONSE } from "../contract/notices";
import type { CaseView } from "../contract/types";
import { recordedNoReplyCaseReads } from "../live/expected";
import type { HashVariant, ReadMethod } from "../live/gateway";
import { fakeGateway, nodeSha256Hex } from "../test/fakeGateway";
import { MOCK_ACCOUNT, mockProvider } from "../test/mockProvider";
import { WalletProvider } from "../wallet/WalletContext";
import { CaseDetail } from "./CaseDetail";
import { CaseReport } from "./CaseReport";
import { Dashboard } from "./Dashboard";

const CONTRACT = { status: "set" as const, address: PHASE_2_17C_NO_REPLY.address };
const RECORDED = recordedNoReplyCaseReads().get_case as CaseView;
const INFO = { schema_version: "vericourt-case-v1", case_count: 3, statuses: [], categories: [], evidence_types: [], limits: {}, assessment: { schema_version: "vericourt-assessment-v2" } };

function gw(extra: (m: ReadMethod, v: HashVariant) => Promise<unknown> | undefined = () => undefined, opts: Parameters<typeof fakeGateway>[0] = {}) {
  const g = fakeGateway({
    ...opts,
    overrideRead: (m, v) => extra(m, v) ?? (m === "get_contract_info" ? Promise.resolve(INFO) : m === "get_case_count" ? Promise.resolve(3) : undefined),
  });
  return { ...g, loadGateway: async () => g.gateway };
}

function memory() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}

/** Banned adjudication wording anywhere in the rendered page, except inside the exact mandatory sentences and contract-written text. */
function expectNeutral(text: string) {
  let rest = text;
  for (const s of [...MANDATORY_SENTENCES, NOTICE_NO_RESPONSE]) rest = rest.split(s).join(" ");
  expect(rest).not.toMatch(/\bverdict|\bwinner|\bloser\b|\bruling|\bguilty|\bliable\b/i);
}

beforeEach(() => resetContractCheckCache());

describe("case detail", () => {
  it("renders the recorded case from contract reads, final, with the display-safety wording", async () => {
    const g = gw();
    const storage = memory();
    render(
      <WalletProvider>
        <CaseDetail caseId="VC-000001" contract={CONTRACT} loadGateway={g.loadGateway} sha256Hex={nodeSha256Hex} storage={storage} experimentBuild={false} />
      </WalletProvider>,
    );
    const main = await screen.findByRole("region", { name: /Decision fields accepted through validator agreement/ });
    expect(main).toBeInTheDocument();
    expect(screen.getByLabelText("Case VC-000001")).toHaveTextContent("VC-000001");
    expect(screen.getByText("Final (confirmed by a latest-final read)")).toBeInTheDocument();
    expect(screen.getAllByText("Assessment recorded").length).toBeGreaterThan(0);
    expect(screen.getAllByText(NOTICE_NO_RESPONSE).length).toBeGreaterThan(0);
    // Evidence register and timeline come from the contract.
    expect(screen.getByLabelText("Evidence E1")).toBeInTheDocument();
    expect(screen.getByText("Case created by the claimant")).toBeInTheDocument();
    expect(screen.getByText("Reply window closed with no reply recorded")).toBeInTheDocument();
    // Recorded transactions are listed with their source.
    expect(screen.getByText(PHASE_2_17C_NO_REPLY.transactions[1]!.hash)).toBeInTheDocument();
    // Actions are listed but nothing can be sent in the ordinary build.
    expect(screen.getByRole("heading", { name: "Actions" })).toBeInTheDocument();
    expect(screen.queryAllByRole("link").filter((l) => l.getAttribute("href")?.startsWith("#/review"))).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /sign in wallet/i })).toBeNull();
    expect(screen.getByText(/Contract writes are disabled/)).toBeInTheDocument();
    expectNeutral(document.body.textContent ?? "");
    await waitFor(() => expect(storage.m.get("vericourt.recent-cases.v1")).toContain("VC-000001"));
    expect(g.impl.getTransaction).not.toHaveBeenCalled();
  });

  it("shows the viewer's role from the wallet's passive state, without a prompt", async () => {
    const provider = mockProvider("0xf22f", [RECORDED.claimant]);
    window.ethereum = provider;
    const g = gw();
    render(
      <WalletProvider>
        <CaseDetail caseId="VC-000001" contract={CONTRACT} loadGateway={g.loadGateway} sha256Hex={nodeSha256Hex} storage={null} experimentBuild={false} />
      </WalletProvider>,
    );
    expect(await screen.findByText("You")).toBeInTheDocument();
    expect(provider.methods()).not.toContain("eth_requestAccounts");
  });

  it("an invalid ID shows a message and reads nothing", async () => {
    const g = gw();
    render(
      <WalletProvider>
        <CaseDetail caseId="hello" contract={CONTRACT} loadGateway={g.loadGateway} sha256Hex={nodeSha256Hex} storage={null} />
      </WalletProvider>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/is not a VeriCourt case ID/);
    expect(g.impl.chainId).not.toHaveBeenCalled();
  });

  it("a case that does not exist", async () => {
    const g = gw();
    render(
      <WalletProvider>
        <CaseDetail caseId="VC-000009" contract={CONTRACT} loadGateway={g.loadGateway} sha256Hex={nodeSha256Hex} storage={null} />
      </WalletProvider>,
    );
    expect(await screen.findByText(/This contract has 3 cases; /)).toBeInTheDocument();
  });

  it("an unavailable RPC: explained, nothing changed, and a manual retry", async () => {
    let fail = true;
    const g = gw(() => undefined, {
      overrideChain: async () => {
        if (fail) throw new TypeError("Failed to fetch");
        return "0xf22f";
      },
    });
    render(
      <WalletProvider>
        <CaseDetail caseId="VC-000001" contract={CONTRACT} loadGateway={g.loadGateway} sha256Hex={nodeSha256Hex} storage={null} networkRetryDelayMs={1} />
      </WalletProvider>,
    );
    expect(await screen.findByRole("region", { name: "StudioNet could not be read" })).toHaveTextContent(/safe to repeat/);
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Try the reads again" }));
    expect(await screen.findByText("Final (confirmed by a latest-final read)")).toBeInTheDocument();
  });

  it("contradictory reads are listed and the stored assessment is withheld", async () => {
    const g = gw((m) => (m === "get_case_evidence" ? Promise.resolve([]) : undefined));
    render(
      <WalletProvider>
        <CaseDetail caseId="VC-000001" contract={CONTRACT} loadGateway={g.loadGateway} sha256Hex={nodeSha256Hex} storage={null} />
      </WalletProvider>,
    );
    expect(await screen.findByRole("region", { name: "The reads contradict each other" })).toHaveTextContent(/register lists 0/);
    expect(screen.getByRole("region", { name: "Assessment withheld" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /Decision fields/ })).toBeNull();
  });

  it("an unexpected contract shows no case data", async () => {
    const g = gw(() => undefined, { code: "# not vericourt" });
    render(
      <WalletProvider>
        <CaseDetail caseId="VC-000001" contract={CONTRACT} loadGateway={g.loadGateway} sha256Hex={nodeSha256Hex} storage={null} />
      </WalletProvider>,
    );
    expect(await screen.findByRole("region", { name: "Unexpected contract" })).toBeInTheDocument();
    expect(screen.queryByText(RECORDED.title)).toBeNull();
  });

  it("a passed but unprocessed deadline is described by the device clock, never as no response", async () => {
    const awaiting = { ...RECORDED, status: "AWAITING_RESPONSE", response_state: "PENDING", snapshot_locked: false, locked_at: 0, lock_reason: "", locked_evidence_count: 0, snapshot_digest: "", history_count: 3 };
    const reads = recordedNoReplyCaseReads();
    const history = (reads.get_case_history as unknown[]).slice(0, 3);
    const evidence = (reads.get_case_evidence as Record<string, unknown>[]).map((e) => ({ ...e, in_locked_snapshot: false }));
    const g = gw((m) =>
      m === "get_case"
        ? Promise.resolve(awaiting)
        : m === "get_case_history"
          ? Promise.resolve(history)
          : m === "get_case_evidence"
            ? Promise.resolve(evidence)
            : m === "get_assessment_status"
              ? Promise.resolve({ ...(reads.get_assessment_status as object), status: "AWAITING_RESPONSE", has_assessment: false, can_request: false })
              : m === "get_assessment"
                ? Promise.resolve({ exists: false, case_id: "VC-000001", status: "AWAITING_RESPONSE", attempts: 0, schema_version: "vericourt-assessment-v2" })
                : undefined,
    );
    render(
      <WalletProvider>
        <CaseDetail caseId="VC-000001" contract={CONTRACT} loadGateway={g.loadGateway} sha256Hex={nodeSha256Hex} storage={null} experimentBuild={false} />
      </WalletProvider>,
    );
    const panel = await screen.findByRole("region", { name: /The reply window appears to have closed/ });
    expect(panel).toHaveTextContent(/The contract has not recorded this yet/);
    expect(screen.getByText("No reply recorded yet")).toBeInTheDocument();
    expect(screen.queryByText(NOTICE_NO_RESPONSE)).toBeNull();
    expect(screen.getByRole("region", { name: "No assessment stored" })).toBeInTheDocument();
  });

  it("in the experiment build, an allowed action links to the review page", async () => {
    window.ethereum = mockProvider("0xf22f", [RECORDED.claimant]);
    const awaiting = { ...RECORDED, status: "AWAITING_RESPONSE", response_state: "PENDING", snapshot_locked: false, locked_at: 0, lock_reason: "", locked_evidence_count: 0, snapshot_digest: "", history_count: 3 };
    const reads = recordedNoReplyCaseReads();
    const g = gw((m) =>
      m === "get_case"
        ? Promise.resolve(awaiting)
        : m === "get_case_history"
          ? Promise.resolve((reads.get_case_history as unknown[]).slice(0, 3))
          : m === "get_case_evidence"
            ? Promise.resolve((reads.get_case_evidence as Record<string, unknown>[]).map((e) => ({ ...e, in_locked_snapshot: false })))
            : m === "get_assessment"
              ? Promise.resolve({ exists: false, case_id: "VC-000001", status: "AWAITING_RESPONSE", attempts: 0, schema_version: "vericourt-assessment-v2" })
              : m === "get_assessment_status"
                ? Promise.resolve({ ...(reads.get_assessment_status as object), status: "AWAITING_RESPONSE", has_assessment: false, can_request: false })
                : undefined,
    );
    render(
      <WalletProvider>
        <CaseDetail caseId="VC-000001" contract={CONTRACT} loadGateway={g.loadGateway} sha256Hex={nodeSha256Hex} storage={null} experimentBuild nowSeconds={() => RECORDED.reply_deadline + 600} />
      </WalletProvider>,
    );
    const link = await screen.findByRole("link", { name: "Record the missed reply deadline" });
    expect(link).toHaveAttribute("href", "#/review?action=process_reply_deadline&case=VC-000001");
  });
});

describe("dashboard", () => {
  it("opens a case by ID (validated) and lists recently viewed cases as browser-local", async () => {
    const storage = memory();
    storage.m.set("vericourt.recent-cases.v1", JSON.stringify({ [CONTRACT.address.toLowerCase()]: ["VC-000002"] }));
    render(
      <WalletProvider>
        <Dashboard contract={CONTRACT} storage={storage} experimentBuild={false} loadGateway={gw().loadGateway} sha256Hex={nodeSha256Hex} />
      </WalletProvider>,
    );
    expect(screen.getByRole("link", { name: "VC-000002" })).toHaveAttribute("href", "#/case/VC-000002");
    expect(screen.getByText(/Stored only in this browser/)).toBeInTheDocument();
    const box = screen.getByRole("textbox", { name: "Case ID" });
    await userEvent.type(box, "abc");
    await userEvent.click(screen.getByRole("button", { name: "Open case" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a case ID such as VC-000001.");
    await userEvent.clear(box);
    await userEvent.type(box, "vc-000003");
    await userEvent.click(screen.getByRole("button", { name: "Open case" }));
    expect(window.location.hash).toBe("#/case/VC-000003");
    expect(screen.getByRole("button", { name: "Start a case" })).toBeDisabled();
  });

  it("lists the connected account's cases from the contract's party index", async () => {
    window.ethereum = mockProvider("0xf22f", [MOCK_ACCOUNT]);
    const g = gw((m) => (m === "get_party_case_ids" ? Promise.resolve({ total: 1, case_ids: ["VC-000001"] }) : undefined));
    render(
      <WalletProvider>
        <Dashboard contract={CONTRACT} storage={null} experimentBuild={false} loadGateway={g.loadGateway} sha256Hex={nodeSha256Hex} />
      </WalletProvider>,
    );
    const table = await screen.findByRole("table", { name: /Cases where you are the claimant or the respondent/ });
    expect(within(table).getByRole("link", { name: "VC-000001" })).toBeInTheDocument();
    expect(within(table).getByText("Assessment recorded")).toBeInTheDocument();
  });

  it("without a wallet account, explains how to list cases", () => {
    render(
      <WalletProvider>
        <Dashboard contract={CONTRACT} storage={null} experimentBuild={false} loadGateway={gw().loadGateway} sha256Hex={nodeSha256Hex} />
      </WalletProvider>,
    );
    expect(screen.getByRole("region", { name: "No wallet account known" })).toBeInTheDocument();
  });

  it("in the experiment build, Start a case links to the create form", () => {
    render(
      <WalletProvider>
        <Dashboard contract={CONTRACT} storage={null} experimentBuild loadGateway={gw().loadGateway} sha256Hex={nodeSha256Hex} />
      </WalletProvider>,
    );
    expect(screen.getByRole("link", { name: "Start a case" })).toHaveAttribute("href", "#/review?action=create_case");
  });
});

describe("case report", () => {
  it("is labelled exactly, built from the reads, and includes the known transaction IDs", async () => {
    const g = gw();
    render(<CaseReport caseId="VC-000001" contract={CONTRACT} loadGateway={g.loadGateway} sha256Hex={nodeSha256Hex} storage={null} nowSeconds={() => 1792400000} />);
    const report = await screen.findByRole("article", { name: "Report for VC-000001" });
    expect(within(report).getAllByText(REPORT_LABEL)).toHaveLength(2);
    expect(report).toHaveTextContent("2026-10-19");
    expect(report).toHaveTextContent(PHASE_2_17C_NO_REPLY.transactions[5]!.hash);
    expect(report).toHaveTextContent(/not signed and is not an official record/);
    expect(screen.getByRole("button", { name: "Print or save as PDF" })).toBeInTheDocument();
    expectNeutral(report.textContent ?? "");
  });

  it("download is refused gracefully where Blob URLs are unavailable", async () => {
    const g = gw();
    const original = URL.createObjectURL;
    // jsdom has no createObjectURL.
    (URL as { createObjectURL?: unknown }).createObjectURL = undefined;
    render(<CaseReport caseId="VC-000001" contract={CONTRACT} loadGateway={g.loadGateway} sha256Hex={nodeSha256Hex} storage={null} />);
    await userEvent.click(await screen.findByRole("button", { name: "Download report (.html)" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/use Print instead/);
    (URL as { createObjectURL?: unknown }).createObjectURL = original;
  });

  it("the downloaded report is a standalone page with the report markup", async () => {
    const g = gw();
    let blob: Blob | null = null;
    const original = URL.createObjectURL;
    URL.createObjectURL = (b: Blob) => ((blob = b), "blob:test");
    URL.revokeObjectURL = () => undefined;
    render(<CaseReport caseId="VC-000001" contract={CONTRACT} loadGateway={g.loadGateway} sha256Hex={nodeSha256Hex} storage={null} />);
    await userEvent.click(await screen.findByRole("button", { name: "Download report (.html)" }));
    await waitFor(() => expect(blob).not.toBeNull());
    const html = await (blob as unknown as Blob).text();
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain(REPORT_LABEL);
    expect(html).not.toMatch(/<script/i);
    URL.createObjectURL = original;
  });
});

describe("mandatory copy is available where submissions happen", () => {
  it("the exact 'Before you submit' body is exported unchanged", () => {
    expect(BEFORE_YOU_SUBMIT_BODY).toMatch(/^Information written to a public blockchain may be visible and permanent\./);
  });
});
