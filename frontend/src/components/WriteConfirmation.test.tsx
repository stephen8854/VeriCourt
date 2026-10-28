import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WRITES_DISABLED_REASON } from "../config/network";
import { mockProvider, MOCK_ACCOUNT } from "../test/mockProvider";
import { WalletProvider } from "../wallet/WalletContext";
import { PENDING_KEY } from "../write/pendingStore";
import type { CreateCaseInput } from "../write/createCase";
import { WritePreview } from "../pages/WritePreview";
import { WriteConfirmation, confirmationBlockers, type WriteConfirmationProps } from "./WriteConfirmation";

const CONTRACT = "0x3258A80A86920792354A9b7e59D5Ed2409E96220";
const INPUT: CreateCaseInput = {
  respondent: `0x${"2b".repeat(20)}`,
  category: "DESIGN",
  title: "FICTIONAL - logo files",
  agreementSummary: "FICTIONAL summary\nsecond line",
  expectedDeliverable: "FICTIONAL deliverable",
  claim: "<img src=x onerror=alert(1)> FICTIONAL claim",
  requestedRemedy: "FICTIONAL remedy",
  issues: ["FICTIONAL issue A", "FICTIONAL issue B"],
  replyWindowSeconds: 48 * 3600,
};

function renderReady(overrides: Partial<WriteConfirmationProps> = {}) {
  const onConfirm = vi.fn();
  const props: WriteConfirmationProps = {
    account: MOCK_ACCOUNT,
    walletChainId: 61999,
    contract: CONTRACT,
    input: INPUT,
    blockedReason: null,
    onConfirm,
    ...overrides,
  };
  render(<WriteConfirmation {...props} />);
  return { onConfirm, button: () => screen.getByRole("button", { name: /sign in wallet|request sent/i }) };
}

describe("WriteConfirmation content", () => {
  it("shows the network and chain ID, account, contract and function", () => {
    renderReady();
    expect(screen.getByText(/GenLayer Studio Network \(StudioNet\), chain ID/)).toHaveTextContent("61999");
    expect(screen.getByText(MOCK_ACCOUNT)).toBeInTheDocument();
    expect(screen.getByText(CONTRACT)).toBeInTheDocument();
    expect(screen.getByText("create_case")).toBeInTheDocument();
    expect(screen.getByText("Wallet is on StudioNet")).toBeInTheDocument();
  });

  it("shows every case field, in contract order, with issues numbered", () => {
    renderReady();
    const details = screen.getByLabelText("Case details");
    const labels = within(details).getAllByRole("term").map((t) => t.textContent);
    expect(labels).toEqual([
      "Respondent (other party)", "Category", "Title", "Agreement summary", "Expected deliverable", "Claim",
      "Requested remedy", "Issues", "Reply window",
    ]);
    expect(within(details).getByText(INPUT.respondent)).toBeInTheDocument();
    expect(within(details).getByText("DESIGN")).toBeInTheDocument();
    expect(within(details).getByText("48 hours", { exact: false })).toBeInTheDocument();
    const items = within(details).getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual(["I1 FICTIONAL issue A", "I2 FICTIONAL issue B"]);
    expect(within(details).getByText(/Advisory only/)).toBeInTheDocument();
  });

  it("renders user text as text, never as HTML", () => {
    renderReady();
    expect(screen.getByText(INPUT.claim)).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
  });

  it("warns that a case is created on chain, and that data may be public and permanent", () => {
    renderReady();
    expect(screen.getByRole("region", { name: "This creates a case on chain" })).toHaveTextContent(/creates a new case on chain/);
    expect(screen.getByRole("region", { name: "Privacy: public and permanent" })).toHaveTextContent(/may be publicly visible and cannot be deleted/);
  });

  it("uses no forbidden adjudication words", () => {
    renderReady();
    expect(document.body.textContent).not.toMatch(/verdict|winner|loser|ruling|judgment/i);
  });
});

describe("WriteConfirmation final action", () => {
  it("is disabled until the user acknowledges, then calls onConfirm exactly once (double click)", async () => {
    const user = userEvent.setup();
    const { onConfirm, button } = renderReady();
    expect(button()).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /cannot be deleted/ }));
    expect(button()).toBeEnabled();
    await user.dblClick(button());
    await user.click(button());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(button()).toBeDisabled();
    expect(button()).toHaveTextContent("Request sent to your wallet");
  });

  it.each<[string, Partial<WriteConfirmationProps>, RegExp]>([
    ["writes are disabled", { blockedReason: WRITES_DISABLED_REASON }, /Contract writes are disabled/],
    ["an earlier write is unresolved", { blockedReason: "Writes are blocked: an earlier write is unresolved." }, /unresolved/],
    ["no account", { account: null }, /No wallet account is connected/],
    ["the wrong chain", { walletChainId: 1 }, /not on StudioNet.*reports 1/],
    ["an unknown chain", { walletChainId: null }, /not on StudioNet/],
    ["no contract", { contract: null }, /No VeriCourt contract/],
    ["invalid case details", { input: { ...INPUT, title: "abc" } }, /Case details: title must be at least 5/],
    ["respondent = account", { input: { ...INPUT, respondent: MOCK_ACCOUNT } }, /different addresses/],
  ])("stays disabled when %s, and says why", async (_name, overrides, reason) => {
    const user = userEvent.setup();
    const { onConfirm, button } = renderReady(overrides);
    await user.click(screen.getByRole("checkbox", { name: /cannot be deleted/ }));
    expect(button()).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(reason);
    await user.click(button());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("confirmationBlockers is empty only when everything holds", () => {
    const ok = { account: MOCK_ACCOUNT, walletChainId: 61999, contract: CONTRACT, input: INPUT, blockedReason: null };
    expect(confirmationBlockers(ok)).toEqual([]);
    expect(confirmationBlockers({ ...ok, walletChainId: 61998 })).toHaveLength(1);
  });
});

describe("WritePreview page (not wired to submission)", () => {
  it("keeps the final action disabled with the writes-disabled reason, and never calls a send method", async () => {
    const user = userEvent.setup();
    const provider = mockProvider("0xf22f", [MOCK_ACCOUNT]);
    render(
      <WalletProvider provider={provider}>
        <WritePreview />
      </WalletProvider>,
    );
    await screen.findByText(MOCK_ACCOUNT);
    await user.click(screen.getByRole("checkbox", { name: /cannot be deleted/ }));
    expect(screen.getByRole("button", { name: "Sign in wallet" })).toBeDisabled();
    expect(screen.getAllByText(/Contract writes are disabled/).length).toBeGreaterThan(0);
    expect(provider.methods().every((m) => m === "eth_chainId" || m === "eth_accounts")).toBe(true);
  });

  it("shows the persistent write-safety status from this browser", () => {
    window.localStorage.setItem(PENDING_KEY, "{corrupt");
    render(
      <WalletProvider provider={null}>
        <WritePreview />
      </WalletProvider>,
    );
    expect(screen.getByRole("region", { name: "Write-safety status in this browser" })).toHaveTextContent(/cannot be read/);
    window.localStorage.removeItem(PENDING_KEY);
  });
});
