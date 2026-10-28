import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { WRITES_DISABLED_REASON } from "../config/network";
import { MOCK_ACCOUNT as A, MOCK_ACCOUNT_2 as B, mockProvider, type MockProvider } from "../test/mockProvider";
import { ALLOWED_WALLET_METHODS } from "../wallet/eip1193";
import { WalletProvider } from "../wallet/WalletContext";
import { WalletDiagnostics } from "./WalletDiagnostics";

const EVENTS = ["accountsChanged", "chainChanged", "disconnect"];
let current: MockProvider | null = null;

function renderWith(provider: MockProvider | null) {
  current = provider;
  return render(
    <WalletProvider provider={provider}>
      <WalletDiagnostics />
    </WalletProvider>,
  );
}

/** The wallet panel is the first level-3 heading on the page. */
const status = () => screen.getAllByRole("heading", { level: 3 })[0]?.textContent;

afterEach(() => {
  // Every test: only the three permitted wallet methods were ever called.
  for (const m of current?.methods() ?? []) expect(ALLOWED_WALLET_METHODS).toContain(m);
  current = null;
});

describe("wallet page states (mocked EIP-1193 providers, no real wallet)", () => {
  it("no provider", () => {
    renderWith(null);
    expect(screen.getByRole("status")).toHaveTextContent(/No injected EIP-1193 wallet/);
    expect(screen.queryByRole("button", { name: "Connect wallet" })).toBeNull();
  });

  it("initial load makes only a passive read: no prompt", async () => {
    const p = mockProvider("0xf22f", []);
    renderWith(p);
    await waitFor(() => expect(status()).toBe("Wallet detected, not connected"));
    expect(p.methods()).toEqual(["eth_chainId", "eth_accounts"]);
    expect(p.methods()).not.toContain("eth_requestAccounts");
    expect(screen.getByRole("button", { name: "Connect wallet" })).toBeEnabled();
  });

  it("explicit connection on StudioNet shows a short address and the full one on request", async () => {
    const p = mockProvider("0xf22f", []);
    renderWith(p);
    await waitFor(() => expect(status()).toBe("Wallet detected, not connected"));
    await userEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
    await waitFor(() => expect(status()).toBe("Connected to StudioNet"));
    expect(p.methods()).toContain("eth_requestAccounts");
    expect(screen.getByText("0x1a1a…1a1a")).toHaveAttribute("title", A);
    expect(screen.getByText("Matches StudioNet")).toBeInTheDocument();
    await userEvent.click(screen.getByText("Full address"));
    expect(screen.getAllByText(A).length).toBeGreaterThan(0);
  });

  it("user rejection", async () => {
    renderWith(mockProvider("0xf22f", [], { errors: { eth_requestAccounts: { code: 4001, message: "User rejected" } } }));
    await waitFor(() => expect(status()).toBe("Wallet detected, not connected"));
    await userEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
    await waitFor(() => expect(status()).toBe("Connection declined"));
    expect(screen.getByRole("alert")).toHaveTextContent(/declined the request/);
  });

  it("wrong chain: explains the mismatch with both ids and never switches", async () => {
    const p = mockProvider("0x1", [A]);
    renderWith(p);
    await waitFor(() => expect(status()).toBe("Connected, wrong network"));
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/reports chain ID 1, but VeriCourt uses GenLayer Studio Network, chain ID 61999/);
    expect(alert).toHaveTextContent(/will not switch or add networks for you/);
    expect(p.methods()).not.toContain("wallet_switchEthereumChain");
    expect(p.methods()).not.toContain("wallet_addEthereumChain");
  });

  it.each([
    ["malformed account", () => mockProvider("0xf22f", ["0x123"]), /malformed account list/],
    ["malformed chain id", () => mockProvider("61999", [A]), /malformed chain ID/],
    ["numeric chain id", () => mockProvider(61999, [A]), /malformed chain ID/],
    ["provider error", () => mockProvider("0xf22f", [], { errors: { eth_chainId: new Error("Provider unavailable") } }), /Provider unavailable/],
  ])("%s → wallet problem, nothing displayed as an account", async (_n, make, message) => {
    renderWith(make());
    await waitFor(() => expect(status()).toBe("Wallet problem"));
    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(screen.getByText("None shared with VeriCourt")).toBeInTheDocument();
  });

  it("account change event updates the account and notes the change", async () => {
    const p = mockProvider("0xf22f", [A]);
    renderWith(p);
    await waitFor(() => expect(status()).toBe("Connected to StudioNet"));
    act(() => p.emit("accountsChanged", [B]));
    expect(screen.getByText("0x2b2b…2b2b")).toBeInTheDocument();
    expect(screen.getByText(/active account changed/)).toBeInTheDocument();
    expect(p.methods()).not.toContain("eth_requestAccounts");
  });

  it("chain change event marks the wallet incompatible immediately and re-reads the chain", async () => {
    const p = mockProvider("0xf22f", [A]);
    renderWith(p);
    await waitFor(() => expect(status()).toBe("Connected to StudioNet"));
    p.config.chainId = "0x1";
    act(() => p.emit("chainChanged", "0x1"));
    expect(status()).toBe("Connected, wrong network");
    await waitFor(() => expect(p.methods().filter((m) => m === "eth_chainId")).toHaveLength(2));
    expect(screen.getByText(/network changed/)).toBeInTheDocument();
  });

  it("empty account list after connection: disconnected", async () => {
    const p = mockProvider("0xf22f", [A]);
    renderWith(p);
    await waitFor(() => expect(status()).toBe("Connected to StudioNet"));
    act(() => p.emit("accountsChanged", []));
    expect(status()).toBe("Wallet disconnected");
    expect(screen.getByText("None shared with VeriCourt")).toBeInTheDocument();
  });

  it("“stop showing” is described honestly and only clears the app's display", async () => {
    const p = mockProvider("0xf22f", [A]);
    renderWith(p);
    await waitFor(() => expect(status()).toBe("Connected to StudioNet"));
    expect(screen.getByText(/VeriCourt cannot revoke your wallet's permission/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Stop showing this account" }));
    expect(status()).toBe("Wallet detected, not connected");
    act(() => p.emit("accountsChanged", [B]));
    expect(screen.getByText("None shared with VeriCourt")).toBeInTheDocument();
  });

  it("providers without events are reported", async () => {
    const p = mockProvider("0xf22f", []);
    const noEvents = { request: p.request };
    current = p;
    render(
      <WalletProvider provider={noEvents}>
        <WalletDiagnostics />
      </WalletProvider>,
    );
    expect(await screen.findByText(/does not report account or network changes/)).toBeInTheDocument();
  });

  it("listeners are registered once (even under StrictMode) and removed on unmount", async () => {
    const p = mockProvider("0xf22f", []);
    current = p;
    const view = render(
      <StrictMode>
        <WalletProvider provider={p}>
          <WalletDiagnostics />
        </WalletProvider>
      </StrictMode>,
    );
    await waitFor(() => expect(status()).toBe("Wallet detected, not connected"));
    for (const e of EVENTS) expect(p.listenerCount(e)).toBe(1);
    view.unmount();
    for (const e of EVENTS) expect(p.listenerCount(e)).toBe(0);
    expect(p.methods()).not.toContain("eth_requestAccounts");
  });

  it("states that writes are disabled and why", async () => {
    renderWith(mockProvider("0xf22f", [A]));
    expect(await screen.findByText(WRITES_DISABLED_REASON)).toBeInTheDocument();
  });
});
