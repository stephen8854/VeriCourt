/**
 * Phase 4.2–4.5 workspace UI (experiment build only): the create-case wizard
 * end to end through the REAL genlayer-js write client against in-memory
 * fakes, and the case-level forms up to their review screens.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetContractCheckCache } from "../cases/caseReads";
import { BEFORE_YOU_SUBMIT_BODY, EXTERNAL_LINKS_CAN_CHANGE } from "../contract/copy";
import type { CaseView } from "../contract/types";
import { recordedNoReplyCaseReads } from "../live/expected";
import type { HashVariant, ReadMethod } from "../live/gateway";
import { ENABLED_GATE, fakeStudio, makeDeps } from "../test/experimentHarness";
import { fakeGateway, nodeSha256Hex } from "../test/fakeGateway";
import { SENDER, TX_HASH, eventfulWallet, fakeStorage } from "../test/writeHarness";
import { WalletProvider, useWallet } from "../wallet/WalletContext";
import type { CreateCaseInput } from "../write/createCase";
import { DurableWriteSession } from "../write/durableSession";
import { PendingStore } from "../write/pendingStore";
import { memoryLock } from "../write/writeLock";
import { ExperimentWritePanel } from "./ExperimentWritePanel";

const RESPONDENT = `0x${"99".repeat(20)}`;
const RECORDED = recordedNoReplyCaseReads().get_case as CaseView;
const INFO = { schema_version: "vericourt-case-v1", case_count: 3, statuses: [], categories: [], evidence_types: [], limits: {}, assessment: { schema_version: "vericourt-assessment-v2" } };

beforeEach(() => {
  resetContractCheckCache();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

function ConnectButton() {
  const { connect } = useWallet();
  return (
    <button type="button" onClick={connect}>
      test-connect
    </button>
  );
}

function setup(query: Record<string, string>, readCase?: (m: ReadMethod, v: HashVariant) => Promise<unknown> | undefined) {
  const studio = fakeStudio();
  let sentInput: CreateCaseInput | null = null;
  const wallet = eventfulWallet({
    send: () => {
      if (sentInput !== null) studio.accept(sentInput);
      return { result: TX_HASH };
    },
  });
  const storage = fakeStorage();
  const lock = memoryLock();
  const g = fakeGateway({
    overrideRead: (m, v) => readCase?.(m, v) ?? (m === "get_contract_info" ? Promise.resolve(INFO) : m === "get_case_count" ? Promise.resolve(3) : undefined),
  });
  render(
    <WalletProvider provider={wallet}>
      <ConnectButton />
      <ExperimentWritePanel
        gate={ENABLED_GATE}
        query={query}
        openSession={() => DurableWriteSession.open(new PendingStore(storage), lock)}
        createDeps={async (session) => makeDeps(session, wallet, studio).deps}
        readDeps={{ loadGateway: async () => g.gateway, sha256Hex: nodeSha256Hex }}
      />
    </WalletProvider>,
  );
  return { studio, wallet, setSent: (i: CreateCaseInput) => (sentInput = i) };
}

describe("create-case wizard", () => {
  it("validates each step, reviews the exact values with the mandatory warning, then one request to a verified case", async () => {
    const user = userEvent.setup({ delay: null });
    const h = setup({ action: "create_case" });
    await user.click(await screen.findByRole("button", { name: "test-connect" }));

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("alert")).toHaveTextContent("title must be at least 5 characters");
    await user.click(screen.getByRole("radio", { name: "Design / branding" }));
    await user.type(screen.getByRole("textbox", { name: /Title/ }), "FICTIONAL logo package missing formats");
    await user.click(screen.getByRole("button", { name: "Next" }));

    await user.type(screen.getByRole("textbox", { name: /Agreement summary/ }), "FICTIONAL: three concepts, SVG and PNG.");
    await user.type(screen.getByRole("textbox", { name: /Expected deliverable/ }), "FICTIONAL: final logo files by 1 October.");
    await user.click(screen.getByRole("button", { name: "Next" }));

    await user.type(screen.getByRole("textbox", { name: /^Claim/ }), "FICTIONAL: only PNG was delivered.");
    await user.type(screen.getByRole("textbox", { name: /Requested remedy/ }), "FICTIONAL: deliver the SVG files.");
    await user.type(screen.getByRole("textbox", { name: "Issue I1" }), "FICTIONAL: SVG files were not delivered");
    await user.click(screen.getByRole("button", { name: "Add an issue" }));
    await user.type(screen.getByRole("textbox", { name: "Issue I2" }), "fictional:  SVG files were NOT delivered");
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("alert")).toHaveTextContent("duplicate issue description");
    await user.click(screen.getByRole("button", { name: "Remove issue I2" }));
    await user.click(screen.getByRole("button", { name: "Next" }));

    await user.type(screen.getByRole("textbox", { name: /Respondent's wallet address/ }), SENDER);
    await user.click(screen.getByRole("button", { name: "Review the transaction" }));
    expect(screen.getByRole("alert")).toHaveTextContent("claimant and respondent must be different addresses");
    await user.clear(screen.getByRole("textbox", { name: /Respondent's wallet address/ }));
    await user.type(screen.getByRole("textbox", { name: /Respondent's wallet address/ }), RESPONDENT);
    await user.click(screen.getByRole("button", { name: "Review the transaction" }));

    const details = screen.getByLabelText("Case details");
    expect(within(details).getByText("DESIGN")).toBeInTheDocument();
    expect(within(details).getByText("72 hours", { exact: false })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Before you submit" })).toHaveTextContent(BEFORE_YOU_SUBMIT_BODY);

    h.setSent({
      respondent: RESPONDENT,
      category: "DESIGN",
      title: "FICTIONAL logo package missing formats",
      agreementSummary: "",
      expectedDeliverable: "",
      claim: "",
      requestedRemedy: "",
      issues: [],
      replyWindowSeconds: 72 * 3600,
    });
    await user.click(screen.getByRole("checkbox", { name: /cannot be deleted/ }));
    await user.click(screen.getByRole("button", { name: "Sign in wallet" }));
    expect(await screen.findByRole("region", { name: "Case created and confirmed" })).toHaveTextContent(TX_HASH);
    expect(h.wallet.sends).toHaveLength(1);
    expect(screen.getByRole("link", { name: /Open case VC-\d{6}/ })).toBeInTheDocument();
  }, 30_000);

  it("Back on the review returns to the form with the draft kept", async () => {
    const user = userEvent.setup({ delay: null });
    setup({ action: "create_case" });
    await user.type(await screen.findByRole("textbox", { name: /Title/ }), "FICTIONAL title kept");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("textbox", { name: /Title/ })).toHaveValue("FICTIONAL title kept");
  });
});

/** A fresh case where the harness sender is the claimant, the window is open, nothing submitted yet. */
function openCase(over: Partial<CaseView> = {}): CaseView {
  const created = Math.floor(Date.now() / 1000) - 60;
  return {
    ...RECORDED,
    claimant: SENDER,
    status: "AWAITING_RESPONSE",
    response_state: "PENDING",
    snapshot_locked: false,
    locked_at: 0,
    lock_reason: "",
    locked_evidence_count: 0,
    snapshot_digest: "",
    evidence_count: 0,
    claimant_evidence_count: 0,
    respondent_evidence_count: 0,
    history_count: 1,
    assessment_attempts: 0,
    last_assessment_error: "",
    created_at: created,
    reply_window_seconds: 7200,
    reply_deadline: created + 7200,
    ...over,
  };
}

function caseReads(c: CaseView, status: Record<string, unknown> = {}) {
  return (m: ReadMethod) => {
    if (m === "get_case") return Promise.resolve(c);
    if (m === "get_case_evidence") return Promise.resolve([]);
    if (m === "get_case_history") return Promise.resolve([{ seq: 1, action: "CASE_CREATED", actor: c.claimant, at: c.created_at, detail: "" }]);
    if (m === "get_assessment") return Promise.resolve({ exists: false, case_id: c.case_id, status: c.status, attempts: c.assessment_attempts, schema_version: "vericourt-assessment-v2" });
    if (m === "get_assessment_status") {
      const ready = c.status === "READY_FOR_ASSESSMENT";
      return Promise.resolve({ case_id: c.case_id, status: c.status, has_assessment: false, attempts: c.assessment_attempts, max_attempts: 2, remaining_attempts: ready ? 2 - c.assessment_attempts : 0, can_request: ready, last_error: "", schema_version: "vericourt-assessment-v2", ...status });
    }
    return undefined;
  };
}

describe("case-level forms", () => {
  it("evidence: validated, then reviewed with the mandatory and link warnings", async () => {
    const user = userEvent.setup({ delay: null });
    setup({ action: "submit_evidence", case: "VC-000001" }, caseReads(openCase()));
    await user.click(await screen.findByRole("button", { name: "test-connect" }));
    const form = await screen.findByRole("heading", { name: "Submit evidence to VC-000001" });
    expect(form).toBeInTheDocument();
    expect(screen.getAllByText(BEFORE_YOU_SUBMIT_BODY).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Review the transaction" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/label is required/);
    await user.type(screen.getByRole("textbox", { name: /^Label/ }), "FICTIONAL delivered files");
    await user.type(screen.getByRole("textbox", { name: /^Description/ }), "FICTIONAL: the delivery email.");
    await user.type(screen.getByRole("textbox", { name: /^Link/ }), "javascript:alert(1)");
    await user.click(screen.getByRole("checkbox", { name: /I1/ }));
    await user.click(screen.getByRole("button", { name: "Review the transaction" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/link must be an http\(s\) URL/);
    await user.clear(screen.getByRole("textbox", { name: /^Link/ }));
    await user.type(screen.getByRole("textbox", { name: /^Link/ }), "https://example.org/fictional");
    await user.click(screen.getByRole("button", { name: "Review the transaction" }));

    const rows = screen.getByLabelText("Evidence that will be written");
    expect(within(rows).getByText("https://example.org/fictional")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Before you submit" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "What the contract does with evidence" })).toHaveTextContent(EXTERNAL_LINKS_CAN_CHANGE);
    expect(screen.getByText("submit_evidence")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to the form" }));
    expect(screen.getByRole("heading", { name: "Submit evidence to VC-000001" })).toBeInTheDocument();
  }, 30_000);

  it("reply: only offered to the respondent, with the lock warning", async () => {
    const user = userEvent.setup({ delay: null });
    setup({ action: "submit_reply", case: "VC-000001" }, caseReads(openCase()));
    await user.click(await screen.findByRole("button", { name: "test-connect" }));
    expect(await screen.findByText(/Only the respondent can reply/)).toBeInTheDocument();
  });

  it("missed deadline: not offered before the deadline", async () => {
    const user = userEvent.setup({ delay: null });
    setup({ action: "process_reply_deadline", case: "VC-000001" }, caseReads(openCase()));
    await user.click(await screen.findByRole("button", { name: "test-connect" }));
    expect(await screen.findByText(/Available from 10 minutes after the reply deadline/)).toBeInTheDocument();
  });

  it("assessment: the last attempt needs its own confirmation before the final button enables", async () => {
    const user = userEvent.setup({ delay: null });
    const ready = openCase({ status: "READY_FOR_ASSESSMENT", response_state: "NO_RESPONSE_BY_DEADLINE", snapshot_locked: true, locked_at: 1, lock_reason: "REPLY_WINDOW_EXPIRED", snapshot_digest: "ab".repeat(32), assessment_attempts: 1, last_assessment_error: "INVALID_MODEL_OUTPUT", history_count: 1 });
    setup({ action: "request_assessment", case: "VC-000001" }, caseReads(ready, { last_error: "INVALID_MODEL_OUTPUT" }));
    await user.click(await screen.findByRole("button", { name: "test-connect" }));
    await user.click(await screen.findByRole("button", { name: "Review the transaction" }));
    expect(screen.getByRole("region", { name: "What an assessment request does" })).toHaveTextContent(/Never send this request twice/);
    await user.click(screen.getByRole("checkbox", { name: /cannot be withdrawn/ }));
    expect(screen.getByRole("button", { name: "Sign in wallet" })).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /last allowed attempt/ }));
    expect(screen.getByRole("button", { name: "Sign in wallet" })).toBeEnabled();
  });

  it("a case with non-final changes offers no write", async () => {
    const user = userEvent.setup({ delay: null });
    const c = openCase();
    setup({ action: "submit_evidence", case: "VC-000001" }, (m, v) => (m === "get_case" && v === "latest-nonfinal" ? Promise.resolve({ ...c, history_count: 2 }) : caseReads(c)(m)));
    await user.click(await screen.findByRole("button", { name: "test-connect" }));
    expect(await screen.findByRole("region", { name: "Not available on this case right now" })).toHaveTextContent(/not final yet/);
  });
});
